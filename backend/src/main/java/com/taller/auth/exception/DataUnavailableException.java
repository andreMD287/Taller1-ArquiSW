package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * El tier de datos no responde (circuit breaker abierto o timeout de
 * Postgres). FAILURE: el error se propago hasta ser observable por el
 * usuario. Es retryable porque el cliente puede reintentar cuando el
 * circuito cierre; el servidor nunca reintenta esto a ciegas.
 */
public class DataUnavailableException extends AppException {

    public DataUnavailableException(Throwable cause) {
        super("data_unavailable", FaultKind.FAILURE, HttpStatus.SERVICE_UNAVAILABLE, true,
                "El tier de datos no esta disponible en este momento", cause);
    }
}
