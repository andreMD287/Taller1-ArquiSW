package com.taller.auth.integration;

import com.taller.auth.dto.LoginRequest;
import com.taller.auth.dto.RegisterRequest;
import com.taller.auth.dto.RegisterResponse;
import com.taller.auth.dto.TokenResponse;
import com.taller.auth.dto.ValidateRequest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pruebas centradas en disponibilidad, no en el contrato funcional (eso es
 * AuthControllerIT). En particular, esta clase es la regresion automatizada
 * del bug real encontrado en la Fase 4: Resilience4j enrutaba CUALQUIER
 * excepcion de negocio (password mala, usuario duplicado) al fallback del
 * circuit breaker, devolviendo 503/data_unavailable donde debia ir un
 * 401/409 EXPECTED. Con un contexto de Spring real, aqui SI se tejen los
 * aspectos @CircuitBreaker/@Retry, a diferencia de los tests unitarios.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AvailabilityIT {

    @Autowired
    private TestRestTemplate rest;

    private String uniqueUsername(String prefix) {
        return prefix + System.nanoTime();
    }

    @Test
    void unaPasswordIncorrectaEsExpectedYNoUnaCaidaDelTierDeDatos() {
        String username = uniqueUsername("brute");
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);

        ResponseEntity<String> response = rest.postForEntity(
                "/api/auth/login", new LoginRequest(username, "password-mala"), String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(response.getBody())
                .contains("\"code\":\"invalid_credentials\"")
                .contains("\"kind\":\"EXPECTED\"");
    }

    @Test
    void unTokenInexistenteEsExpectedYNoUnaCaidaDelTierDeDatos() {
        ResponseEntity<String> response = rest.postForEntity(
                "/api/auth/validate", new ValidateRequest("token-que-no-existe"), String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(response.getBody())
                .contains("\"code\":\"invalid_session\"")
                .contains("\"kind\":\"EXPECTED\"");
    }

    @Test
    void unRegistroDuplicadoEsExpectedYNoUnaCaidaDelTierDeDatos() {
        String username = uniqueUsername("dupavail");
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);

        ResponseEntity<String> response = rest.postForEntity(
                "/api/auth/register", new RegisterRequest(username, "password123"), String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody()).contains("\"kind\":\"EXPECTED\"");
    }

    @Test
    void todaRespuestaDeErrorIncluyeUnRequestIdCorrelacionable() {
        ResponseEntity<String> response = rest.postForEntity(
                "/api/auth/validate", new ValidateRequest("basura"), String.class);

        String headerRequestId = response.getHeaders().getFirst("X-Request-Id");
        assertThat(headerRequestId).isNotBlank();
        assertThat(response.getBody()).contains("\"requestId\":\"" + headerRequestId + "\"");
    }

    @Test
    void unaCuentaBloqueadaPorFuerzaBrutaNoAfectaAOtrosUsuarios() {
        String victima = uniqueUsername("victima");
        String inocente = uniqueUsername("inocente");
        rest.postForEntity("/api/auth/register", new RegisterRequest(victima, "password123"), RegisterResponse.class);
        rest.postForEntity("/api/auth/register", new RegisterRequest(inocente, "password123"), RegisterResponse.class);

        // agota el umbral de intentos (default: 5) sobre la cuenta victima.
        for (int i = 0; i < 5; i++) {
            rest.postForEntity("/api/auth/login", new LoginRequest(victima, "password-mala"), String.class);
        }

        ResponseEntity<String> bloqueada = rest.postForEntity(
                "/api/auth/login", new LoginRequest(victima, "password123"), String.class);
        assertThat(bloqueada.getStatusCode()).isEqualTo(HttpStatus.LOCKED);
        assertThat(bloqueada.getBody()).contains("\"code\":\"account_locked\"");

        // ESC-D5: el bloqueo de UNA cuenta no debe degradar el servicio para el resto.
        ResponseEntity<TokenResponse> sanaSigueFuncionando = rest.postForEntity(
                "/api/auth/login", new LoginRequest(inocente, "password123"), TokenResponse.class);
        assertThat(sanaSigueFuncionando.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void livenessNuncaDependeDelTierDeDatosYSiempreRespondeUp() {
        ResponseEntity<String> response = rest.getForEntity("/actuator/health/liveness", String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).contains("\"status\":\"UP\"");
    }

    @Test
    void readinessRespondeUpCuandoElTierDeDatosEstaSano() {
        // show-details=when-authorized (base) oculta los componentes a peticiones
        // anonimas a proposito; solo el perfil docker lo pone en "always" para la
        // demo. Aqui solo se puede verificar el agregado, no el desglose interno.
        ResponseEntity<String> response = rest.getForEntity("/actuator/health/readiness", String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).contains("\"status\":\"UP\"");
    }
}
