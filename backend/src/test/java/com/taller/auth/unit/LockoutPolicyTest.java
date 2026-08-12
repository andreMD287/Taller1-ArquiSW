package com.taller.auth.unit;

import com.taller.auth.model.User;
import com.taller.auth.service.LockoutPolicy;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

// Sin Spring: LockoutPolicy es logica de dominio pura, se instancia a mano.
class LockoutPolicyTest {

    private static final int MAX_ATTEMPTS = 5;
    private static final long LOCKOUT_SECONDS = 60;

    private LockoutPolicy policy;
    private User user;
    private Instant now;

    @BeforeEach
    void setUp() {
        policy = new LockoutPolicy(MAX_ATTEMPTS, LOCKOUT_SECONDS);
        user = new User("alice", "hash");
        now = Instant.now();
    }

    @Test
    void unaCuentaNuevaNoEstaBloqueada() {
        assertThat(policy.isLocked(user, now)).isFalse();
    }

    @Test
    void intentosFallidosPorDebajoDelUmbralNoBloquean() {
        for (int i = 0; i < MAX_ATTEMPTS - 1; i++) {
            policy.registerFailure(user, now);
        }
        assertThat(user.getFailedAttempts()).isEqualTo(MAX_ATTEMPTS - 1);
        assertThat(policy.isLocked(user, now)).isFalse();
    }

    @Test
    void alcanzarElUmbralBloqueaLaCuentaPorElTiempoConfigurado() {
        for (int i = 0; i < MAX_ATTEMPTS; i++) {
            policy.registerFailure(user, now);
        }
        assertThat(policy.isLocked(user, now)).isTrue();
        assertThat(policy.secondsRemaining(user, now)).isEqualTo(LOCKOUT_SECONDS);
    }

    @Test
    void elBloqueoExpiraPasadoElTiempoConfigurado() {
        for (int i = 0; i < MAX_ATTEMPTS; i++) {
            policy.registerFailure(user, now);
        }
        Instant despuesDelBloqueo = now.plusSeconds(LOCKOUT_SECONDS + 1);
        assertThat(policy.isLocked(user, despuesDelBloqueo)).isFalse();
    }

    @Test
    void unLoginExitosoLimpiaElContadorYElBloqueoVigente() {
        for (int i = 0; i < MAX_ATTEMPTS; i++) {
            policy.registerFailure(user, now);
        }
        policy.registerSuccess(user);
        assertThat(user.getFailedAttempts()).isZero();
        assertThat(policy.isLocked(user, now)).isFalse();
    }
}
