package com.taller.auth.dto;

import com.taller.auth.model.Role;

import java.time.Instant;

/**
 * Vista publica de un usuario.
 *
 * NO expone passwordHash, failedAttempts ni lockedUntil. Los dos ultimos no se
 * omiten por descuido: revelan si una cuenta esta bajo ataque de fuerza bruta,
 * que es informacion util para quien lo esta ejecutando.
 */
public record UserResponse(
        Long id,
        String username,
        Role role,
        boolean active,
        Instant createdAt
) {
}
