package com.taller.auth.service;

import com.taller.auth.repository.RefreshTokenRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

/**
 * Tareas de fondo del ciclo de vida de los refresh tokens, separadas de
 * TokenService para que ninguna de las dos clases mezcle mas de una
 * responsabilidad:
 *
 * - purga: una tabla de refresh tokens que crece sin cota es una falta
 *   latente clasica, funciona meses y un dia degrada el servicio. A
 *   diferencia de la purga de sesiones que existia antes, esta NO esta en
 *   el camino critico de ninguna peticion (el token de acceso ya no toca
 *   la BD), asi que puede correr con un intervalo mas relajado.
 * - heartbeat (Cap. 4): confirma en el log que el nodo sigue vivo; el id
 *   de nodo lo agrega el JsonLogEncoder, no hace falta repetirlo aqui.
 */
@Component
public class RefreshTokenMaintenanceTask {

    private static final Logger log = LoggerFactory.getLogger(RefreshTokenMaintenanceTask.class);

    private final RefreshTokenRepository refreshTokenRepository;

    public RefreshTokenMaintenanceTask(RefreshTokenRepository refreshTokenRepository) {
        this.refreshTokenRepository = refreshTokenRepository;
    }

    @Scheduled(fixedRateString = "${app.jwt.purge-interval-ms}")
    @Transactional
    public void purgeExpiredRefreshTokens() {
        try {
            int deleted = refreshTokenRepository.deleteExpiredBefore(Instant.now());
            if (deleted > 0) {
                log.atInfo().addKeyValue("event", "refresh_tokens_purged").addKeyValue("count", deleted)
                        .log("refresh_tokens_purged");
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
