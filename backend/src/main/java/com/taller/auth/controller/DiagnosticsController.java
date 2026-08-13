package com.taller.auth.controller;

import com.taller.auth.service.LockoutPolicy;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Panel de estado para la demo en clase y el informe: expone lo que
 * probe.sh y chaos-kill.sh no pueden ver desde afuera (estado interno del
 * circuit breaker, politica de bloqueo, toggles activos).
 *
 * Desde la Fase 1 ya no hay una cache local de sesiones que reportar: el
 * token de acceso se valida en memoria via firma JWT, no via una cache que
 * pueda estar vacia o llena.
 */
@RestController
@RequestMapping("/api/diagnostics")
public class DiagnosticsController {

    private final CircuitBreakerRegistry circuitBreakerRegistry;
    private final LockoutPolicy lockoutPolicy;
    private final boolean newDashboardEnabled;

    public DiagnosticsController(CircuitBreakerRegistry circuitBreakerRegistry,
                                  LockoutPolicy lockoutPolicy,
                                  @Value("${features.new-dashboard}") boolean newDashboardEnabled) {
        this.circuitBreakerRegistry = circuitBreakerRegistry;
        this.lockoutPolicy = lockoutPolicy;
        this.newDashboardEnabled = newDashboardEnabled;
    }

    @GetMapping
    public DiagnosticsResponse diagnostics() {
        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker("dataTier");
        return new DiagnosticsResponse(
                cb.getState().name(),
                cb.getMetrics().getFailureRate(),
                new LockoutInfo(lockoutPolicy.getMaxAttempts(), lockoutPolicy.getLockoutSeconds()),
                new FeatureToggles(newDashboardEnabled)
        );
    }

    public record DiagnosticsResponse(String circuitBreakerState, float circuitBreakerFailureRate,
                                       LockoutInfo lockoutPolicy, FeatureToggles features) {
    }

    public record LockoutInfo(int maxAttempts, long lockoutSeconds) {
    }

    public record FeatureToggles(boolean newDashboard) {
    }
}
