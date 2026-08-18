package com.taller.auth.product.application.rules;

/**
 * Una regla de negocio incumplida.
 *
 * Deliberadamente NO conoce HTTP: no lleva status code ni nada especifico de
 * la capa web. Traducir esto a una respuesta de error es responsabilidad de
 * la capa api y del GlobalExceptionHandler (pendiente: ADR-007).
 *
 * @param rule    identificador estable de la regla, para logs y diagnostico.
 *                No es texto de UI: no se traduce ni cambia con el mensaje.
 * @param field   campo de Product al que apunta la violacion, para que el
 *                frontend de Rol 3 pueda resaltarlo en el formulario.
 * @param message mensaje legible para el usuario final.
 */
public record RuleViolation(String rule, String field, String message) {
}
