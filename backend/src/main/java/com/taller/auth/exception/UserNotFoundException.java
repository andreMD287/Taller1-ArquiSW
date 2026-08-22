package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * El usuario no existe o esta dado de baja.
 *
 * Un usuario con borrado logico se trata como inexistente de cara al cliente,
 * por la misma razon que en productos: distinguir "nunca existio" de "existio
 * y fue eliminado" filtraria que ese id llego a usarse.
 */
public class UserNotFoundException extends AppException {

    public UserNotFoundException(Long id) {
        super("user_not_found", FaultKind.EXPECTED, HttpStatus.NOT_FOUND, false,
                "No existe un usuario activo con id " + id);
    }
}
