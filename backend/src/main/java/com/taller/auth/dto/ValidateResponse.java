package com.taller.auth.dto;

import java.time.Instant;

// degraded=true significa que la respuesta vino de la cache local del nodo
// porque el tier de datos no estaba disponible (Graceful Degradation, Cap. 4).
public record ValidateResponse(String username, Instant expiresAt, boolean degraded) {
}
