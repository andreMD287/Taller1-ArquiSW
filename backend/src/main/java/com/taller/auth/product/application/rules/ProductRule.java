package com.taller.auth.product.application.rules;

import com.taller.auth.product.domain.Product;

import java.util.Optional;

/**
 * Una regla de negocio de producto. ESTE ES EL PUNTO DE EXTENSION del modulo
 * (ADR-003): agregar una regla nueva es crear una clase que implemente esta
 * interfaz y anotarla con @Component. Spring la descubre sola y el motor la
 * empieza a aplicar sin que haya que editar NINGUN archivo existente.
 *
 * Si algun dia agregar una regla te obliga a modificar ProductRuleEngine, o
 * un registro central, o un enum, la tactica se rompio: revisa ADR-003 antes
 * de hacerlo.
 *
 * Contrato: check() NO lanza excepciones. Devuelve la violacion si la hay y
 * Optional.empty() si la regla se cumple, para que el motor pueda evaluar
 * TODAS las reglas y acumular sus violaciones (ADR-004). Una regla que lanza
 * impide que se evaluen las siguientes y deja al usuario corrigiendo errores
 * de a uno.
 */
public interface ProductRule {

    Optional<RuleViolation> check(Product product);
}
