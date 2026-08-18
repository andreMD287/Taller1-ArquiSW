package com.taller.auth.exception;

import com.taller.auth.dto.FieldViolation;
import org.springframework.http.HttpStatus;

import java.util.List;

/**
 * Una o mas reglas de negocio incumplidas (ADR-007).
 *
 * POR QUE EXTIENDE AppException Y NO RuntimeException: application.yml lista
 * com.taller.auth.exception.AppException en "ignore-exceptions" TANTO del
 * circuit breaker COMO del retry de Resilience4j. Una excepcion de negocio
 * que no herede de aqui seria contada por Resilience4j como una falla del
 * tier de datos: un usuario tecleando precios invalidos podria llegar a abrir
 * el circuit breaker y degradar el servicio para todos. Heredar de
 * AppException es lo que la clasifica como EXPECTED (Cap. 4) y la mantiene
 * fuera del calculo de disponibilidad.
 *
 * 422 y no 400: la peticion esta bien formada y es sintacticamente valida
 * -de eso ya se encargo Bean Validation, que responde 400-; lo que falla es
 * su semantica de negocio.
 */
public class BusinessRuleViolationException extends AppException {

    private final List<FieldViolation> violations;

    public BusinessRuleViolationException(List<FieldViolation> violations) {
        super("business_rule_violation", FaultKind.EXPECTED, HttpStatus.UNPROCESSABLE_ENTITY, false,
                "La operacion incumple una o mas reglas de negocio");
        this.violations = List.copyOf(violations);
    }

    public List<FieldViolation> getViolations() {
        return violations;
    }
}
