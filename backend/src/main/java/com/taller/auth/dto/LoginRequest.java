package com.taller.auth.dto;

import jakarta.validation.constraints.NotBlank;

// Sin restricciones de formato: el formato ya se valido en el registro, y
// aplicar reglas distintas aqui podria filtrar por que se rechazo el login.
public record LoginRequest(
        @NotBlank String username,
        @NotBlank String password
) {
}
