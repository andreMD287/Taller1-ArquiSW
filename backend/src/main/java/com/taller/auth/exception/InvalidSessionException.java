package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * Token ausente, invalido o expirado en /validate o /logout. EXPECTED:
 * validar una sesion vencida es el comportamiento correcto, no un fallo.
 */
public class InvalidSessionException extends AppException {

    public InvalidSessionException() {
        super("invalid_session", FaultKind.EXPECTED, HttpStatus.UNAUTHORIZED, false,
                "Token invalido o expirado");
    }
}
