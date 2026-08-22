package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * La contrasena actual enviada al cambiar de clave no coincide.
 *
 * 422 y no 401: el usuario SI esta autenticado -su token es valido-, asi que
 * un 401 le diria al cliente que su sesion caduco y lo mandaria a iniciar
 * sesion de nuevo, que es justo lo que no pasa. Lo que falla es una regla de
 * negocio de la operacion: para cambiar la clave hay que demostrar que se
 * conoce la vigente.
 *
 * Por que se exige la contrasena actual aunque el usuario ya este
 * autenticado: limita el dano de una sesion secuestrada. Con el token robado
 * un atacante puede leer y modificar el perfil, pero no puede apoderarse de
 * la cuenta de forma permanente cambiando la clave.
 */
public class InvalidCurrentPasswordException extends AppException {

    public InvalidCurrentPasswordException() {
        super("invalid_current_password", FaultKind.EXPECTED, HttpStatus.UNPROCESSABLE_ENTITY, false,
                "La contrasena actual no es correcta");
    }
}
