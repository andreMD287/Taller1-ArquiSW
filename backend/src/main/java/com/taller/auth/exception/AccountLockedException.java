package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * Bloqueo por intentos fallidos (tactica "Increase Competence Set"): el
 * sistema trata el ataque de fuerza bruta como un estado previsto, por eso
 * es EXPECTED y no un fallo.
 */
public class AccountLockedException extends AppException {

    public AccountLockedException(long secondsRemaining) {
        super("account_locked", FaultKind.EXPECTED, HttpStatus.LOCKED, false,
                "Cuenta bloqueada temporalmente, intente de nuevo en " + secondsRemaining + " segundos");
    }
}
