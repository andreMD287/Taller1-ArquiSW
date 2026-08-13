package com.taller.auth.dto;

import jakarta.validation.constraints.NotBlank;

// Se reutiliza para /refresh y /logout: ambos operan sobre el refresh token,
// nunca sobre el access token (ese no se puede revocar, solo dejar expirar).
public record RefreshTokenRequest(@NotBlank String refreshToken) {
}
