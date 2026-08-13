package com.taller.auth.service;

import com.taller.auth.exception.AppException;
import com.taller.auth.exception.DataUnavailableException;
import com.taller.auth.exception.InvalidSessionException;
import com.taller.auth.model.RefreshTokenEntity;
import com.taller.auth.model.User;
import com.taller.auth.repository.RefreshTokenRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;
import java.util.Date;
import java.util.HexFormat;
import java.util.UUID;

/**
 * Emision, validacion y revocacion de sesiones.
 *
 * DECISION CENTRAL DE LA FASE 1: el token de acceso es un JWT firmado
 * (HMAC-SHA256) y se valida ENTERAMENTE EN MEMORIA (verificacion de firma +
 * expiracion), sin tocar el tier de datos. Antes, "validate" -que es ~95%
 * del trafico- consultaba Postgres en cada llamada, metiendo a la BD en el
 * camino critico de casi toda peticion y acotando la disponibilidad del
 * sistema a la de la BD. Con esto, el 95% del trafico queda con
 * disponibilidad = disponibilidad del tier de logica, sin mas.
 *
 * TRADE-OFF ACEPTADO: un JWT no se puede revocar antes de que expire sin
 * volver a introducir estado compartido (una lista de revocacion en Redis
 * reintroduce el mismo problema con otro nombre). Se acepta una ventana de
 * revocacion de hasta accessTtlSeconds (15 min por defecto) a cambio de
 * sacar la BD del camino critico. El refresh token si se persiste y si es
 * revocable: es de vida larga (7 dias) y de bajo volumen (5% del trafico,
 * solo en /login y /refresh), asi que puede pagar el costo de una consulta.
 */
@Service
public class TokenService {

