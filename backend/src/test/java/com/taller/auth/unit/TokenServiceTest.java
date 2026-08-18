package com.taller.auth.unit;

import com.taller.auth.exception.InvalidSessionException;
import com.taller.auth.model.RefreshTokenEntity;
import com.taller.auth.model.User;
import com.taller.auth.repository.RefreshTokenRepository;
import com.taller.auth.service.TokenService;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.env.MockEnvironment;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

// @CircuitBreaker/@Retry solo se tejen con un contexto de Spring real (ver
// AvailabilityIT); aqui se prueba la logica de negocio de TokenService en
// aislamiento, instanciandolo directamente con un repositorio simulado.
@ExtendWith(MockitoExtension.class)
class TokenServiceTest {

    private static final long ACCESS_TTL_SECONDS = 900;
    private static final long REFRESH_TTL_SECONDS = 604800;
    private static final String SECRET = "unit-test-secret-key-at-least-32-bytes-long-ok";

    @Mock
    private RefreshTokenRepository refreshTokenRepository;

    private TokenService tokenService;
    private User user;

    @BeforeEach
    void setUp() {
        MockEnvironment environment = new MockEnvironment();
        // sin perfil "docker" activo: se permite operar con un secreto propio.
        tokenService = new TokenService(refreshTokenRepository, SECRET, ACCESS_TTL_SECONDS,
                REFRESH_TTL_SECONDS, environment);
        user = new User("bob", "hash");
        setId(user, 1L);
    }

