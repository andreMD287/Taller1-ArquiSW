package com.taller.auth.unit;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import static org.mockito.ArgumentMatchers.any;
import org.mockito.Mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.env.MockEnvironment;

import com.taller.auth.exception.InvalidSessionException;
import com.taller.auth.model.RefreshTokenEntity;
import com.taller.auth.model.Role;
import com.taller.auth.model.User;
import com.taller.auth.repository.RefreshTokenRepository;
import com.taller.auth.repository.UserRepository;
import com.taller.auth.service.TokenService;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;

// @CircuitBreaker/@Retry solo se tejen con un contexto de Spring real (ver
// AvailabilityIT); aqui se prueba la logica de negocio de TokenService en
// aislamiento, instanciandolo directamente con repositorios simulados.
@ExtendWith(MockitoExtension.class)
class TokenServiceTest {

    private static final long ACCESS_TTL_SECONDS = 900;
    private static final long REFRESH_TTL_SECONDS = 604800;

    private static final String SECRET =
            "unit-test-secret-key-at-least-32-bytes-long-ok";

    @Mock
    private RefreshTokenRepository refreshTokenRepository;

    @Mock
    private UserRepository userRepository;

    private TokenService tokenService;
    private User user;

    @BeforeEach
    void setUp() {
        MockEnvironment environment = new MockEnvironment();

        tokenService = new TokenService(
                refreshTokenRepository,
                userRepository,
                SECRET,
                ACCESS_TTL_SECONDS,
                REFRESH_TTL_SECONDS,
                environment
        );

        user = new User("bob", "hash");
        setId(user, 1L);
        user.setRole(Role.USER);
    }

    @Test
    void issueGeneraUnJwtVerificableEnMemoriaSinRepetirLaConsulta() {
        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        TokenService.TokenPair pair = tokenService.issue(user);

        assertThat(pair.accessToken()).isNotBlank();
        assertThat(pair.username()).isEqualTo("bob");
        assertThat(pair.accessExpiresAt())
                .isAfter(Instant.now().plusSeconds(ACCESS_TTL_SECONDS - 5));

        TokenService.AccessClaims claims =
                tokenService.validateAccessToken(pair.accessToken());

        assertThat(claims.username()).isEqualTo("bob");
        assertThat(claims.role()).isEqualTo(Role.USER);

        verify(refreshTokenRepository).save(any());
    }

    @Test
    void issuePersisteElRefreshTokenConElTtlConfigurado() {
        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        Instant before = Instant.now();

        TokenService.TokenPair pair = tokenService.issue(user);

        assertThat(pair.refreshToken()).hasSize(64);
        assertThat(pair.refreshExpiresAt())
                .isAfter(before.plusSeconds(REFRESH_TTL_SECONDS - 5));
    }

    @Test
    void issueIncluyeElRolAdminEnElJwt() {
        user.setRole(Role.ADMIN);

        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        String accessToken = tokenService.issue(user).accessToken();

        TokenService.AccessClaims claims =
                tokenService.validateAccessToken(accessToken);

        assertThat(claims.role()).isEqualTo(Role.ADMIN);
    }

    @Test
    void elSubjectDelJwtEsElIdDelUsuarioNoSuUsername() {
        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        String accessToken = tokenService.issue(user).accessToken();

        String subject = Jwts.parser()
                .verifyWith(
                        Keys.hmacShaKeyFor(
                                SECRET.getBytes(StandardCharsets.UTF_8)
                        )
                )
                .build()
                .parseSignedClaims(accessToken)
                .getPayload()
                .getSubject();

        assertThat(subject).isEqualTo("1");

        TokenService.AccessClaims claims =
                tokenService.validateAccessToken(accessToken);

        assertThat(claims.userId()).isEqualTo(1L);
        assertThat(claims.username()).isEqualTo("bob");
        assertThat(claims.role()).isEqualTo(Role.USER);
    }

    @Test
    void unTokenEmitidoSigueSiendoValidoDespuesDeQueElUsuarioCambieDeUsername() {
        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        String accessToken = tokenService.issue(user).accessToken();

        User renombrado = new User("bob-el-nuevo", "hash");
        setId(renombrado, 1L);

        TokenService.AccessClaims claims =
                tokenService.validateAccessToken(accessToken);

        assertThat(claims.userId()).isEqualTo(renombrado.getId());
    }

