package com.taller.auth.exception;

import com.taller.auth.dto.ErrorResponse;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Banda transversal "Exceptions" del diagrama del taller: cruza los tres
 * tiers logicos y es el UNICO lugar donde una excepcion se convierte en
 * respuesta HTTP. Tactica de disponibilidad "Exception Detection" (Cap. 4).
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    private final MeterRegistry meterRegistry;

    public GlobalExceptionHandler(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    @ExceptionHandler(AppException.class)
    public ResponseEntity<ErrorResponse> handleAppException(AppException ex) {
        return respond(ex.getStatus(), ex.getCode(), ex.getKind(), ex.getMessage(), ex.isRetryable(), null);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException ex) {
        String detail = ex.getBindingResult().getFieldErrors().stream()
                .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
                .reduce((a, b) -> a + "; " + b)
                .orElse(null);
        // entrada mal formada por el cliente: EXPECTED, no cuenta contra disponibilidad.
        return respond(HttpStatus.BAD_REQUEST, "validation_error", FaultKind.EXPECTED,
                "Datos de entrada invalidos", false, detail);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<ErrorResponse> handleConstraintViolation(ConstraintViolationException ex) {
        return respond(HttpStatus.BAD_REQUEST, "validation_error", FaultKind.EXPECTED,
                "Datos de entrada invalidos", false, ex.getMessage());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorResponse> handleMalformedBody(HttpMessageNotReadableException ex) {
        // JSON mal formado es un error del cliente, no una falta del servidor.
        return respond(HttpStatus.BAD_REQUEST, "malformed_request", FaultKind.EXPECTED,
                "Cuerpo de la peticion mal formado", false, null);
    }

    /**
     * Cualquier excepcion no prevista es, por definicion, una falta latente
     * que se acaba de activar: nunca debe llegar al cliente como stack
     * trace, y por eso este es el unico handler que loguea el stack completo.
     */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception ex) {
        log.error("event=unhandled_exception exceptionClass={}", ex.getClass().getName(), ex);
        return respond(HttpStatus.INTERNAL_SERVER_ERROR, "internal_error", FaultKind.FAULT,
                "Error interno inesperado", false, null);
    }

    private ResponseEntity<ErrorResponse> respond(HttpStatus status, String code, FaultKind kind,
                                                    String message, boolean retryable, String detail) {
        String requestId = MDC.get("requestId");
        // un contador por kind (errors.expected/fault/error/failure) es lo que permite
        // separar "credenciales malas" de una caida real al calcular disponibilidad.
        meterRegistry.counter("errors." + kind.name().toLowerCase(), "code", code).increment();
        log.warn("event=error_response code={} kind={} status={} requestId={}",
                code, kind, status.value(), requestId);
        ErrorResponse body = new ErrorResponse(code, kind, message, retryable, requestId, detail);
        return ResponseEntity.status(status).body(body);
    }
}
