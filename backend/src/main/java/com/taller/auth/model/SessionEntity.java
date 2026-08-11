package com.taller.auth.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * Sesion persistida en el tier de datos. El username va denormalizado junto
 * al userId para que "validate" pueda resolverse con una sola fila, sin join,
 * cuando se sirve desde la cache local en modo degradado.
 *
 * createdAt / expiresAt son el timestamp de la tactica "Timestamp" (Cap. 4):
 * permiten detectar estado obsoleto sin depender de un reloj externo.
 */
@Entity
@Table(name = "sessions")
public class SessionEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 64)
    private String token;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(nullable = false, length = 50)
    private String username;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    protected SessionEntity() {
        // requerido por JPA
    }

    public SessionEntity(String token, Long userId, String username, Instant createdAt, Instant expiresAt) {
        this.token = token;
        this.userId = userId;
        this.username = username;
        this.createdAt = createdAt;
        this.expiresAt = expiresAt;
    }

    public Long getId() {
        return id;
    }

    public String getToken() {
        return token;
    }

    public Long getUserId() {
        return userId;
    }

    public String getUsername() {
        return username;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public boolean isExpired(Instant now) {
        return now.isAfter(expiresAt);
    }
}
