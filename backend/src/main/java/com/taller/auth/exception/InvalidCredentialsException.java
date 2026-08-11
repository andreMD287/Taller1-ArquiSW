package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * Usuario inexistente o password incorrecta. EXPECTED: el sistema esta
 * funcionando perfectamente cuando rechaza credenciales malas, esto no
 * cuenta contra el 99.99% de disponibilidad.
 */
public class InvalidCredentialsException extends AppException {

    public InvalidCredentialsException() {
        super("invalid_credentials", FaultKind.EXPECTED, HttpStatus.UNAUTHORIZED, false,
                "Usuario o contrasena invalidos");
    }
}
