package com.taller.auth.service;

import com.taller.auth.exception.DataUnavailableException;
import com.taller.auth.exception.InvalidSessionException;
import com.taller.auth.model.SessionEntity;
import com.taller.auth.model.User;
import com.taller.auth.repository.SessionRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Emision, validacion e invalidacion de sesiones. El tier de datos es la
 * fuente de verdad; una cache local en memoria solo entra en juego cuando
 * Postgres no responde (tactica "Graceful Degradation", Cap. 4), detras del
 * feature toggle features.session-cache. La purga periodica y el heartbeat
 * viven en SessionMaintenanceTask para que esta clase no crezca mas alla de
 * una responsabilidad.
 */
@Service
public class TokenService {

    private static final Logger log = LoggerFactory.getLogger(TokenService.class);
    private static final SecureRandom RANDOM = new SecureRandom();

    private final SessionRepository sessionRepository;
    private final long ttlSeconds;
    private final boolean sessionCacheEnabled;

    private final Map<String, CachedSession> localCache = new ConcurrentHashMap<>();

    public TokenService(SessionRepository sessionRepository,
                         @Value("${app.session.ttl-seconds}") long ttlSeconds,
                         @Value("${features.session-cache}") boolean sessionCacheEnabled) {
        this.sessionRepository = sessionRepository;
        this.ttlSeconds = ttlSeconds;
        this.sessionCacheEnabled = sessionCacheEnabled;
    }

    // INSERT no idempotente: solo Circuit Breaker, nunca Retry a ciegas sobre esto.
    @CircuitBreaker(name = "dataTier", fallbackMethod = "createSessionFallback")
    @Transactional
    public SessionEntity createSession(User user) {
        String token = generateToken();
        Instant now = Instant.now();
        SessionEntity session = new SessionEntity(token, user.getId(), user.getUsername(), now, now.plusSeconds(ttlSeconds));
        sessionRepository.save(session);
        cacheLocally(session);
        return session;
    }

    @SuppressWarnings("unused")
    private SessionEntity createSessionFallback(User user, Throwable t) {
        // mitad de la degradacion parcial: si el tier de datos esta caido no se
        // pueden emitir sesiones nuevas. La otra mitad es que las sesiones YA
        // emitidas se sigan validando (ver validateFallback).
        throw new DataUnavailableException(t);
    }

    // SELECT: operacion idempotente, se puede reintentar con seguridad.
    @Retry(name = "dataTier", fallbackMethod = "validateFallback")
    @CircuitBreaker(name = "dataTier")
    public ValidateResult validate(String token) {
        SessionEntity session = sessionRepository.findByToken(token)
                .orElseThrow(InvalidSessionException::new);
        if (session.isExpired(Instant.now())) {
            throw new InvalidSessionException();
        }
        cacheLocally(session);
        return new ValidateResult(session.getUsername(), session.getExpiresAt(), false);
    }

    @SuppressWarnings("unused")
    private ValidateResult validateFallback(String token, Throwable t) {
        if (!sessionCacheEnabled) {
            throw new DataUnavailableException(t);
        }
        CachedSession cached = localCache.get(token);
        if (cached == null || cached.expiresAt().isBefore(Instant.now())) {
            // ni la cache tiene algo util: no hay forma de distinguir "sesion
            // invalida" de "tier de datos caido", asi que se reporta lo unico
            // que el cliente puede accionar: reintentar mas tarde.
            throw new DataUnavailableException(t);
        }
        log.atInfo().addKeyValue("event", "degraded_validate").log("degraded_validate");
        return new ValidateResult(cached.username(), cached.expiresAt(), true);
    }

    // DELETE por token: reintentarlo es seguro, borrar dos veces da el mismo resultado.
    @Retry(name = "dataTier")
    @CircuitBreaker(name = "dataTier", fallbackMethod = "invalidateFallback")
    @Transactional
    public void invalidate(String token) {
        sessionRepository.deleteByToken(token);
        localCache.remove(token);
    }

    @SuppressWarnings("unused")
    private void invalidateFallback(String token, Throwable t) {
        // logout es best-effort si el tier de datos esta caido: al menos se
        // limpia la cache local para que este nodo deje de aceptar ese token.
        localCache.remove(token);
    }

    public int cachedSessionCount() {
        return localCache.size();
    }

    /** Usado por SessionMaintenanceTask: la purga en BD y en cache van de la mano. */
    public void evictExpiredFromCache(Instant now) {
        localCache.values().removeIf(c -> c.expiresAt().isBefore(now));
    }

    private void cacheLocally(SessionEntity session) {
        if (sessionCacheEnabled) {
            localCache.put(session.getToken(), new CachedSession(session.getUsername(), session.getExpiresAt()));
        }
    }

    private static String generateToken() {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    private record CachedSession(String username, Instant expiresAt) {
    }

    public record ValidateResult(String username, Instant expiresAt, boolean degraded) {
    }
}
