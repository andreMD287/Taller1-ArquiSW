package com.taller.auth.config;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;

/**
 * Sanity Checking / Self-Test (Cap. 4): un SELECT 1 con timeout corto para
 * confirmar que Postgres responde de verdad, no solo que el pool tiene
 * conexiones abiertas.
 *
 * DELIBERADAMENTE solo alimenta el grupo "readiness" (ver
 * management.endpoint.health.group.readiness.include en application.yml),
 * nunca "liveness": si liveness dependiera de Postgres, la caida del tier
 * de datos reiniciaria en cascada nodos del tier de logica que estan
 * perfectamente sanos. Punto de examen.
 */
@Component("dataTier")
public class DataTierHealthIndicator implements HealthIndicator {

    private final JdbcTemplate jdbcTemplate;

    public DataTierHealthIndicator(DataSource dataSource) {
        this.jdbcTemplate = new JdbcTemplate(dataSource);
        this.jdbcTemplate.setQueryTimeout(2);
    }

    @Override
    public Health health() {
        try {
            jdbcTemplate.queryForObject("SELECT 1", Integer.class);
            return Health.up().build();
        } catch (Exception e) {
            return Health.down(e).build();
        }
    }
}
