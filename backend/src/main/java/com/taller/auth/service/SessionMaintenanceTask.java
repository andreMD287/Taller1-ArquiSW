package com.taller.auth.service;

import com.taller.auth.repository.SessionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

/**
 * Tareas de fondo del ciclo de vida de sesiones, separadas de TokenService
 * para que ninguna de las dos clases mezcle mas de una responsabilidad:
 *
 * - purga: una tabla de sesiones que crece sin cota es una falta latente
 *   clasica, funciona meses y un dia degrada el servicio.
 * - heartbeat (Cap. 4): confirma en el log que el nodo sigue vivo; el id
 *   de nodo lo agrega el JsonLogEncoder, no hace falta repetirlo aqui.
 */
@Component
public class SessionMaintenanceTask {

    private static final Logger log = LoggerFactory.getLogger(SessionMaintenanceTask.class);

    private final SessionRepository sessionRepository;
    private final TokenService tokenService;

    public SessionMaintenanceTask(SessionRepository sessionRepository, TokenService tokenService) {
        this.sessionRepository = sessionRepository;
        this.tokenService = tokenService;
    }

    @Scheduled(fixedRateString = "${app.session.purge-interval-ms}")
    @Transactional
    public void purgeExpiredSessions() {
        try {
            Instant now = Instant.now();
            int deleted = sessionRepository.deleteExpiredBefore(now);
            tokenService.evictExpiredFromCache(now);
            if (deleted > 0) {
                log.atInfo().addKeyValue("event", "sessions_purged").addKeyValue("count", deleted).log("sessions_purged");
            }
        } catch (Exception e) {
            // mantenimiento de fondo: si el tier de datos esta caido se salta
            // este ciclo en vez de propagar el error hacia arriba.
            log.warn("event=purge_skipped reason={}", e.getMessage());
        }
    }

    @Scheduled(fixedRate = 30000)
    public void heartbeat() {
        log.atInfo().addKeyValue("event", "heartbeat").log("heartbeat");
    }
}
