package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * Base de la jerarquia de excepciones de dominio. Cada subclase declara de
 * una vez su codigo estable (para el cliente), su FaultKind (para la
 * metrica de disponibilidad), su HTTP status y si vale la pena reintentar.
 */
public abstract class AppException extends RuntimeException {

    private final String code;
    private final FaultKind kind;
    private final HttpStatus status;
    private final boolean retryable;

    protected AppException(String code, FaultKind kind, HttpStatus status, boolean retryable, String message) {
        this(code, kind, status, retryable, message, null);
    }

    protected AppException(String code, FaultKind kind, HttpStatus status, boolean retryable,
                            String message, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.kind = kind;
        this.status = status;
        this.retryable = retryable;
    }

    public String getCode() {
        return code;
    }

    public FaultKind getKind() {
        return kind;
    }

    public HttpStatus getStatus() {
        return status;
    }

    public boolean isRetryable() {
        return retryable;
    }
}
