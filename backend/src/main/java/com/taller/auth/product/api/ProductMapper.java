package com.taller.auth.product.api;

import com.taller.auth.product.domain.Product;

/**
 * Traduccion entre el contrato publico (DTOs) y el dominio (ADR-006).
 *
 * Mapeo manual y explicito, sin MapStruct: no agrega dependencias ni un
 * annotation processor al build de Rol 4, y el mapeo queda visible en el
 * repositorio en vez de en codigo generado — que es lo que hay que poder
 * mostrar al sustentar el taller.
 *
 * Clase de utilidad sin estado: no es un @Component porque no depende de
 * nada. Convertirla en bean solo agregaria un salto de inyeccion sin ganar
 * nada testeable.
 *
 * Solo traduce en los dos sentidos entre DTO y dominio. La actualizacion de
 * una entidad existente NO se hace aqui sino en Product.applyChangesFrom():
 * decidir que campos son editables es una regla del dominio, no del
 * transporte, y asi el campo y su editabilidad quedan en el mismo archivo.
 *
 * NOTA PARA EL EJERCICIO CRONOMETRADO: al agregar un atributo nuevo a
 * Product, este es uno de los archivos que hay que tocar (junto con los dos
 * records y la entidad). Esta contado en el guion.
 */
public final class ProductMapper {

    private ProductMapper() {
    }

    public static Product toDomain(ProductRequest request) {
        return new Product(request.name(), request.price(), request.stock());
    }

    public static ProductResponse toResponse(Product product) {
        return new ProductResponse(
                product.getId(),
                product.getName(),
                product.getPrice(),
                product.getStock(),
                product.isActive(),
                product.getCreatedAt());
    }
}
