package com.taller.auth.product.application;

import com.taller.auth.exception.AppException;
import com.taller.auth.exception.FaultKind;
import org.springframework.http.HttpStatus;

/**
 * El producto no existe o esta dado de baja.
 *
 * Un producto con borrado logico se trata como inexistente de cara al
 * cliente: la alternativa -404 para inexistentes y 410 para eliminados-
 * filtraria que ese id llego a existir alguna vez.
 *
 * Hereda de AppException por la misma razon que BusinessRuleViolationException
 * (ADR-007): quedar clasificada como EXPECTED y fuera de ignore-exceptions de
 * Resilience4j. No hace falta un @ExceptionHandler propio: el handler generico
 * de AppException en GlobalExceptionHandler ya la traduce correctamente, y por
 * eso esta clase puede vivir dentro del modulo de productos sin que la capa
 * compartida tenga que conocerla.
 */
public class ProductNotFoundException extends AppException {

    public ProductNotFoundException(Long id) {
        super("product_not_found", FaultKind.EXPECTED, HttpStatus.NOT_FOUND, false,
                "No existe un producto activo con id " + id);
    }
}
