package com.taller.auth.unit;

import com.taller.auth.exception.InvalidSessionException;
import com.taller.auth.model.SessionEntity;
import com.taller.auth.model.User;
import com.taller.auth.repository.SessionRepository;
import com.taller.auth.service.TokenService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

// @CircuitBreaker/@Retry solo se tejen con un contexto de Spring real (ver
// AvailabilityIT); aqui se prueba la logica de negocio de TokenService en
// aislamiento, instanciandolo directamente con un repositorio simulado.
@ExtendWith(MockitoExtension.class)
class TokenServiceTest {

    private static final long TTL_SECONDS = 1800;

    @Mock
    private SessionRepository sessionRepository;

    private TokenService tokenServiceConCache;
    private TokenService tokenServiceSinCache;
    private User user;

    @BeforeEach
    void setUp() {
        tokenServiceConCache = new TokenService(sessionRepository, TTL_SECONDS, true);
        tokenServiceSinCache = new TokenService(sessionRepository, TTL_SECONDS, false);
        user = new User("bob", "hash");
    }

    @Test
    void createSessionGeneraUnTokenYCalculaLaExpiracionSegunElTtl() {
        Instant before = Instant.now();

        SessionEntity session = tokenServiceConCache.createSession(user);

        assertThat(session.getToken()).hasSize(48); // 24 bytes en hex = 48 caracteres
        assertThat(session.getUsername()).isEqualTo("bob");
        assertThat(session.getExpiresAt()).isAfter(before.plusSeconds(TTL_SECONDS - 5));
        verify(sessionRepository).save(session);
    }

    @Test
    void createSessionCacheaLocalmenteSoloSiElFeatureToggleEstaActivo() {
        tokenServiceConCache.createSession(user);
        assertThat(tokenServiceConCache.cachedSessionCount()).isEqualTo(1);

        tokenServiceSinCache.createSession(user);
        assertThat(tokenServiceSinCache.cachedSessionCount()).isZero();
    }

    @Test
    void validateDevuelveDatosDeSesionNoDegradadaCuandoElTokenEsValido() {
        SessionEntity session = new SessionEntity("tok123", 1L, "bob",
                Instant.now(), Instant.now().plusSeconds(TTL_SECONDS));
        when(sessionRepository.findByToken("tok123")).thenReturn(Optional.of(session));

        TokenService.ValidateResult result = tokenServiceConCache.validate("tok123");

        assertThat(result.username()).isEqualTo("bob");
        assertThat(result.degraded()).isFalse();
    }

    @Test
    void validateRechazaUnTokenQueNoExiste() {
        when(sessionRepository.findByToken("no-existe")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> tokenServiceConCache.validate("no-existe"))
                .isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void validateRechazaUnaSesionExpirada() {
        SessionEntity expirada = new SessionEntity("vencido", 1L, "bob",
                Instant.now().minusSeconds(TTL_SECONDS * 2), Instant.now().minusSeconds(1));
        when(sessionRepository.findByToken("vencido")).thenReturn(Optional.of(expirada));

        assertThatThrownBy(() -> tokenServiceConCache.validate("vencido"))
                .isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void invalidateBorraLaSesionDelRepositorioYDeLaCache() {
        SessionEntity session = tokenServiceConCache.createSession(user);
        assertThat(tokenServiceConCache.cachedSessionCount()).isEqualTo(1);

        tokenServiceConCache.invalidate(session.getToken());

        verify(sessionRepository).deleteByToken(session.getToken());
        assertThat(tokenServiceConCache.cachedSessionCount()).isZero();
    }

    @Test
    void evictExpiredFromCacheLimpiaSoloLasEntradasVencidas() {
        tokenServiceConCache.createSession(user);
        assertThat(tokenServiceConCache.cachedSessionCount()).isEqualTo(1);

        // el TTL es de 1800s: pedir la purga "ahora" no debe tocar nada todavia.
        tokenServiceConCache.evictExpiredFromCache(Instant.now());
        assertThat(tokenServiceConCache.cachedSessionCount()).isEqualTo(1);

        // pero pedirla "en el futuro" (tras el TTL) si debe vaciar la cache.
        tokenServiceConCache.evictExpiredFromCache(Instant.now().plusSeconds(TTL_SECONDS + 1));
        assertThat(tokenServiceConCache.cachedSessionCount()).isZero();
    }
}
