package com.taller.auth.product.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;

/**
 * Entrada de creacion y actualizacion de producto.
 *
 * ADR-004: aqui SOLO hay validacion ESTRUCTURAL — que el campo venga y tenga
 * la forma correcta. NO lleva @Positive en price ni @PositiveOrZero en stock,
 * aunque seria sintacticamente posible: esas son reglas de NEGOCIO y viven en
 * el motor de reglas, en un unico lugar. Si manana el negocio permite
 * productos gratuitos, se cambia una regla y este archivo no se toca.
 *
 * stock es Integer y no int a proposito: con un primitivo, un JSON que omita
 * el campo lo dejaria en 0 silenciosamente y @NotNull nunca se disparara.
 */
public record ProductRequest(

        @NotBlank(message = "El nombre es obligatorio")
        @Size(max = 120, message = "El nombre no puede exceder 120 caracteres")
        String name,

        @NotNull(message = "El precio es obligatorio")
        BigDecimal price,

        @NotNull(message = "El stock es obligatorio")
        Integer stock
) {
}
