package com.taller.auth.controller;

import com.taller.auth.service.LockoutPolicy;
import com.taller.auth.service.TokenService;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Panel de estado para la demo en clase y el informe: expone lo que
 * probe.sh y chaos-kill.sh no pueden ver desde afuera (estado interno del
 * circuit breaker, tamano de la cache de sesiones, toggles activos).
 */
@RestController
@RequestMapping("/api/diagnostics")
public class DiagnosticsController {

    private final CircuitBreakerRegistry circuitBreakerRegistry;
    private final TokenService tokenService;
    private final LockoutPolicy lockoutPolicy;
    private final boolean sessionCacheEnabled;
    private final boolean newDashboardEnabled;

    public DiagnosticsController(CircuitBreakerRegistry circuitBreakerRegistry,
                                  TokenService tokenService,
                                  LockoutPolicy lockoutPolicy,
                                  @Value("${features.session-cache}") boolean sessionCacheEnabled,
                                  @Value("${features.new-dashboard}") boolean newDashboardEnabled) {
        this.circuitBreakerRegistry = circuitBreakerRegistry;
        this.tokenService = tokenService;
        this.lockoutPolicy = lockoutPolicy;
        this.sessionCacheEnabled = sessionCacheEnabled;
        this.newDashboardEnabled = newDashboardEnabled;
    }

    @GetMapping
    public DiagnosticsResponse diagnostics() {
        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker("dataTier");
        return new DiagnosticsResponse(
                cb.getState().name(),
                cb.getMetrics().getFailureRate(),
                tokenService.cachedSessionCount(),
                new LockoutInfo(lockoutPolicy.getMaxAttempts(), lockoutPolicy.getLockoutSeconds()),
                new FeatureToggles(sessionCacheEnabled, newDashboardEnabled)
        );
    }

    public record DiagnosticsResponse(String circuitBreakerState, float circuitBreakerFailureRate,
                                       int cachedSessions, LockoutInfo lockoutPolicy,
                                       FeatureToggles features) {
    }

    public record LockoutInfo(int maxAttempts, long lockoutSeconds) {
    }

    public record FeatureToggles(boolean sessionCache, boolean newDashboard) {
    }
}
