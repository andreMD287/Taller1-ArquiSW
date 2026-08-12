package com.taller.auth.integration;

import com.taller.auth.dto.LoginRequest;
import com.taller.auth.dto.LoginResponse;
import com.taller.auth.dto.RegisterRequest;
import com.taller.auth.dto.RegisterResponse;
import com.taller.auth.dto.ValidateRequest;
import com.taller.auth.dto.ValidateResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Contrato HTTP completo de /api/auth y /api/diagnostics, contra H2 (perfil
 * test). Cada metodo usa un username unico para no interferir entre tests
 * que corren sobre la misma base en memoria.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AuthControllerIT {

    @Autowired
    private TestRestTemplate rest;

    private String uniqueUsername(String prefix) {
        return prefix + System.nanoTime();
    }

    @Test
    void registerCreaUnUsuarioNuevo() {
        String username = uniqueUsername("reg");

        ResponseEntity<RegisterResponse> response = rest.postForEntity(
                "/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(response.getBody().username()).isEqualTo(username);
    }

    @Test
    void registerConUsernameDuplicadoDa409() {
        String username = uniqueUsername("dup");
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);

        ResponseEntity<String> response = rest.postForEntity(
                "/api/auth/register", new RegisterRequest(username, "password123"), String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody()).contains("user_already_exists");
    }

    @Test
    void registerConPasswordCortaEsRechazadoPorValidacion() {
        ResponseEntity<String> response = rest.postForEntity(
                "/api/auth/register", new RegisterRequest(uniqueUsername("corto"), "123"), String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).contains("validation_error");
    }

    @Test
    void loginConCredencialesValidasDevuelveUnToken() {
        String username = uniqueUsername("login");
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);

        ResponseEntity<LoginResponse> response = rest.postForEntity(
                "/api/auth/login", new LoginRequest(username, "password123"), LoginResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().token()).isNotBlank();
        assertThat(response.getBody().username()).isEqualTo(username);
    }

    @Test
    void validateConUnTokenValidoLoConfirmaSinDegradacion() {
        String username = uniqueUsername("val");
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);
        LoginResponse login = rest.postForEntity(
                "/api/auth/login", new LoginRequest(username, "password123"), LoginResponse.class).getBody();

        ResponseEntity<ValidateResponse> response = rest.postForEntity(
                "/api/auth/validate", new ValidateRequest(login.token()), ValidateResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().username()).isEqualTo(username);
        assertThat(response.getBody().degraded()).isFalse();
    }

    @Test
    void logoutInvalidaElTokenYUnaValidacionPosteriorFalla() {
        String username = uniqueUsername("out");
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);
        LoginResponse login = rest.postForEntity(
                "/api/auth/login", new LoginRequest(username, "password123"), LoginResponse.class).getBody();

        ResponseEntity<Void> logoutResponse = rest.postForEntity(
                "/api/auth/logout", new ValidateRequest(login.token()), Void.class);
        assertThat(logoutResponse.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        ResponseEntity<String> validateResponse = rest.postForEntity(
                "/api/auth/validate", new ValidateRequest(login.token()), String.class);
        assertThat(validateResponse.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void diagnosticsExponeElEstadoOperativoDelSistema() {
        ResponseEntity<String> response = rest.getForEntity("/api/diagnostics", String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody())
                .contains("circuitBreakerState")
                .contains("cachedSessions")
                .contains("lockoutPolicy")
                .contains("features");
    }
}
