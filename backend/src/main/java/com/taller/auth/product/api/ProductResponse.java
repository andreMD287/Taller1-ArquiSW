package com.taller.auth.product.api;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Salida de producto. Es el contrato publico de la API y esta desacoplado a
 * proposito de la entidad Product (ADR-006): Rol 2 puede cambiar el mapeo
 * fisico, agregar columnas de auditoria o cambiar la estrategia de
 * soft-delete sin que el frontend de Rol 3 se entere.
 *
 * "active" se expone porque el borrado es logico y el cliente necesita poder
 * distinguir un producto dado de baja de uno vigente.
 */
public record ProductResponse(
        Long id,
        String name,
        BigDecimal price,
        int stock,
        boolean active,
        Instant createdAt
) {
}
