package com.taller.auth.dto;

import java.time.Instant;

// Cuerpo comun de /login y /refresh: un par de tokens. accessToken es el JWT
// de corta duracion que se valida en memoria; refreshToken es opaco, de vida
// larga y persistido (unico que se puede revocar via /logout).
public record TokenResponse(
        String accessToken,
        String refreshToken,
        String username,
        Instant accessTokenExpiresAt,
        Instant refreshTokenExpiresAt
) {
}
