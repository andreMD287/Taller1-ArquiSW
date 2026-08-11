package com.taller.auth.dto;

import jakarta.validation.constraints.NotBlank;

// Se reutiliza para /validate y /logout: ambos solo necesitan el token.
public record ValidateRequest(@NotBlank String token) {
}
