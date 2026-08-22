package com.taller.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Cambio de contrasena propia.
 *
 * currentPassword no lleva @Size: no se valida la FORMA de la clave vigente,
 * solo si coincide. Exigirle un minimo de longitud filtraria informacion sobre
 * la clave almacenada y ademas rechazaria por 400 lo que deberia rechazarse
 * por no coincidir.
 */
public record ChangePasswordRequest(
        @NotBlank
        String currentPassword,

        @NotBlank
        @Size(min = 8, max = 100)
        String newPassword
) {
}
