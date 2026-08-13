package com.taller.auth.repository;

import com.taller.auth.model.RefreshTokenEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Optional;

/**
 * Unica puerta de entrada al almacenamiento de refresh tokens.
 */
public interface RefreshTokenRepository extends JpaRepository<RefreshTokenEntity, Long> {

    Optional<RefreshTokenEntity> findByToken(String token);

    void deleteByToken(String token);

    /**
     * Purga de refresh tokens expirados: misma falta latente clasica que la
     * tabla de sesiones tenia antes (crece sin cota si nadie la limpia).
     */
    @Modifying
    @Query("delete from RefreshTokenEntity r where r.expiresAt < :now")
    int deleteExpiredBefore(@Param("now") Instant now);
}
