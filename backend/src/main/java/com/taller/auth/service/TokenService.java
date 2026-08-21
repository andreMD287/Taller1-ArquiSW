package com.taller.auth.service;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;
import java.util.Date;
import java.util.HexFormat;
import java.util.UUID;

import javax.crypto.SecretKey;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.taller.auth.exception.AppException;
import com.taller.auth.exception.DataUnavailableException;
import com.taller.auth.exception.InvalidSessionException;
import com.taller.auth.model.RefreshTokenEntity;
import com.taller.auth.model.Role;
import com.taller.auth.model.User;
import com.taller.auth.repository.RefreshTokenRepository;
import com.taller.auth.repository.UserRepository;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;

/**
 * Emision, validacion y revocacion de sesiones.
 *
 * El access token es un JWT firmado que se valida completamente en memoria.
 * El refresh token si se persiste porque debe ser revocable.
 */
@Service
public class TokenService {

    private static final Logger log = LoggerFactory.getLogger(TokenService.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String ISSUER = "auth-service";

    private static final String DEV_INSECURE_SECRET =
            "dev-only-insecure-secret-DO-NOT-USE-IN-PRODUCTION-please-32bytes+";

    private final RefreshTokenRepository refreshTokenRepository;
    private final UserRepository userRepository;
    private final SecretKey signingKey;
    private final long accessTtlSeconds;
    private final long refreshTtlSeconds;

    public TokenService(
            RefreshTokenRepository refreshTokenRepository,
            UserRepository userRepository,
            @Value("${app.jwt.secret:}") String configuredSecret,
            @Value("${app.jwt.access-ttl-seconds}") long accessTtlSeconds,
            @Value("${app.jwt.refresh-ttl-seconds}") long refreshTtlSeconds,
            Environment environment) {

        this.refreshTokenRepository = refreshTokenRepository;
        this.userRepository = userRepository;
        this.accessTtlSeconds = accessTtlSeconds;
        this.refreshTtlSeconds = refreshTtlSeconds;

        this.signingKey = Keys.hmacShaKeyFor(
                resolveSecret(configuredSecret, environment)
                        .getBytes(StandardCharsets.UTF_8)
        );
    }

    /**
     * En perfil docker la aplicacion no arranca sin un JWT_SECRET seguro.
     */
    private static String resolveSecret(String configured, Environment environment) {

        boolean isDockerProfile =
                Arrays.asList(environment.getActiveProfiles()).contains("docker");

        if (configured == null || configured.isBlank()) {

            if (isDockerProfile) {
                throw new IllegalStateException(
                        "JWT_SECRET no esta definido. La aplicacion se niega a arrancar "
                                + "en el perfil 'docker' sin un secreto explicito."
                );
            }

            log.warn(
                    "event=jwt_secret_dev_fallback perfil sin JWT_SECRET: "
                            + "usando clave insegura de desarrollo, NUNCA usar en produccion"
            );

            return DEV_INSECURE_SECRET;
        }

        if (configured.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException(
                    "JWT_SECRET debe tener al menos 32 bytes (256 bits) para HMAC-SHA256"
            );
        }

        return configured;
    }

    @CircuitBreaker(name = "dataTier", fallbackMethod = "issueFallback")
    @Transactional
    public TokenPair issue(User user) {

        Instant now = Instant.now();

        String accessToken = buildAccessToken(
                user.getId(),
                user.getUsername(),
                user.getRole(),
                now
        );

        RefreshTokenEntity refresh = persistRefreshToken(
                user.getId(),
                user.getUsername(),
                now
        );

        return new TokenPair(
                accessToken,
                refresh.getToken(),
                user.getUsername(),
                now.plusSeconds(accessTtlSeconds),
                refresh.getExpiresAt()
        );
    }

    @SuppressWarnings("unused")
    private TokenPair issueFallback(User user, Throwable t) {

        if (t instanceof AppException appException) {
            throw appException;
        }

        throw new DataUnavailableException(t);
    }

    /**
     * Valida firma, expiracion y claims del access token sin consultar la BD.
     */
    public AccessClaims validateAccessToken(String token) {

        try {
            Claims claims = Jwts.parser()
                    .verifyWith(signingKey)
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();

            String roleClaim = claims.get("role", String.class);

            if (roleClaim == null) {
                throw new IllegalArgumentException("JWT sin claim role");
            }

            Role role = Role.valueOf(roleClaim);

            return new AccessClaims(
                    Long.valueOf(claims.getSubject()),
                    claims.get("username", String.class),
                    role,
                    claims.getExpiration().toInstant()
            );

        } catch (JwtException | IllegalArgumentException e) {
            throw new InvalidSessionException();
        }
    }

    /**
     * El refresh consulta el usuario actual porque esta operacion ya depende
     * de PostgreSQL. Asi respeta cambios de username, role y active.
     */
    @CircuitBreaker(name = "dataTier", fallbackMethod = "refreshFallback")
    @Transactional
    public TokenPair refresh(String refreshTokenValue) {

        RefreshTokenEntity stored = refreshTokenRepository
                .findByToken(refreshTokenValue)
                .orElseThrow(InvalidSessionException::new);

        Instant now = Instant.now();

        refreshTokenRepository.deleteByToken(refreshTokenValue);

        if (stored.isExpired(now)) {
            throw new InvalidSessionException();
        }

        User user = userRepository
                .findByIdAndActiveTrue(stored.getUserId())
                .orElseThrow(InvalidSessionException::new);

        String accessToken = buildAccessToken(
                user.getId(),
                user.getUsername(),
                user.getRole(),
                now
        );

        RefreshTokenEntity newRefresh = persistRefreshToken(
                user.getId(),
                user.getUsername(),
                now
        );

        return new TokenPair(
                accessToken,
                newRefresh.getToken(),
                user.getUsername(),
                now.plusSeconds(accessTtlSeconds),
                newRefresh.getExpiresAt()
        );
    }

    @SuppressWarnings("unused")
    private TokenPair refreshFallback(String refreshTokenValue, Throwable t) {

        if (t instanceof AppException appException) {
            throw appException;
        }

        throw new DataUnavailableException(t);
    }

    @CircuitBreaker(
            name = "dataTier",
            fallbackMethod = "revokeRefreshTokenFallback"
    )
    @Transactional
    public RevokeResult revokeRefreshToken(String refreshTokenValue) {

        refreshTokenRepository.deleteByToken(refreshTokenValue);

        return new RevokeResult(true, null);
    }

    @SuppressWarnings("unused")
    private RevokeResult revokeRefreshTokenFallback(
            String refreshTokenValue,
            Throwable t) {

        if (t instanceof AppException appException) {
            throw appException;
        }

        log.atInfo()
                .addKeyValue("event", "logout_degraded")
                .log("logout_degraded");

        return new RevokeResult(
                false,
                "El tier de datos no esta disponible: el refresh token no se pudo revocar, "
                        + "pero el token de acceso expira solo en <= "
                        + accessTtlSeconds
                        + "s"
        );
    }

    private RefreshTokenEntity persistRefreshToken(
            Long userId,
            String username,
            Instant now) {

        RefreshTokenEntity entity = new RefreshTokenEntity(
                generateOpaqueToken(),
                userId,
                username,
                now,
                now.plusSeconds(refreshTtlSeconds)
        );

        return refreshTokenRepository.save(entity);
    }

    /**
     * El subject usa el ID porque es inmutable.
     * El role viaja firmado para poder autorizar sin consultar PostgreSQL.
     */
    private String buildAccessToken(
            Long userId,
            String username,
            Role role,
            Instant now) {

        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("username", username)
                .claim("role", role.name())
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

    public record TokenPair(
            String accessToken,
            String refreshToken,
            String username,
            Instant accessExpiresAt,
            Instant refreshExpiresAt) {
    }

    public record AccessClaims(
            Long userId,
            String username,
            Role role,
            Instant expiresAt) {
    }

    public record RevokeResult(
            boolean revoked,
            String note) {
    }
}