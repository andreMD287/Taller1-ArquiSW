package com.taller.auth.product;

import com.taller.auth.product.application.rules.PriceMustBePositiveRule;
import com.taller.auth.product.application.rules.RuleViolation;
import com.taller.auth.product.application.rules.StockMustNotBeNegativeRule;
import com.taller.auth.product.domain.Product;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Cada regla se prueba sola, sin motor y sin Spring: es la contrapartida de
 * "una regla = una clase" (increase semantic coherence, Cap. 8).
 */
class ProductRulesTest {

    private final PriceMustBePositiveRule priceRule = new PriceMustBePositiveRule();
    private final StockMustNotBeNegativeRule stockRule = new StockMustNotBeNegativeRule();

    private static Product conPrecio(String price) {
        return new Product("Teclado", price == null ? null : new BigDecimal(price), 1);
    }

    private static Product conStock(int stock) {
        return new Product("Teclado", new BigDecimal("19.99"), stock);
    }

    @Test
    void unPrecioMayorACeroEsValido() {
        assertThat(priceRule.check(conPrecio("0.01"))).isEmpty();
    }

    // el caso limite que la regla de negocio nombra explicitamente: 0 NO vale.
    @Test
    void unPrecioDeCeroEsInvalido() {
        Optional<RuleViolation> violation = priceRule.check(conPrecio("0.00"));

        assertThat(violation).isPresent();
        assertThat(violation.get().rule()).isEqualTo("price.must-be-positive");
    }

    @Test
    void unPrecioNegativoEsInvalido() {
        assertThat(priceRule.check(conPrecio("-0.01"))).isPresent();
    }

    // un precio nulo es una violacion ESTRUCTURAL, no de negocio: la ataja
    // Bean Validation en el DTO. Esta regla lo deja pasar para no duplicar el
    // mensaje de error.
    @Test
    void unPrecioNuloNoEsAsuntoDeEstaRegla() {
        assertThat(priceRule.check(conPrecio(null))).isEmpty();
    }

    @Test
    void unStockDeCeroEsValido() {
        assertThat(stockRule.check(conStock(0))).isEmpty();
    }

    @Test
    void unStockPositivoEsValido() {
        assertThat(stockRule.check(conStock(5))).isEmpty();
    }

    @Test
    void unStockNegativoEsInvalido() {
        Optional<RuleViolation> violation = stockRule.check(conStock(-1));

        assertThat(violation).isPresent();
        assertThat(violation.get().rule()).isEqualTo("stock.must-not-be-negative");
        assertThat(violation.get().field()).isEqualTo("stock");
    }
}