    @Test
    void validateAccessTokenNoConsultaRepositorios() {
        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        String accessToken = tokenService.issue(user).accessToken();

        // Eliminamos del conteo la interaccion de issue(), porque esa sí
        // persiste el refresh token por diseño.
        org.mockito.Mockito.clearInvocations(refreshTokenRepository);

        tokenService.validateAccessToken(accessToken);

        verifyNoInteractions(userRepository);
        verifyNoInteractions(refreshTokenRepository);
    }

    @Test
    void unTokenDelFormatoAnteriorConUsernameEnElSubjectSeRechazaComoSesionInvalida() {
        String tokenViejo = Jwts.builder()
                .subject("bob")
                .claim("role", Role.USER.name())
                .expiration(Date.from(
                        Instant.now().plusSeconds(ACCESS_TTL_SECONDS)
                ))
                .signWith(
                        Keys.hmacShaKeyFor(
                                SECRET.getBytes(StandardCharsets.UTF_8)
                        ),
                        Jwts.SIG.HS256
                )
                .compact();

        assertThatThrownBy(
                () -> tokenService.validateAccessToken(tokenViejo)
        ).isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void validateAccessTokenRechazaJwtSinRole() {
        String tokenSinRole = Jwts.builder()
                .subject("1")
                .claim("username", "bob")
                .expiration(Date.from(
                        Instant.now().plusSeconds(ACCESS_TTL_SECONDS)
                ))
                .signWith(
                        Keys.hmacShaKeyFor(
                                SECRET.getBytes(StandardCharsets.UTF_8)
                        ),
                        Jwts.SIG.HS256
                )
                .compact();

        assertThatThrownBy(
                () -> tokenService.validateAccessToken(tokenSinRole)
        ).isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void validateAccessTokenRechazaJwtConRoleInvalido() {
        String tokenConRoleInvalido = Jwts.builder()
                .subject("1")
                .claim("username", "bob")
                .claim("role", "SUPERUSER")
                .expiration(Date.from(
                        Instant.now().plusSeconds(ACCESS_TTL_SECONDS)
                ))
                .signWith(
                        Keys.hmacShaKeyFor(
                                SECRET.getBytes(StandardCharsets.UTF_8)
                        ),
                        Jwts.SIG.HS256
                )
                .compact();

        assertThatThrownBy(
                () -> tokenService.validateAccessToken(tokenConRoleInvalido)
        ).isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void validateAccessTokenRechazaUnTokenMalFormado() {
        assertThatThrownBy(
                () -> tokenService.validateAccessToken("esto-no-es-un-jwt")
        ).isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void validateAccessTokenRechazaUnTokenFirmadoConOtraClave() {
        MockEnvironment environment = new MockEnvironment();

        TokenService otroServicio = new TokenService(
                refreshTokenRepository,
                userRepository,
                "otra-clave-completamente-distinta-de-32-bytes+",
                ACCESS_TTL_SECONDS,
                REFRESH_TTL_SECONDS,
                environment
        );

        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        String tokenAjeno = otroServicio.issue(user).accessToken();

        assertThatThrownBy(
                () -> tokenService.validateAccessToken(tokenAjeno)
        ).isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void refreshRotaElTokenYRevocaElAnterior() {
        RefreshTokenEntity almacenado = new RefreshTokenEntity(
                "viejo-token",
                1L,
                "bob",
                Instant.now(),
                Instant.now().plusSeconds(REFRESH_TTL_SECONDS)
        );

        when(refreshTokenRepository.findByToken("viejo-token"))
                .thenReturn(Optional.of(almacenado));

        when(userRepository.findByIdAndActiveTrue(1L))
                .thenReturn(Optional.of(user));

        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        TokenService.TokenPair nuevo =
                tokenService.refresh("viejo-token");

        assertThat(nuevo.username()).isEqualTo("bob");
        assertThat(nuevo.refreshToken())
                .isNotEqualTo("viejo-token");

        verify(refreshTokenRepository)
                .deleteByToken("viejo-token");
    }

    @Test
    void refreshUsaUsernameYRoleActualesDelUsuario() {
        RefreshTokenEntity almacenado = new RefreshTokenEntity(
                "refresh-viejo",
                1L,
                "bob-antiguo",
                Instant.now(),
                Instant.now().plusSeconds(REFRESH_TTL_SECONDS)
        );

        User actualizado = new User("bob-nuevo", "hash");
        setId(actualizado, 1L);
        actualizado.setRole(Role.ADMIN);

        when(refreshTokenRepository.findByToken("refresh-viejo"))
                .thenReturn(Optional.of(almacenado));

        when(userRepository.findByIdAndActiveTrue(1L))
                .thenReturn(Optional.of(actualizado));

        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

        TokenService.TokenPair nuevo =
                tokenService.refresh("refresh-viejo");

        TokenService.AccessClaims claims =
                tokenService.validateAccessToken(nuevo.accessToken());

        assertThat(nuevo.username()).isEqualTo("bob-nuevo");
        assertThat(claims.username()).isEqualTo("bob-nuevo");
        assertThat(claims.role()).isEqualTo(Role.ADMIN);
    }

    @Test
    void refreshRechazaUsuarioInactivoONoEncontrado() {
        RefreshTokenEntity almacenado = new RefreshTokenEntity(
                "refresh-inactivo",
                1L,
                "bob",
                Instant.now(),
                Instant.now().plusSeconds(REFRESH_TTL_SECONDS)
        );

        when(refreshTokenRepository.findByToken("refresh-inactivo"))
                .thenReturn(Optional.of(almacenado));

        when(userRepository.findByIdAndActiveTrue(1L))
                .thenReturn(Optional.empty());

        assertThatThrownBy(
                () -> tokenService.refresh("refresh-inactivo")
        ).isInstanceOf(InvalidSessionException.class);

        verify(refreshTokenRepository, never())
                .save(any());
    }

    @Test
    void refreshRechazaUnTokenQueNoExiste() {
        when(refreshTokenRepository.findByToken("no-existe"))
                .thenReturn(Optional.empty());

        assertThatThrownBy(
                () -> tokenService.refresh("no-existe")
        ).isInstanceOf(InvalidSessionException.class);
    }

    @Test
    void refreshRechazaUnRefreshTokenExpirado() {
        RefreshTokenEntity expirado = new RefreshTokenEntity(
                "vencido",
                1L,
                "bob",
                Instant.now().minusSeconds(REFRESH_TTL_SECONDS * 2),
                Instant.now().minusSeconds(1)
        );

        when(refreshTokenRepository.findByToken("vencido"))
                .thenReturn(Optional.of(expirado));

        assertThatThrownBy(
                () -> tokenService.refresh("vencido")
        ).isInstanceOf(InvalidSessionException.class);

        verify(userRepository, never())
                .findByIdAndActiveTrue(any());
    }

    @Test
    void revokeRefreshTokenBorraElTokenDelRepositorio() {
        TokenService.RevokeResult result =
                tokenService.revokeRefreshToken("algun-token");

        assertThat(result.revoked()).isTrue();

        verify(refreshTokenRepository)
                .deleteByToken("algun-token");
    }

    @Test
    void unSecretoDeMenosDe32BytesNoArranca() {
        MockEnvironment environment = new MockEnvironment();

        assertThatThrownBy(
                () -> new TokenService(
                        refreshTokenRepository,
                        userRepository,
                        "muy-corto",
                        ACCESS_TTL_SECONDS,
                        REFRESH_TTL_SECONDS,
                        environment
                )
        ).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void sinSecretoYConPerfilDockerActivoNoArranca() {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("docker");

        assertThatThrownBy(
                () -> new TokenService(
                        refreshTokenRepository,
                        userRepository,
                        "",
                        ACCESS_TTL_SECONDS,
                        REFRESH_TTL_SECONDS,
                        environment
                )
        ).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void sinSecretoYSinPerfilDockerUsaUnaClaveDeDesarrolloYArranca() {
        MockEnvironment environment = new MockEnvironment();

        TokenService dev = new TokenService(
                refreshTokenRepository,
                userRepository,
                "",
                ACCESS_TTL_SECONDS,
                REFRESH_TTL_SECONDS,
                environment
        );

        when(refreshTokenRepository.save(any()))
                .thenAnswer(inv -> inv.getArgument(0));

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