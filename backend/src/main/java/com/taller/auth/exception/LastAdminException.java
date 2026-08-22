package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * Protege la invariancia de que el sistema conserve
 * al menos un administrador activo.
 */
public class LastAdminException extends AppException {

    public LastAdminException() {
        super(
                "last_admin_protected",
                FaultKind.EXPECTED,
                HttpStatus.CONFLICT,
                false,
                "No se puede desactivar ni quitar el rol al ultimo administrador activo"
        );
    }
}