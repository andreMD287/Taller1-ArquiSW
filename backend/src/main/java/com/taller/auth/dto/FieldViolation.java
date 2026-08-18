package com.taller.auth.dto;

/**
 * Una regla de negocio incumplida, en su forma de transporte HTTP.
 *
 * Es el gemelo de RuleViolation del motor de reglas, a proposito: el tipo de
 * dominio no se expone por HTTP (ADR-006). La duplicacion de forma es el
 * precio de que el contrato publico de la API no quede atado a un tipo
 * interno del modulo de productos.
 *
 * Vive en el paquete compartido y NO en el modulo de productos porque
 * ErrorResponse lo referencia: si viviera en product/, la capa compartida
 * dependeria del modulo de productos y se invertiria la direccion de las
 * dependencias (ADR-001, "restrict dependencies").
 *
 * @param rule    identificador estable de la regla, para logs y soporte.
 * @param field   campo al que apunta la violacion, para que el frontend pueda
 *                resaltar el input correspondiente.
 * @param message mensaje legible para el usuario final.
 */
public record FieldViolation(String rule, String field, String message) {
}
