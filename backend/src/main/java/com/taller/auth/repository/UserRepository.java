package com.taller.auth.repository;

import java.util.List;
import java.util.Optional;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.taller.auth.model.Role;
import com.taller.auth.model.User;

import jakarta.persistence.LockModeType;

/**
 * Unica puerta de entrada al almacenamiento de usuarios.
 *
 * Los servicios no acceden directamente a la base de datos.
 *
 * Para operaciones normales del Taller 2 deben preferirse los metodos
 * que filtran explicitamente por active=true, de modo que los usuarios
 * desactivados mediante soft delete no sean considerados vigentes.
 */
public interface UserRepository extends JpaRepository<User, Long> {

    /*
     * Se conservan temporalmente para no romper la autenticacion actual.
     * El login debera migrar posteriormente a findByUsernameAndActiveTrue().
     */
    Optional<User> findByUsername(String username);

    boolean existsByUsername(String username);

    /*
     * Usuarios activos.
     */

    Optional<User> findByUsernameAndActiveTrue(String username);

    Optional<User> findByIdAndActiveTrue(Long id);

    Page<User> findAllByActiveTrue(Pageable pageable);

    /*
     * Permite validar unicidad durante una actualizacion sin considerar
     * al mismo usuario como duplicado.
     */
    boolean existsByUsernameAndIdNot(String username, Long id);

    /*
     * Util para reglas y diagnostico relacionados con administradores.
     *
     * IMPORTANTE:
     * este conteo por si solo NO protege la invariancia del ultimo ADMIN
     * frente a operaciones concurrentes.
     */
    long countByRoleAndActiveTrue(Role role);

    /*
     * Interlock para operaciones que puedan reducir la cantidad de ADMIN.
     *
     * PESSIMISTIC_WRITE bloquea las filas de administradores activos
     * durante la transaccion que ejecute la regla de negocio.
     *
     * Esto permite que el servicio compruebe de forma segura si una
     * desactivacion o cambio de rol dejaria al sistema sin administradores.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
            select u
            from User u
            where u.role = :role
              and u.active = true
            """)
    List<User> findActiveByRoleForUpdate(@Param("role") Role role);
}