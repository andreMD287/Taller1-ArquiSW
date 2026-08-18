package com.taller.auth.unit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.taller.auth.dto.ErrorResponse;
import com.taller.auth.dto.FieldViolation;
import com.taller.auth.exception.AppException;
import com.taller.auth.exception.BusinessRuleViolationException;
import com.taller.auth.exception.FaultKind;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Protege el contrato de errores tras el cambio aditivo de ADR-007.
 */
class ErrorContractTest {

    private final ObjectMapper json = new ObjectMapper();

    // El cambio a ErrorResponse tenia que ser invisible para Taller 1: si esta
    // prueba cae, alguna respuesta de error existente cambio de forma y el
    // frontend de Rol 3 y las IT de Rol 4 pueden romperse.
    @Test
    void unErrorSinViolacionesNoSerializaLaClaveViolations() throws Exception {
        ErrorResponse error = new ErrorResponse("invalid_credentials", FaultKind.EXPECTED,
                "Credenciales invalidas", false, "req-1", null);

        String body = json.writeValueAsString(error);

        assertThat(body).doesNotContain("violations");
        assertThat(body).contains("invalid_credentials");
    }

    @Test
    void unErrorConViolacionesLasSerializaConSuCampo() throws Exception {
        ErrorResponse error = new ErrorResponse("business_rule_violation", FaultKind.EXPECTED,
                "La operacion incumple una o mas reglas de negocio", false, "req-2", null,
                List.of(new FieldViolation("price.must-be-positive", "price", "El precio debe ser mayor a 0")));

        String body = json.writeValueAsString(error);

        assertThat(body).contains("violations", "price.must-be-positive", "\"field\":\"price\"");
    }

    /**
     * LA GUARDA MAS IMPORTANTE DE ADR-007. application.yml lista AppException
     * en ignore-exceptions del circuit breaker y del retry de Resilience4j. Si
     * alguien "limpia" esta jerarquia y hace que la excepcion herede
     * directamente de RuntimeException, un usuario tecleando precios invalidos
     * empezaria a contar como fallas del tier de datos y podria abrir el
     * circuit breaker para todos los demas.
     */
    @Test
    void laExcepcionDeNegocioHeredaDeAppExceptionParaQuedarFueraDelCircuitBreaker() {
        BusinessRuleViolationException ex = new BusinessRuleViolationException(
                List.of(new FieldViolation("stock.must-not-be-negative", "stock", "El stock no puede ser negativo")));

        assertThat(ex).isInstanceOf(AppException.class);
        assertThat(ex.getKind()).isEqualTo(FaultKind.EXPECTED);
        assertThat(ex.getStatus()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(ex.isRetryable()).isFalse();
        assertThat(ex.getCode()).isEqualTo("business_rule_violation");
    }

    @Test
    void laListaDeViolacionesEsInmutable() {
        List<FieldViolation> mutable = new java.util.ArrayList<>();
        mutable.add(new FieldViolation("r", "f", "m"));

        BusinessRuleViolationException ex = new BusinessRuleViolationException(mutable);
        mutable.clear();

        assertThat(ex.getViolations()).hasSize(1);
    }
}
