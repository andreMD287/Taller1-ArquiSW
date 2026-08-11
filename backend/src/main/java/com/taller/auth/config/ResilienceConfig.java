package com.taller.auth.config;

import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;

/**
 * Monitor (Cap. 4): cada transicion del circuit breaker del tier de datos
 * queda en el log JSON. Sin esto no se puede correlacionar una caida de
 * Postgres con el instante exacto en que el sistema dejo de insistir.
 */
@Configuration
public class ResilienceConfig {

    private static final Logger log = LoggerFactory.getLogger(ResilienceConfig.class);

    public ResilienceConfig(CircuitBreakerRegistry registry) {
        registry.circuitBreaker("dataTier").getEventPublisher().onStateTransition(event ->
                log.atInfo()
                        .addKeyValue("event", "circuit_breaker_state_change")
                        .addKeyValue("from", event.getStateTransition().getFromState())
                        .addKeyValue("to", event.getStateTransition().getToState())
                        .log("circuit_breaker_state_change"));
    }
}
