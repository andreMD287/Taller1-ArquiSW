package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * Registro con un username ya tomado. EXPECTED: rechazo previsto por regla
 * de negocio, no una falta del sistema.
 */
public class UserAlreadyExistsException extends AppException {

    public UserAlreadyExistsException() {
        super("user_already_exists", FaultKind.EXPECTED, HttpStatus.CONFLICT, false,
                "El usuario ya existe");
    }
}
