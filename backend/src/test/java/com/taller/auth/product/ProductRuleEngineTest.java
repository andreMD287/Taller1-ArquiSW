package com.taller.auth.product;

import com.taller.auth.product.application.rules.PriceMustBePositiveRule;
import com.taller.auth.product.application.rules.ProductRule;
import com.taller.auth.product.application.rules.ProductRuleEngine;
import com.taller.auth.product.application.rules.RuleViolation;
import com.taller.auth.product.application.rules.StockMustNotBeNegativeRule;
import com.taller.auth.product.domain.Product;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * El motor se instancia directamente con la lista de reglas: no hace falta
 * levantar Spring para probar la logica. Ese aislamiento es una consecuencia
 * buscada de ADR-003 — la inyeccion por constructor de List<ProductRule>
 * permite sustituir el conjunto de reglas en una prueba sin ningun andamiaje.
 */
class ProductRuleEngineTest {

    private static final BigDecimal PRECIO_VALIDO = new BigDecimal("19.99");

    private ProductRuleEngine engineConReglasReales() {
        return new ProductRuleEngine(List.of(
                new PriceMustBePositiveRule(),
                new StockMustNotBeNegativeRule()));
    }

    @Test
    void unProductoValidoNoProduceNingunaViolacion() {
        Product product = new Product("Teclado", PRECIO_VALIDO, 10);

        assertThat(engineConReglasReales().validate(product)).isEmpty();
    }

    // ADR-004: el motor NO se detiene en la primera violacion. Este test es la
    // evidencia de esa decision — si alguien lo cambia a fail-fast, cae aqui.
    @Test
    void acumulaTodasLasViolacionesEnVezDeDetenerseEnLaPrimera() {
        Product invalido = new Product("Teclado", new BigDecimal("-5.00"), -3);

        List<RuleViolation> violations = engineConReglasReales().validate(invalido);

        assertThat(violations).hasSize(2);
        assertThat(violations).extracting(RuleViolation::rule)
                .containsExactly("price.must-be-positive", "stock.must-not-be-negative");
        assertThat(violations).extracting(RuleViolation::field)
                .containsExactly("price", "stock");
    }

    // ADR-003: el punto de extension del modulo. Agregar una regla es agregar
    // un elemento a la lista de beans, sin tocar ProductRuleEngine.
    @Test
    void unaReglaNuevaSeAplicaSinModificarElMotor() {
        ProductRule reglaNueva = product -> product.getName().startsWith("XX")
                ? Optional.of(new RuleViolation("name.reserved-prefix", "name", "Prefijo reservado"))
                : Optional.empty();

        ProductRuleEngine engine = new ProductRuleEngine(List.of(
                new PriceMustBePositiveRule(),
                new StockMustNotBeNegativeRule(),
                reglaNueva));

        List<RuleViolation> violations = engine.validate(new Product("XX-Teclado", PRECIO_VALIDO, 10));

        assertThat(violations).extracting(RuleViolation::rule).containsExactly("name.reserved-prefix");
    }

    @Test
    void activeRuleNamesExponeElCatalogoDeReglasActivas() {
        assertThat(engineConReglasReales().activeRuleNames())
                .containsExactly("PriceMustBePositiveRule", "StockMustNotBeNegativeRule");
    }

    @Test
    void unMotorSinReglasNoRompe() {
        assertThat(new ProductRuleEngine(List.of()).validate(new Product("X", PRECIO_VALIDO, 1)))
                .isEmpty();
    }
}
