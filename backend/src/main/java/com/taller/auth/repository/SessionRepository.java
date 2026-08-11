package com.taller.auth.repository;

import com.taller.auth.model.SessionEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Optional;

/**
 * Unica puerta de entrada al almacenamiento de sesiones.
 */
public interface SessionRepository extends JpaRepository<SessionEntity, Long> {

    Optional<SessionEntity> findByToken(String token);

    void deleteByToken(String token);

    long countByExpiresAtAfter(Instant now);

    /**
     * Purga de sesiones expiradas: una tabla que crece sin cota es una falta
     * latente clasica (funciona meses y un dia degrada el servicio). El
     * @Scheduled que invoca esto vive en el servicio, no aqui.
     */
    @Modifying
    @Query("delete from SessionEntity s where s.expiresAt < :now")
    int deleteExpiredBefore(@Param("now") Instant now);
}
