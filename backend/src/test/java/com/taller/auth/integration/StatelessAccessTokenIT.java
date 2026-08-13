package com.taller.auth.integration;

import com.taller.auth.dto.LoginRequest;
import com.taller.auth.dto.RegisterRequest;
import com.taller.auth.dto.RegisterResponse;
import com.taller.auth.dto.TokenResponse;
import com.taller.auth.dto.ValidateRequest;
import com.taller.auth.dto.ValidateResponse;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;

import javax.sql.DataSource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Criterio de terminado de la Fase 1: con el tier de datos caido,
 * /api/auth/validate sigue respondiendo 200. Aqui se simula la caida
 * cerrando el pool de conexiones directamente (equivalente en efecto a
 * "docker compose stop postgres" para el proposito de esta prueba), en vez
 * de depender de un Postgres real en el pipeline de tests.
 *
 * @DirtiesContext fuerza a Spring a descartar este contexto tras la clase:
 * cerrar el DataSource aqui no debe filtrarse a las demas IT, que si
 * necesitan una base de datos viva.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class StatelessAccessTokenIT {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private DataSource dataSource;

    @Test
    void validateSigueRespondiendo200ConElTierDeDatosCaido() {
        String username = "stateless" + System.nanoTime();
        rest.postForEntity("/api/auth/register", new RegisterRequest(username, "password123"), RegisterResponse.class);
        TokenResponse login = rest.postForEntity(
                "/api/auth/login", new LoginRequest(username, "password123"), TokenResponse.class).getBody();

        // apaga el tier de datos: el JWT ya emitido debe seguir siendo
        // verificable, porque su validacion es enteramente en memoria.
        ((HikariDataSource) dataSource).close();

        ResponseEntity<ValidateResponse> response = rest.postForEntity(
                "/api/auth/validate", new ValidateRequest(login.accessToken()), ValidateResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().username()).isEqualTo(username);
    }
}
