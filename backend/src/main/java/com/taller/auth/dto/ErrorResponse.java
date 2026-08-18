package com.taller.auth.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.taller.auth.exception.FaultKind;

import java.util.List;

/**
 * Cuerpo unico de error de toda la API. Lo produce solo el
 * GlobalExceptionHandler: ningun controlador construye uno a mano.
 *
 * Taller 2 (ADR-007): se agrego "violations" para que un fallo de reglas de
 * negocio pueda reportar TODAS las violaciones a la vez, cada una apuntando a
 * su campo, y el frontend pueda resaltar varios inputs de un formulario en un
 * solo viaje.
 *
 * El cambio es ADITIVO: @JsonInclude(NON_NULL) omite el campo cuando es nulo,
 * asi que todas las respuestas de error de Taller 1 siguen serializandose
 * exactamente igual que antes. El constructor de 6 argumentos se conservo por
 * la misma razon: ningun codigo existente tuvo que cambiar.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ErrorResponse(
        String code,
        FaultKind kind,
        String message,
        boolean retryable,
        String requestId,
        String detail,
        List<FieldViolation> violations
) {

    public ErrorResponse(String code, FaultKind kind, String message, boolean retryable,
                          String requestId, String detail) {
        this(code, kind, message, retryable, requestId, detail, null);
    }
}
