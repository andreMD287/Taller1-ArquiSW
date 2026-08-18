package com.taller.auth.product.application.rules;

import com.taller.auth.product.domain.Product;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.Optional;

/**
 * El precio debe ser estrictamente mayor a 0: ni negativo ni cero.
 *
 * Un precio nulo NO es asunto de esta regla: eso es una violacion estructural
 * (falta un campo obligatorio) y la ataja Bean Validation en el DTO de
 * entrada, antes de que se llegue a construir el Product. Aqui se ignora en
 * vez de duplicar el mensaje de error.
 */
@Component
@Order(10)
public class PriceMustBePositiveRule implements ProductRule {

    @Override
    public Optional<RuleViolation> check(Product product) {
        BigDecimal price = product.getPrice();
        if (price == null || price.compareTo(BigDecimal.ZERO) > 0) {
            return Optional.empty();
        }
        return Optional.of(new RuleViolation(
                "price.must-be-positive",
                "price",
                "El precio debe ser mayor a 0"));
    }
}
