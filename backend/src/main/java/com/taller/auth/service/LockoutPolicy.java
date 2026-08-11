package com.taller.auth.service;

import com.taller.auth.model.User;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;

/**
 * Tactica "Increase Competence Set" (Cap. 4): en vez de dejar que un ataque
 * de fuerza bruta agote recursos o credenciales, el sistema lo modela como
 * un estado previsto (cuenta bloqueada temporalmente) y lo contiene.
 *
 * Logica de dominio pura sobre el estado de un User: no conoce HTTP ni toca
 * el repositorio directamente, eso es responsabilidad de AuthService.
 */
@Component
public class LockoutPolicy {

    private final int maxAttempts;
    private final long lockoutSeconds;

    public LockoutPolicy(
            @Value("${app.lockout.max-attempts}") int maxAttempts,
            @Value("${app.lockout.lockout-seconds}") long lockoutSeconds) {
        this.maxAttempts = maxAttempts;
        this.lockoutSeconds = lockoutSeconds;
    }

    public boolean isLocked(User user, Instant now) {
        return user.getLockedUntil() != null && now.isBefore(user.getLockedUntil());
    }

    public long secondsRemaining(User user, Instant now) {
        if (!isLocked(user, now)) {
            return 0;
        }
        return Duration.between(now, user.getLockedUntil()).getSeconds();
    }

    /** Registra un intento fallido; bloquea la cuenta si se alcanzo el umbral. */
    public void registerFailure(User user, Instant now) {
        user.setFailedAttempts(user.getFailedAttempts() + 1);
        if (user.getFailedAttempts() >= maxAttempts) {
            user.setLockedUntil(now.plusSeconds(lockoutSeconds));
        }
    }

    /** Login exitoso: se limpia el contador y cualquier bloqueo vigente. */
    public void registerSuccess(User user) {
        user.setFailedAttempts(0);
        user.setLockedUntil(null);
    }

    public int getMaxAttempts() {
        return maxAttempts;
    }

    public long getLockoutSeconds() {
        return lockoutSeconds;
    }
}
