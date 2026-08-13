package com.taller.auth.integration;

import com.taller.auth.dto.LoginRequest;
import com.taller.auth.dto.LogoutResponse;
import com.taller.auth.dto.RefreshTokenRequest;
import com.taller.auth.dto.RegisterRequest;
import com.taller.auth.dto.RegisterResponse;
import com.taller.auth.dto.TokenResponse;
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

    private TokenResponse registerAndLogin(String username) {
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);
        return rest.postForEntity(
                "/api/auth/login", new LoginRequest(username, "password123"), TokenResponse.class).getBody();
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
    void loginConCredencialesValidasDevuelveUnParDeTokens() {
        String username = uniqueUsername("login");
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);

        ResponseEntity<TokenResponse> response = rest.postForEntity(
                "/api/auth/login", new LoginRequest(username, "password123"), TokenResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().accessToken()).isNotBlank();
        assertThat(response.getBody().refreshToken()).isNotBlank();
        assertThat(response.getBody().username()).isEqualTo(username);
    }

    @Test
    void validateConUnAccessTokenValidoLoConfirma() {
        String username = uniqueUsername("val");
        TokenResponse login = registerAndLogin(username);

        ResponseEntity<ValidateResponse> response = rest.postForEntity(
                "/api/auth/validate", new ValidateRequest(login.accessToken()), ValidateResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().username()).isEqualTo(username);
    }

    @Test
    void refreshRotaElParDeTokensYElAccessTokenNuevoValida() {
        String username = uniqueUsername("ref");
        TokenResponse login = registerAndLogin(username);

        ResponseEntity<TokenResponse> refreshed = rest.postForEntity(
                "/api/auth/refresh", new RefreshTokenRequest(login.refreshToken()), TokenResponse.class);

        assertThat(refreshed.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(refreshed.getBody().refreshToken()).isNotEqualTo(login.refreshToken());

        ResponseEntity<ValidateResponse> validated = rest.postForEntity(
                "/api/auth/validate", new ValidateRequest(refreshed.getBody().accessToken()), ValidateResponse.class);
        assertThat(validated.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void refreshConElTokenYaRotadoEsRechazado() {
        String username = uniqueUsername("rot");
        TokenResponse login = registerAndLogin(username);
        rest.postForEntity("/api/auth/refresh", new RefreshTokenRequest(login.refreshToken()), TokenResponse.class);

        ResponseEntity<String> segundoUso = rest.postForEntity(
                "/api/auth/refresh", new RefreshTokenRequest(login.refreshToken()), String.class);

        assertThat(segundoUso.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void logoutRevocaElRefreshTokenYUnRefreshPosteriorFalla() {
        String username = uniqueUsername("out");
        TokenResponse login = registerAndLogin(username);

        ResponseEntity<LogoutResponse> logoutResponse = rest.postForEntity(
                "/api/auth/logout", new RefreshTokenRequest(login.refreshToken()), LogoutResponse.class);
        assertThat(logoutResponse.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(logoutResponse.getBody().revoked()).isTrue();

        ResponseEntity<String> refreshPosterior = rest.postForEntity(
                "/api/auth/refresh", new RefreshTokenRequest(login.refreshToken()), String.class);
        assertThat(refreshPosterior.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void logoutNoInvalidaElAccessTokenTodaviaVigente() {
        // trade-off documentado: el access token sigue siendo valido hasta que
        // expira por su cuenta, revocar el refresh token no lo afecta.
        String username = uniqueUsername("stillvalid");
        TokenResponse login = registerAndLogin(username);
        rest.postForEntity("/api/auth/logout", new RefreshTokenRequest(login.refreshToken()), LogoutResponse.class);

        ResponseEntity<ValidateResponse> response = rest.postForEntity(
                "/api/auth/validate", new ValidateRequest(login.accessToken()), ValidateResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void diagnosticsExponeElEstadoOperativoDelSistema() {
        ResponseEntity<String> response = rest.getForEntity("/api/diagnostics", String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody())
                .contains("circuitBreakerState")
                .contains("lockoutPolicy")
                .contains("features");
    }
}
