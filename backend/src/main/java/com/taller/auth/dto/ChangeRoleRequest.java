package com.taller.auth.dto;

import com.taller.auth.model.Role;

import jakarta.validation.constraints.NotNull;

/**
 * Cambio de rol, reservado a un ADMIN.
 *
 * El tipo es el enum Role y no un String: un valor fuera de USER/ADMIN falla
 * al deserializar y produce un 400, sin que ninguna capa tenga que validarlo.
 * Es la tactica Exception Prevention del Cap. 4 aplicada con el sistema de
 * tipos en vez de con una comprobacion.
 */
public record ChangeRoleRequest(
        @NotNull
        Role role
) {
}