    @Test
    void issueGeneraUnJwtVerificableEnMemoriaSinRepetirLaConsulta() {
        when(refreshTokenRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        TokenService.TokenPair pair = tokenService.issue(user);

        assertThat(pair.accessToken()).isNotBlank();
        assertThat(pair.username()).isEqualTo("bob");
        assertThat(pair.accessExpiresAt()).isAfter(Instant.now().plusSeconds(ACCESS_TTL_SECONDS - 5));

        // la validacion NUNCA llama al repositorio: es pura verificacion de firma en memoria.
        TokenService.AccessClaims claims = tokenService.validateAccessToken(pair.accessToken());
        assertThat(claims.username()).isEqualTo("bob");
        verify(refreshTokenRepository).save(any());
    }

    @Test
    void issuePersisteElRefreshTokenConElTtlConfigurado() {
        when(refreshTokenRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        Instant before = Instant.now();

        TokenService.TokenPair pair = tokenService.issue(user);

        assertThat(pair.refreshToken()).hasSize(64); // 32 bytes en hex = 64 caracteres
        assertThat(pair.refreshExpiresAt()).isAfter(before.plusSeconds(REFRESH_TTL_SECONDS - 5));
    }

    // Taller 2: el subject debe ser el ID, porque el username es mutable. Si
    // alguien revierte buildAccessToken a .subject(username), este test cae.
    @Test
    void elSubjectDelJwtEsElIdDelUsuarioNoSuUsername() {
        when(refreshTokenRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        String accessToken = tokenService.issue(user).accessToken();

        String subject = Jwts.parser().verifyWith(Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8)))
                .build().parseSignedClaims(accessToken).getPayload().getSubject();
        assertThat(subject).isEqualTo("1");

        TokenService.AccessClaims claims = tokenService.validateAccessToken(accessToken);
        assertThat(claims.userId()).isEqualTo(1L);
        assertThat(claims.username()).isEqualTo("bob");
    }

    // La razon de ser del cambio: cambiar el username no debe invalidar los
    // tokens ya emitidos, porque no es la identidad que el token transporta.
    @Test
    void unTokenEmitidoSigueSiendoValidoDespuesDeQueElUsuarioCambieDeUsername() {
        when(refreshTokenRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        String accessToken = tokenService.issue(user).accessToken();

        User renombrado = new User("bob-el-nuevo", "hash");
        setId(renombrado, 1L);

        TokenService.AccessClaims claims = tokenService.validateAccessToken(accessToken);
        assertThat(claims.userId()).isEqualTo(renombrado.getId());
    }

    // Un token del formato anterior (subject = username) debe rechazarse como
    // sesion invalida, no reventar con NumberFormatException -> 500.
    @Test
    void unTokenDelFormatoAnteriorConUsernameEnElSubjectSeRechazaComoSesionInvalida() {
        String tokenViejo = Jwts.builder()
                .subject("bob")
                .expiration(Date.from(Instant.now().plusSeconds(ACCESS_TTL_SECONDS)))
                .signWith(Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8)), Jwts.SIG.HS256)
                .compact();

        assertThatThrownBy(() -> tokenService.validateAccessToken(tokenViejo))
                .isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void validateAccessTokenRechazaUnTokenMalFormado() {
        assertThatThrownBy(() -> tokenService.validateAccessToken("esto-no-es-un-jwt"))
                .isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void validateAccessTokenRechazaUnTokenFirmadoConOtraClave() {
        MockEnvironment environment = new MockEnvironment();
        TokenService otroServicio = new TokenService(refreshTokenRepository,
                "otra-clave-completamente-distinta-de-32-bytes+", ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS,
                environment);
        when(refreshTokenRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        String tokenAjeno = otroServicio.issue(user).accessToken();

        assertThatThrownBy(() -> tokenService.validateAccessToken(tokenAjeno))
                .isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void refreshRotaElTokenYRevocaElAnterior() {
        RefreshTokenEntity almacenado = new RefreshTokenEntity("viejo-token", 1L, "bob",
                Instant.now(), Instant.now().plusSeconds(REFRESH_TTL_SECONDS));
        when(refreshTokenRepository.findByToken("viejo-token")).thenReturn(Optional.of(almacenado));
        when(refreshTokenRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        TokenService.TokenPair nuevo = tokenService.refresh("viejo-token");

        assertThat(nuevo.username()).isEqualTo("bob");
        assertThat(nuevo.refreshToken()).isNotEqualTo("viejo-token");
        verify(refreshTokenRepository).deleteByToken("viejo-token");
    }

    @Test
    void refreshRechazaUnTokenQueNoExiste() {
        when(refreshTokenRepository.findByToken("no-existe")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> tokenService.refresh("no-existe"))
                .isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void refreshRechazaUnRefreshTokenExpirado() {
        RefreshTokenEntity expirado = new RefreshTokenEntity("vencido", 1L, "bob",
                Instant.now().minusSeconds(REFRESH_TTL_SECONDS * 2), Instant.now().minusSeconds(1));
        when(refreshTokenRepository.findByToken("vencido")).thenReturn(Optional.of(expirado));

        assertThatThrownBy(() -> tokenService.refresh("vencido"))
                .isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void revokeRefreshTokenBorraElTokenDelRepositorio() {
        TokenService.RevokeResult result = tokenService.revokeRefreshToken("algun-token");

        assertThat(result.revoked()).isTrue();
        verify(refreshTokenRepository).deleteByToken("algun-token");
    }

    @Test
    void unSecretoDeMenosDe32BytesNoArranca() {
        MockEnvironment environment = new MockEnvironment();
        assertThatThrownBy(() -> new TokenService(refreshTokenRepository, "muy-corto",
                ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, environment))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void sinSecretoYConPerfilDockerActivoNoArranca() {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("docker");

        assertThatThrownBy(() -> new TokenService(refreshTokenRepository, "",
                ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, environment))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void sinSecretoYSinPerfilDockerUsaUnaClaveDeDesarrolloYArranca() {
        MockEnvironment environment = new MockEnvironment();

        TokenService dev = new TokenService(refreshTokenRepository, "", ACCESS_TTL_SECONDS,
                REFRESH_TTL_SECONDS, environment);

        when(refreshTokenRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        assertThat(dev.issue(user).accessToken()).isNotBlank();
    }

    private static void setId(User user, Long id) {
        try {
            var field = User.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(user, id);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }
}
