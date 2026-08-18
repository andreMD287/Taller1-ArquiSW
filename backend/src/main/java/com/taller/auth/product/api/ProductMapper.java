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

    /**
     * Actualizacion: se mutan solo los campos que el cliente puede cambiar.
     * id, active y createdAt NO se tocan aqui — el id es inmutable, active se
     * cambia por el endpoint de borrado logico y createdAt es un dato de
     * auditoria que el cliente no gobierna.
     */
    public static void applyTo(Product product, ProductRequest request) {
        product.setName(request.name());
        product.setPrice(request.price());
        product.setStock(request.stock());
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
