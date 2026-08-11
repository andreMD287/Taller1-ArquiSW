package com.taller.auth.dto;

import com.taller.auth.exception.FaultKind;

/**
 * Cuerpo unico de error de toda la API. Lo produce solo el
 * GlobalExceptionHandler: ningun controlador construye uno a mano.
 */
public record ErrorResponse(
        String code,
        FaultKind kind,
        String message,
        boolean retryable,
        String requestId,
        String detail
) {
}
