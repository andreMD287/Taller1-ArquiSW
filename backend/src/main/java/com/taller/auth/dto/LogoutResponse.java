package com.taller.auth.dto;

// revoked=false (con nota) significa que el tier de datos no estaba
// disponible: el refresh token no se pudo borrar, pero el access token de
// todas formas expira solo en <= JWT_TTL_SECONDS. Trade-off documentado en
// TokenService.
public record LogoutResponse(boolean revoked, String note) {
}
