package com.taller.auth.product.application.rules;

import com.taller.auth.product.domain.Product;
import com.taller.auth.product.infrastructure.ProductRepository;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * El nombre de producto es unico (ADR-009: unicidad GLOBAL, no solo entre
 * activos — el nombre de un producto dado de baja no se libera).
 *
 * Distingue alta de edicion por el id: un Product sin id todavia no esta
 * persistido, asi que compite contra todos los nombres; uno con id se compara
 * excluyendose a si mismo, para que guardar un producto sin cambiarle el
 * nombre no se detecte como duplicado.
 *
 * ESTA REGLA NO ES LA GARANTIA, es el mensaje de error. Entre el exists...()
 * y el INSERT hay una ventana en la que otra transaccion puede insertar el
 * mismo nombre. Quien impide el duplicado de verdad es la constraint
 * uq_products_name; ProductService captura DataIntegrityViolationException y
 * la traduce a esta misma violacion. Ver seccion 4 del contrato con Rol 2.
 */
@Component
@Order(30)
public class ProductNameMustBeUniqueRule implements ProductRule {

    static final String RULE_ID = "name.must-be-unique";
    static final String MESSAGE = "Ya existe un producto con ese nombre";

    private final ProductRepository repository;

    public ProductNameMustBeUniqueRule(ProductRepository repository) {
        this.repository = repository;
    }

    @Override
    public Optional<RuleViolation> check(Product product) {
        String name = product.getName();
        if (name == null || name.isBlank()) {
            // ausencia de nombre es validacion estructural (@NotBlank en el
            // DTO), no asunto de esta regla (ADR-004).
            return Optional.empty();
        }
        boolean duplicated = product.getId() == null
                ? repository.existsByName(name)
                : repository.existsByNameAndIdNot(name, product.getId());

        return duplicated
                ? Optional.of(new RuleViolation(RULE_ID, "name", MESSAGE))
                : Optional.empty();
    }
}
