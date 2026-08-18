package com.taller.auth.product.application.rules;

import com.taller.auth.product.domain.Product;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/**
 * Aplica todas las reglas de negocio de producto y acumula sus violaciones.
 *
 * ADR-003 (tactica "defer binding", Cap. 8): el conjunto de reglas NO esta
 * escrito en esta clase. Spring inyecta aqui todos los beans que implementen
 * ProductRule, asi que el binding entre el motor y sus reglas se resuelve al
 * arrancar el contenedor, no al compilar. Consecuencia practica: esta clase
 * es cerrada a modificacion y el modulo abierto a extension — agregar una
 * regla no toca este archivo.
 *
 * El orden de evaluacion sigue las anotaciones @Order de cada regla (Spring
 * ordena las colecciones que inyecta). Solo importa para el orden en que se
 * le muestran los mensajes al usuario: ninguna regla depende de otra.
 */
@Component
public class ProductRuleEngine {

    private final List<ProductRule> rules;

    public ProductRuleEngine(List<ProductRule> rules) {
        // copia inmutable: nadie puede alterar el conjunto de reglas activas
        // en caliente, ni por accidente ni a proposito.
        this.rules = List.copyOf(rules);
    }

    /**
     * Evalua TODAS las reglas, no se detiene en la primera violacion (ADR-004).
     *
     * No lanza: devolver la lista deja en manos del servicio que llama la
     * decision de que hacer con ella. Asi el motor no queda atado a una
     * estrategia de manejo de excepciones que todavia no esta cerrada (ADR-007).
     *
     * @return lista vacia si el producto cumple todas las reglas.
     */
    public List<RuleViolation> validate(Product product) {
        return rules.stream()
                .map(rule -> rule.check(product))
                .flatMap(Optional::stream)
                .toList();
    }

    /**
     * Reglas activas en esta instancia. Existe para compensar el unico costo
     * real de ADR-003: como el catalogo de reglas no vive en ningun archivo,
     * hace falta poder preguntarselo al sistema en ejecucion.
     */
    public List<String> activeRuleNames() {
        return rules.stream()
                .map(rule -> rule.getClass().getSimpleName())
                .sorted()
                .toList();
    }
}
