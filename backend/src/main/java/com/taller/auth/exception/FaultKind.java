package com.taller.auth.exception;

/**
 * Taxonomia del Cap. 4: falta, error y fallo no son sinonimos.
 *
 * EXPECTED - el sistema respondio segun su especificacion (ej: password
 *            incorrecta). No es una falta ni cuenta contra disponibilidad.
 * FAULT    - defecto latente que se acaba de activar (ej: excepcion no
 *            prevista). Puede o no haberse vuelto visible para el usuario.
 * ERROR    - el estado interno quedo incorrecto pero se contuvo antes de
 *            llegar al cliente.
 * FAILURE  - el error se propago y el servicio se desvio de su
 *            especificacion de forma observable por el usuario.
 *
 * Solo FAULT y FAILURE cuentan contra el 99.99% de disponibilidad.
 */
public enum FaultKind {
    EXPECTED,
    FAULT,
    ERROR,
    FAILURE
}
