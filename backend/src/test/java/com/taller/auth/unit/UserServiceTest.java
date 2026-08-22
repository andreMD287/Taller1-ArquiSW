package com.taller.auth.unit;

import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import com.taller.auth.exception.InvalidCurrentPasswordException;
import com.taller.auth.exception.LastAdminException;
import com.taller.auth.exception.UserAlreadyExistsException;
import com.taller.auth.exception.UserNotFoundException;
import com.taller.auth.model.Role;
import com.taller.auth.model.User;
import com.taller.auth.repository.UserRepository;
import com.taller.auth.service.UserService;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class UserServiceTest {

    private static final Pageable PAGINA = PageRequest.of(0, 20);

    @Mock
    private UserRepository userRepository;

    private PasswordEncoder passwordEncoder;
    private UserService userService;

    @BeforeEach
    void setUp() {
        passwordEncoder = new BCryptPasswordEncoder();
        userService = new UserService(userRepository, passwordEncoder);
    }

    // ---------- perfil ----------

    @Test
    void updateUsernameCambiaElNombre() {
        User user = conId(new User("alice", "hash"), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(user));
        when(userRepository.existsByUsernameAndIdNot("alicia", 1L)).thenReturn(false);
        when(userRepository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        User actualizado = userService.updateUsername(1L, "alicia");

        assertThat(actualizado.getUsername()).isEqualTo("alicia");
    }

    @Test
    void updateUsernameRechazaUnNombreYaTomado() {
        User user = conId(new User("alice", "hash"), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(user));
        when(userRepository.existsByUsernameAndIdNot("bob", 1L)).thenReturn(true);

        assertThatThrownBy(() -> userService.updateUsername(1L, "bob"))
                .isInstanceOf(UserAlreadyExistsException.class);

        verify(userRepository, never()).saveAndFlush(any());
    }

    // La regla no es la garantia: si otra transaccion gana la carrera entre el
    // exists() y el UPDATE, la constraint de la base lanza y se traduce al
    // mismo error de negocio en vez de a un 500.
    @Test
    void unaCarreraPerdidaPorElUsernameSeTraduceAlMismoErrorDeNegocio() {
        User user = conId(new User("alice", "hash"), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(user));
        when(userRepository.existsByUsernameAndIdNot("bob", 1L)).thenReturn(false);
        when(userRepository.saveAndFlush(any()))
                .thenThrow(new DataIntegrityViolationException("uq_users_username"));

        assertThatThrownBy(() -> userService.updateUsername(1L, "bob"))
                .isInstanceOf(UserAlreadyExistsException.class);
    }

    @Test
    void operarSobreUnUsuarioInexistenteOInactivoEs404() {
        when(userRepository.findByIdAndActiveTrue(7L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> userService.updateUsername(7L, "x"))
                .isInstanceOf(UserNotFoundException.class);
    }

    // ---------- contrasena ----------

    @Test
    void changePasswordConLaClaveActualCorrectaLaReemplaza() {
        User user = conId(new User("alice", passwordEncoder.encode("vieja1234")), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(user));
        when(userRepository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        userService.changePassword(1L, "vieja1234", "nueva12345");

        assertThat(passwordEncoder.matches("nueva12345", user.getPasswordHash())).isTrue();
        assertThat(passwordEncoder.matches("vieja1234", user.getPasswordHash())).isFalse();
    }

    @Test
    void changePasswordConLaClaveActualIncorrectaNoCambiaNada() {
        String hashOriginal = passwordEncoder.encode("vieja1234");
        User user = conId(new User("alice", hashOriginal), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(user));

        assertThatThrownBy(() -> userService.changePassword(1L, "equivocada", "nueva12345"))
                .isInstanceOf(InvalidCurrentPasswordException.class);

        assertThat(user.getPasswordHash()).isEqualTo(hashOriginal);
        verify(userRepository, never()).saveAndFlush(any());
    }

    // ---------- interlock del ultimo ADMIN ----------

    @Test
    void darDeBajaAlUltimoAdminActivoEsRechazado() {
        User soloAdmin = conId(admin("root"), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(soloAdmin));
        when(userRepository.findActiveByRoleForUpdate(Role.ADMIN)).thenReturn(List.of(soloAdmin));

        assertThatThrownBy(() -> userService.deactivate(1L))
                .isInstanceOf(LastAdminException.class);

        assertThat(soloAdmin.isActive()).isTrue();
        verify(userRepository, never()).saveAndFlush(any());
    }

    @Test
    void darDeBajaAUnAdminCuandoHayOtroSiSePermite() {
        User admin1 = conId(admin("root"), 1L);
        User admin2 = conId(admin("otra"), 2L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(admin1));
        when(userRepository.findActiveByRoleForUpdate(Role.ADMIN)).thenReturn(List.of(admin1, admin2));
        when(userRepository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        userService.deactivate(1L);

        assertThat(admin1.isActive()).isFalse();
    }

    @Test
    void degradarAlUltimoAdminAUserEsRechazado() {
        User soloAdmin = conId(admin("root"), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(soloAdmin));
        when(userRepository.findActiveByRoleForUpdate(Role.ADMIN)).thenReturn(List.of(soloAdmin));

        assertThatThrownBy(() -> userService.changeRole(1L, Role.USER))
                .isInstanceOf(LastAdminException.class);

        assertThat(soloAdmin.getRole()).isEqualTo(Role.ADMIN);
        verify(userRepository, never()).saveAndFlush(any());
    }

    /**
     * EL TEST QUE DEFINE EL MECANISMO. El interlock no se apoya en un conteo
     * sino en un bloqueo pesimista: findActiveByRoleForUpdate ejecuta un
     * SELECT ... FOR UPDATE. Si alguien lo cambiara por
     * countByRoleAndActiveTrue, dos bajas concurrentes podrian leer ambas
     * "hay 2 admins" y dejar el sistema en 0. Este test cae si eso ocurre.
     */
    @Test
    void elInterlockUsaElBloqueoPesimistaYNoUnConteo() {
        User admin1 = conId(admin("root"), 1L);
        User admin2 = conId(admin("otra"), 2L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(admin1));
        when(userRepository.findActiveByRoleForUpdate(Role.ADMIN)).thenReturn(List.of(admin1, admin2));
        when(userRepository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        userService.deactivate(1L);

        verify(userRepository).findActiveByRoleForUpdate(Role.ADMIN);
        verify(userRepository, never()).countByRoleAndActiveTrue(any());
    }

    // El bloqueo no es gratis: serializa operaciones. Solo debe tomarse
    // cuando la operacion realmente puede reducir el numero de admins.
    @Test
    void darDeBajaAUnUserNoTomaElBloqueo() {
        User user = conId(new User("alice", "hash"), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(user));
        when(userRepository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        userService.deactivate(1L);

        assertThat(user.isActive()).isFalse();
        verify(userRepository, never()).findActiveByRoleForUpdate(any());
    }

    @Test
    void promoverUnUserAAdminNoTomaElBloqueo() {
        User user = conId(new User("alice", "hash"), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(user));
        when(userRepository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        User promovido = userService.changeRole(1L, Role.ADMIN);

        assertThat(promovido.getRole()).isEqualTo(Role.ADMIN);
        verify(userRepository, never()).findActiveByRoleForUpdate(any());
    }

    // ---------- soft delete ----------

    @Test
    void nuncaSeUsanLosMetodosHeredadosQueNoFiltranPorActive() {
        User user = conId(new User("alice", "hash"), 1L);
        when(userRepository.findByIdAndActiveTrue(1L)).thenReturn(Optional.of(user));
        when(userRepository.findAllByActiveTrue(PAGINA)).thenReturn(Page.empty());

        userService.findActiveById(1L);
        userService.list(PAGINA);

        verify(userRepository, never()).findById(anyLong());
        verify(userRepository, never()).findAll();
        verify(userRepository, never()).findAll(any(Pageable.class));
    }

    private static User admin(String username) {
        User user = new User(username, "hash");
        user.setRole(Role.ADMIN);
        return user;
    }

    private static User conId(User user, Long id) {
        try {
            var field = User.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(user, id);
            return user;
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }
}
