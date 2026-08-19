package com.taller.auth.product;

import com.taller.auth.product.api.ProductMapper;
import com.taller.auth.product.api.ProductRequest;
import com.taller.auth.product.api.ProductResponse;
import com.taller.auth.product.domain.Product;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

class ProductMapperTest {

    private static final BigDecimal PRECIO = new BigDecimal("19.99");

    @Test
    void toDomainConstruyeUnProductoActivoPorDefecto() {
        Product product = ProductMapper.toDomain(new ProductRequest("Teclado", PRECIO, 10));

        assertThat(product.getName()).isEqualTo("Teclado");
        assertThat(product.getPrice()).isEqualByComparingTo(PRECIO);
        assertThat(product.getStock()).isEqualTo(10);
        assertThat(product.isActive()).isTrue();
        assertThat(product.getCreatedAt()).isNotNull();
    }

    @Test
    void toResponseExponeLosCamposDelContratoPublico() {
        Product product = new Product("Teclado", PRECIO, 10);

        ProductResponse response = ProductMapper.toResponse(product);

        assertThat(response.name()).isEqualTo("Teclado");
        assertThat(response.price()).isEqualByComparingTo(PRECIO);
        assertThat(response.stock()).isEqualTo(10);
        assertThat(response.active()).isTrue();
    }

    // El cliente no gobierna createdAt ni active: una actualizacion no puede
    // reescribir la fecha de creacion ni resucitar un producto dado de baja.
    @Test
    void applyChangesFromNoTocaCreatedAtNiActive() {
        Product existente = new Product("Teclado", PRECIO, 10);
        existente.deactivate();
        var createdAtOriginal = existente.getCreatedAt();

        existente.applyChangesFrom(new Product("Teclado Pro", new BigDecimal("29.99"), 3));

        assertThat(existente.getName()).isEqualTo("Teclado Pro");
        assertThat(existente.getPrice()).isEqualByComparingTo("29.99");
        assertThat(existente.getStock()).isEqualTo(3);
        assertThat(existente.getCreatedAt()).isEqualTo(createdAtOriginal);
        assertThat(existente.isActive()).isFalse();
    }
}