    private static final Logger log = LoggerFactory.getLogger(TokenService.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String ISSUER = "auth-service";
    // Unicamente para perfiles que no son "docker": permite `./mvnw spring-boot:run`
    // o pruebas locales sin exigirle a cada desarrollador que exporte JWT_SECRET.
    // 64 caracteres ASCII = 64 bytes, muy por encima del minimo de 32 bytes de HS256.
    private static final String DEV_INSECURE_SECRET =
            "dev-only-insecure-secret-DO-NOT-USE-IN-PRODUCTION-please-32bytes+";

    private final RefreshTokenRepository refreshTokenRepository;
    private final SecretKey signingKey;
    private final long accessTtlSeconds;
    private final long refreshTtlSeconds;

    public TokenService(RefreshTokenRepository refreshTokenRepository,
                         @Value("${app.jwt.secret:}") String configuredSecret,
                         @Value("${app.jwt.access-ttl-seconds}") long accessTtlSeconds,
                         @Value("${app.jwt.refresh-ttl-seconds}") long refreshTtlSeconds,
                         Environment environment) {
        this.refreshTokenRepository = refreshTokenRepository;
        this.accessTtlSeconds = accessTtlSeconds;
        this.refreshTtlSeconds = refreshTtlSeconds;
        this.signingKey = Keys.hmacShaKeyFor(resolveSecret(configuredSecret, environment).getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Tactica "Exception Prevention" (Cap. 4): una clave de JWT por defecto
     * en un despliegue real permitiria a cualquiera forjar tokens validos.
     * Es preferible que el proceso se niegue a arrancar a que arranque
     * inseguro en silencio.
     */
    private static String resolveSecret(String configured, Environment environment) {
        boolean isDockerProfile = Arrays.asList(environment.getActiveProfiles()).contains("docker");
        if (configured == null || configured.isBlank()) {
            if (isDockerProfile) {
                throw new IllegalStateException(
                        "JWT_SECRET no esta definido. La aplicacion se niega a arrancar en el perfil "
                                + "'docker' sin un secreto explicito (Exception Prevention, Cap. 4).");
            }
            log.warn("event=jwt_secret_dev_fallback perfil sin JWT_SECRET: usando clave insegura de "
                    + "desarrollo, NUNCA usar en produccion");
            return DEV_INSECURE_SECRET;
        }
        if (configured.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException("JWT_SECRET debe tener al menos 32 bytes (256 bits) para HMAC-SHA256");
        }
        return configured;
    }

    // Emitir toca la BD (persiste el refresh token): unico punto del ciclo de
    // sesion donde el tier de datos sigue en el camino critico, y a proposito
    // solo para el 5% del trafico que es login.
    @CircuitBreaker(name = "dataTier", fallbackMethod = "issueFallback")
    @Transactional
    public TokenPair issue(User user) {
        Instant now = Instant.now();
        String accessToken = buildAccessToken(user.getUsername(), now);
        RefreshTokenEntity refresh = persistRefreshToken(user.getId(), user.getUsername(), now);
        return new TokenPair(accessToken, refresh.getToken(), user.getUsername(),
                now.plusSeconds(accessTtlSeconds), refresh.getExpiresAt());
    }

    @SuppressWarnings("unused")
    private TokenPair issueFallback(User user, Throwable t) {
        if (t instanceof AppException appException) {
            throw appException;
        }
        throw new DataUnavailableException(t);
    }

    /**
     * Verificacion de firma + expiracion en memoria. CERO dependencia del
     * tier de datos: esta es la razon de ser de la Fase 1.
     */
    public AccessClaims validateAccessToken(String token) {
        try {
            Claims claims = Jwts.parser().verifyWith(signingKey).build()
                    .parseSignedClaims(token)
                    .getPayload();
            return new AccessClaims(claims.getSubject(), claims.getExpiration().toInstant());
        } catch (JwtException | IllegalArgumentException e) {
            // firma invalida, token mal formado o expirado: EXPECTED, no es
            // una caida de nada, es la definicion misma de "sesion invalida".
            throw new InvalidSessionException();
        }
    }

    // Rotacion: el refresh token usado se invalida al canjearlo por uno nuevo,
    // limitando el impacto de un refresh token capturado (Limit Exposure, Cap. 4).
    @CircuitBreaker(name = "dataTier", fallbackMethod = "refreshFallback")
    @Transactional
    public TokenPair refresh(String refreshTokenValue) {
        RefreshTokenEntity stored = refreshTokenRepository.findByToken(refreshTokenValue)
                .orElseThrow(InvalidSessionException::new);
        Instant now = Instant.now();
        refreshTokenRepository.deleteByToken(refreshTokenValue);
        if (stored.isExpired(now)) {
            throw new InvalidSessionException();
        }
        String accessToken = buildAccessToken(stored.getUsername(), now);
        RefreshTokenEntity newRefresh = persistRefreshToken(stored.getUserId(), stored.getUsername(), now);
        return new TokenPair(accessToken, newRefresh.getToken(), stored.getUsername(),
                now.plusSeconds(accessTtlSeconds), newRefresh.getExpiresAt());
    }

    @SuppressWarnings("unused")
    private TokenPair refreshFallback(String refreshTokenValue, Throwable t) {
        if (t instanceof AppException appException) {
            throw appException;
        }
        throw new DataUnavailableException(t);
    }

    // DELETE por token: reintentarlo es seguro, borrar dos veces da el mismo
    // resultado. Logout es best-effort si el tier de datos esta caido: el
    // token de acceso de todas formas expira solo dentro de accessTtlSeconds.
    @CircuitBreaker(name = "dataTier", fallbackMethod = "revokeRefreshTokenFallback")
    @Transactional
    public RevokeResult revokeRefreshToken(String refreshTokenValue) {
        refreshTokenRepository.deleteByToken(refreshTokenValue);
        return new RevokeResult(true, null);
    }

    @SuppressWarnings("unused")
    private RevokeResult revokeRefreshTokenFallback(String refreshTokenValue, Throwable t) {
        if (t instanceof AppException appException) {
            throw appException;
        }
        log.atInfo().addKeyValue("event", "logout_degraded").log("logout_degraded");
        return new RevokeResult(false,
                "El tier de datos no esta disponible: el refresh token no se pudo revocar, pero el "
                        + "token de acceso expira solo en <= " + accessTtlSeconds + "s");
    }

    private RefreshTokenEntity persistRefreshToken(Long userId, String username, Instant now) {
        RefreshTokenEntity entity = new RefreshTokenEntity(
                generateOpaqueToken(), userId, username, now, now.plusSeconds(refreshTtlSeconds));
        return refreshTokenRepository.save(entity);
    }

    private String buildAccessToken(String username, Instant now) {
        return Jwts.builder()
                .subject(username)
                .id(UUID.randomUUID().toString())
                .issuer(ISSUER)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(accessTtlSeconds)))
                .signWith(signingKey, Jwts.SIG.HS256)
                .compact();
    }

    private static String generateOpaqueToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    public record TokenPair(String accessToken, String refreshToken, String username,
                             Instant accessExpiresAt, Instant refreshExpiresAt) {
    }

    public record AccessClaims(String username, Instant expiresAt) {
    }

    public record RevokeResult(boolean revoked, String note) {
    }
}
