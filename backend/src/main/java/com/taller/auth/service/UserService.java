package com.taller.auth.service;

import java.util.List;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.taller.auth.exception.AppException;
import com.taller.auth.exception.DataUnavailableException;
import com.taller.auth.exception.InvalidCurrentPasswordException;
import com.taller.auth.exception.LastAdminException;
import com.taller.auth.exception.UserAlreadyExistsException;
import com.taller.auth.exception.UserNotFoundException;
import com.taller.auth.model.Role;
import com.taller.auth.model.User;
import com.taller.auth.repository.UserRepository;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;

/**
 * Casos de uso de gestion de usuarios.
 *
 * El alta de usuarios NO esta aqui: la hace AuthService.register(), porque el
 * registro publico es parte del flujo de autenticacion y siempre crea rol
 * USER. Este servicio cubre consulta, edicion, cambio de clave, cambio de rol
 * y borrado logico.
 *
 * Nunca usa los metodos heredados de JpaRepository (findAll, findById): esos
 * no filtran por active y devolverian usuarios dados de baja. Solo se usan las
 * consultas explicitas ...ActiveTrue.
 */
@Service
public class UserService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    public UserService(UserRepository userRepository, PasswordEncoder passwordEncoder) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @CircuitBreaker(name = "dataTier", fallbackMethod = "listFallback")
    @Transactional(readOnly = true)
    public Page<User> list(Pageable pageable) {
        return userRepository.findAllByActiveTrue(pageable);
    }

    @SuppressWarnings("unused")
    private Page<User> listFallback(Pageable pageable, Throwable t) {
        return failOrDegrade(t);
    }

    @CircuitBreaker(name = "dataTier", fallbackMethod = "findActiveByIdFallback")
    @Transactional(readOnly = true)
    public User findActiveById(Long id) {
        return requireActive(id);
    }

    @SuppressWarnings("unused")
    private User findActiveByIdFallback(Long id, Throwable t) {
        return failOrDegrade(t);
    }

    /**
     * Cambio de username.
     *
     * Cambiar el username NO invalida las sesiones vigentes: el subject del
     * JWT es el id del usuario, no su nombre (ADR-002). Antes de esa decision
     * esta operacion habria dejado al usuario deslogueado hasta el siguiente
     * refresh.
     */
    @CircuitBreaker(name = "dataTier", fallbackMethod = "updateUsernameFallback")
    @Transactional
    public User updateUsername(Long id, String newUsername) {
        User user = requireActive(id);

        // Feedback rapido para el caso normal. NO es la garantia: entre este
        // chequeo y el UPDATE otra transaccion puede tomar el mismo username,
        // y quien lo impide de verdad es la constraint uq_users_username.
        if (userRepository.existsByUsernameAndIdNot(newUsername, id)) {
            throw new UserAlreadyExistsException();
        }
        user.setUsername(newUsername);
        return save(user);
    }

    @SuppressWarnings("unused")
    private User updateUsernameFallback(Long id, String newUsername, Throwable t) {
        return failOrDegrade(t);
    }

    /**
     * Cambio de contrasena propia, exigiendo la vigente.
     *
     * El usuario ya esta autenticado, asi que pedir la clave actual puede
     * parecer redundante. No lo es: acota el dano de un token robado. Con la
     * sesion secuestrada un atacante puede leer y editar el perfil, pero no
     * puede quedarse con la cuenta de forma permanente.
     */
    @CircuitBreaker(name = "dataTier", fallbackMethod = "changePasswordFallback")
    @Transactional
    public void changePassword(Long id, String currentPassword, String newPassword) {
        User user = requireActive(id);

        if (!passwordEncoder.matches(currentPassword, user.getPasswordHash())) {
            throw new InvalidCurrentPasswordException();
        }
        user.setPasswordHash(passwordEncoder.encode(newPassword));
        save(user);
    }

    @SuppressWarnings("unused")
    private void changePasswordFallback(Long id, String currentPassword, String newPassword, Throwable t) {
        failOrDegrade(t);
    }

    /**
     * Cambio de rol. Solo un ADMIN llega hasta aqui (ver UserController).
     *
     * Degradar al ultimo ADMIN a USER dejaria el sistema sin administradores,
     * asi que pasa por el mismo interlock que la baja.
     */
    @CircuitBreaker(name = "dataTier", fallbackMethod = "changeRoleFallback")
    @Transactional
    public User changeRole(Long id, Role newRole) {
        User user = requireActive(id);

        if (user.getRole() == Role.ADMIN && newRole == Role.USER) {
            guardLastAdmin(user.getId());
        }
        user.setRole(newRole);
        return save(user);
    }

    @SuppressWarnings("unused")
    private User changeRoleFallback(Long id, Role newRole, Throwable t) {
        return failOrDegrade(t);
    }

    /**
     * Borrado logico. Dar de baja al ultimo ADMIN pasa por el interlock.
     */
    @CircuitBreaker(name = "dataTier", fallbackMethod = "deactivateFallback")
    @Transactional
    public void deactivate(Long id) {
        User user = requireActive(id);

        if (user.getRole() == Role.ADMIN) {
            guardLastAdmin(user.getId());
        }
        user.deactivate();
        save(user);
    }

    @SuppressWarnings("unused")
    private void deactivateFallback(Long id, Throwable t) {
        failOrDegrade(t);
    }

    /**
     * INTERLOCK DEL ULTIMO ADMIN (tactica Interlock, Cap. 10).
     *
     * Invariante: el sistema nunca queda con cero administradores activos. Si
     * se violara, no habria salida por la interfaz — solo un ADMIN puede
     * asignar el rol ADMIN, asi que recuperarlo exigiria editar la base a mano.
     *
     * POR QUE UN COUNT NO BASTA. Con el aislamiento por defecto
     * (READ_COMMITTED), dos transacciones que dan de baja a dos admins
     * distintos leerian ambas "hay 2 admins", ambas concluirian que pueden
     * proceder, y el sistema terminaria en 0. Es la condicion de carrera del
     * Cap. 9: dos decisiones correctas por separado, incorrectas juntas.
     *
     * COMO SE RESUELVE. findActiveByRoleForUpdate ejecuta un
     * SELECT ... FOR UPDATE (PESSIMISTIC_WRITE) que bloquea las filas de todos
     * los admins activos. La segunda transaccion se queda esperando en esa
     * linea; cuando la primera confirma, la segunda vuelve a leer y ya ve un
     * solo admin, asi que se rechaza.
     *
     * POR QUE EL BLOQUEO DE FILAS ES SUFICIENTE. Un SELECT FOR UPDATE no
     * impide inserciones fantasma, pero aqui no hacen falta: un INSERT solo
     * puede AGREGAR administradores, nunca reducirlos a cero. El unico caso
     * peligroso es la modificacion concurrente de filas que ya existen, y eso
     * si lo cubre el bloqueo.
     *
     * Todo esto ocurre dentro de la @Transactional del metodo que llama: el
     * bloqueo se libera al confirmar, no antes.
     *
     * @param idQueSale id del admin que esta a punto de perder el rol o de ser
     *                  dado de baja; se excluye del conteo porque, para cuando
     *                  la operacion termine, ya no contara como administrador.
     */
    private void guardLastAdmin(Long idQueSale) {
        List<User> adminsActivos = userRepository.findActiveByRoleForUpdate(Role.ADMIN);

        boolean quedaOtroAdmin = adminsActivos.stream()
                .anyMatch(admin -> !admin.getId().equals(idQueSale));

        if (!quedaOtroAdmin) {
            throw new LastAdminException();
        }
    }

    private User requireActive(Long id) {
        return userRepository.findByIdAndActiveTrue(id)
                .orElseThrow(() -> new UserNotFoundException(id));
    }

    /**
     * saveAndFlush y no save: con save(), el UPDATE se posterga hasta el
     * commit, que ocurre FUERA de este try, y una violacion de constraint
     * escaparia como 500 en vez de traducirse.
     */
    private User save(User user) {
        try {
            return userRepository.saveAndFlush(user);
        } catch (DataIntegrityViolationException e) {
            // la carrera por el username la gana la constraint de la base,
            // no el chequeo en memoria de updateUsername().
            throw new UserAlreadyExistsException();
        }
    }

    /**
     * Resilience4j manda al fallback CUALQUIER excepcion, no solo las fallas
     * de infraestructura. Un AppException -usuario no encontrado, ultimo
     * admin, clave actual incorrecta- es EXPECTED y debe propagarse tal cual:
     * si se disfrazara de 503, un intento legitimo de dar de baja al ultimo
     * admin contaria como caida del tier de datos.
     */
    private static <T> T failOrDegrade(Throwable t) {
        if (t instanceof AppException appException) {
            throw appException;
        }
        throw new DataUnavailableException(t);
    }
}
