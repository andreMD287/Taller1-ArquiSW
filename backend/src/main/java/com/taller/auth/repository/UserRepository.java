package com.taller.auth.repository;

import com.taller.auth.model.User;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

/**
 * Unica puerta de entrada al almacenamiento de usuarios. Ningun servicio
 * habla con la base de datos si no es a traves de este contrato.
 */
public interface UserRepository extends JpaRepository<User, Long> {

    Optional<User> findByUsername(String username);

    boolean existsByUsername(String username);
}
