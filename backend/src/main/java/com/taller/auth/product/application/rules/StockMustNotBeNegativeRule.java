package com.taller.auth.product.application.rules;

import com.taller.auth.product.domain.Product;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * El stock nunca puede ser negativo.
 *
 * Esta regla se duplica a proposito como CHECK (stock >= 0) en la tabla
 * (responsabilidad de Rol 2). No es redundancia ociosa: el backend da el
 * mensaje de error util para el usuario, y la constraint de BD es la que
 * garantiza el invariante aunque una ruta de codigo futura se salte este
 * motor. Es la separacion entre "validar" y "no poder violar".
 */
@Component
@Order(20)
public class StockMustNotBeNegativeRule implements ProductRule {

    @Override
    public Optional<RuleViolation> check(Product product) {
        if (product.getStock() >= 0) {
            return Optional.empty();
        }
        return Optional.of(new RuleViolation(
                "stock.must-not-be-negative",
                "stock",
                "El stock no puede ser negativo"));
    }
}
