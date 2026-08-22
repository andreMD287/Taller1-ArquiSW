package com.taller.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Actualizacion del perfil.
 *
 * Solo lleva username. El rol y la contrasena tienen endpoints propios a
 * proposito: si viajaran aqui, la autorizacion de PUT tendria que depender de
 * QUE campos trae el cuerpo -"puedes editarte, salvo este campo"-, y ese tipo
 * de condicional es donde se cuelan las escaladas de privilegio. Con endpoints
 * separados, PUT es "self o ADMIN" sin ramas.
 *
 * Mismas restricciones que RegisterRequest: un username creado en el registro
 * y otro puesto en una edicion deben ser indistinguibles.
 */
public record UpdateUserRequest(
        @NotBlank
        @Size(min = 3, max = 50)
        @Pattern(regexp = "^[a-zA-Z0-9]+$", message = "el usuario debe ser alfanumerico")
        String username
) {
}
