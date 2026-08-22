package com.taller.auth.integration;

import java.math.BigDecimal;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import com.taller.auth.dto.LoginRequest;
import com.taller.auth.dto.RegisterRequest;
import com.taller.auth.dto.RegisterResponse;
import com.taller.auth.dto.TokenResponse;
import com.taller.auth.model.Role;
import com.taller.auth.model.User;
import com.taller.auth.product.api.ProductRequest;
import com.taller.auth.product.api.ProductResponse;
import com.taller.auth.repository.UserRepository;

/**
 * Pruebas de integracion de autenticacion y autorizacion sobre productos.
 *
 * A diferencia de ProductControllerTest, estas pruebas levantan el contexto
 * real de Spring Security para verificar JwtAuthenticationFilter,
 * SecurityContext y @PreAuthorize trabajando juntos.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class ProductSecurityIT {

    private static final String PASSWORD = "password123";

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private UserRepository userRepository;

    private String unique(String prefix) {
        return prefix + System.nanoTime();
    }

    private TokenResponse registerAndLoginUser() {
        String username = unique("user");

        rest.postForEntity(
                "/api/auth/register",
                new RegisterRequest(username, PASSWORD),
                RegisterResponse.class
        );

        return rest.postForEntity(
                "/api/auth/login",
                new LoginRequest(username, PASSWORD),
                TokenResponse.class
        ).getBody();
    }

    private TokenResponse registerAndLoginAdmin() {
        String username = unique("admin");

        rest.postForEntity(
                "/api/auth/register",
                new RegisterRequest(username, PASSWORD),
                RegisterResponse.class
        );

        User user = userRepository.findByUsername(username)
                .orElseThrow();

        user.setRole(Role.ADMIN);
        userRepository.save(user);

        return rest.postForEntity(
                "/api/auth/login",
                new LoginRequest(username, PASSWORD),
                TokenResponse.class
        ).getBody();
    }

    private HttpHeaders bearerHeaders(String accessToken) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(accessToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    @Test
    void listadoSinJwtEsRechazado() {
        ResponseEntity<String> response =
                rest.getForEntity("/api/products", String.class);

        assert response.getStatusCode() == HttpStatus.UNAUTHORIZED;
    }

    @Test
    void usuarioAutenticadoPuedeConsultarProductos() {
        TokenResponse login = registerAndLoginUser();

        ResponseEntity<String> response = rest.exchange(
                "/api/products",
                HttpMethod.GET,
                new HttpEntity<>(bearerHeaders(login.accessToken())),
                String.class
        );

        assert response.getStatusCode() == HttpStatus.OK;
    }

    @Test
    void usuarioNormalNoPuedeCrearProductos() {
        TokenResponse login = registerAndLoginUser();

        ProductRequest request = new ProductRequest(
                unique("Teclado"),
                new BigDecimal("19.99"),
                10
        );

        ResponseEntity<String> response = rest.exchange(
                "/api/products",
                HttpMethod.POST,
                new HttpEntity<>(request, bearerHeaders(login.accessToken())),
                String.class
        );

        assert response.getStatusCode() == HttpStatus.FORBIDDEN;
    }

    @Test
    void adminPuedeCrearProductos() {
        TokenResponse login = registerAndLoginAdmin();

        ProductRequest request = new ProductRequest(
                unique("Monitor"),
                new BigDecimal("499.99"),
                5
        );

        ResponseEntity<ProductResponse> response = rest.exchange(
                "/api/products",
                HttpMethod.POST,
                new HttpEntity<>(request, bearerHeaders(login.accessToken())),
                ProductResponse.class
        );

        assert response.getStatusCode() == HttpStatus.CREATED;
        assert response.getBody() != null;
    }

    @Test
    void usuarioNormalNoPuedeEliminarProductos() {
        TokenResponse admin = registerAndLoginAdmin();

        ProductRequest request = new ProductRequest(
                unique("Mouse"),
                new BigDecimal("59.99"),
                20
        );

        ResponseEntity<ProductResponse> created = rest.exchange(
                "/api/products",
                HttpMethod.POST,
                new HttpEntity<>(request, bearerHeaders(admin.accessToken())),
                ProductResponse.class
        );

        Long productId = created.getBody().id();

        TokenResponse user = registerAndLoginUser();

        ResponseEntity<Void> response = rest.exchange(
                "/api/products/" + productId,
                HttpMethod.DELETE,
                new HttpEntity<>(bearerHeaders(user.accessToken())),
                Void.class
        );

        assert response.getStatusCode() == HttpStatus.FORBIDDEN;
    }

    @Test
    void adminPuedeEliminarProductos() {
        TokenResponse admin = registerAndLoginAdmin();

        ProductRequest request = new ProductRequest(
                unique("Audifonos"),
                new BigDecimal("99.99"),
                8
        );

        ResponseEntity<ProductResponse> created = rest.exchange(
                "/api/products",
                HttpMethod.POST,
                new HttpEntity<>(request, bearerHeaders(admin.accessToken())),
                ProductResponse.class
        );

        Long productId = created.getBody().id();

        ResponseEntity<Void> response = rest.exchange(
                "/api/products/" + productId,
                HttpMethod.DELETE,
                new HttpEntity<>(bearerHeaders(admin.accessToken())),
                Void.class
        );

        assert response.getStatusCode() == HttpStatus.NO_CONTENT;
    }

    @Test
    void jwtInvalidoEsRechazado() {
        ResponseEntity<String> response = rest.exchange(
                "/api/products",
                HttpMethod.GET,
                new HttpEntity<>(bearerHeaders("esto-no-es-un-jwt")),
                String.class
        );

        assert response.getStatusCode() == HttpStatus.UNAUTHORIZED;
    }
}