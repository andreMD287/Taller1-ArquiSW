package com.taller.auth.dto;

import java.time.Instant;

// Ya no existe un modo "degraded": validate se verifica enteramente en
// memoria (ver TokenService), asi que nunca depende de que el tier de datos
// este arriba o abajo.
public record ValidateResponse(String username, Instant expiresAt) {
}
