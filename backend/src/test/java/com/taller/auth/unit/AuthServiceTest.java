package com.taller.auth.unit;

import com.taller.auth.dto.LoginResponse;
import com.taller.auth.exception.AccountLockedException;
import com.taller.auth.exception.InvalidCredentialsException;
import com.taller.auth.exception.UserAlreadyExistsException;
import com.taller.auth.model.SessionEntity;
import com.taller.auth.model.User;
import com.taller.auth.repository.UserRepository;
import com.taller.auth.service.AuthService;
import com.taller.auth.service.LockoutPolicy;
import com.taller.auth.service.TokenService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

// PasswordEncoder y LockoutPolicy son reales (son deterministas y baratos);
// solo se simulan las puertas al tier de datos (UserRepository) y TokenService.
@ExtendWith(MockitoExtension.class)
class AuthServiceTest {

    @Mock
    private UserRepository userRepository;

    @Mock
    private TokenService tokenService;

    private PasswordEncoder passwordEncoder;
    private AuthService authService;

    @BeforeEach
    void setUp() {
        passwordEncoder = new BCryptPasswordEncoder();
        LockoutPolicy lockoutPolicy = new LockoutPolicy(5, 60);
        authService = new AuthService(userRepository, passwordEncoder, lockoutPolicy, tokenService);
    }

    @Test
    void registerGuardaElUsuarioConLaPasswordHasheada() {
        when(userRepository.existsByUsername("alice")).thenReturn(false);

        String username = authService.register("alice", "password123");

        assertThat(username).isEqualTo("alice");
        verify(userRepository).save(argThat(u -> passwordEncoder.matches("password123", u.getPasswordHash())));
    }

    @Test
    void registerRechazaUnUsernameQueYaExiste() {
        when(userRepository.existsByUsername("alice")).thenReturn(true);

        assertThatThrownBy(() -> authService.register("alice", "password123"))
                .isInstanceOf(UserAlreadyExistsException.class);
        verify(userRepository, never()).save(any());
    }

    @Test
    void registerConvierteUnaCarreraDeInsertsConcurrentesEnUserAlreadyExists() {
        when(userRepository.existsByUsername("alice")).thenReturn(false);
        when(userRepository.save(any())).thenThrow(new DataIntegrityViolationException("uq_users_username"));

        assertThatThrownBy(() -> authService.register("alice", "password123"))
                .isInstanceOf(UserAlreadyExistsException.class);
    }

    @Test
    void loginConCredencialesCorrectasCreaUnaSesionYLimpiaElContadorDeFallos() {
        User user = new User("alice", passwordEncoder.encode("password123"));
        user.setFailedAttempts(3);
        when(userRepository.findByUsername("alice")).thenReturn(Optional.of(user));
        SessionEntity session = new SessionEntity("tok", 1L, "alice", Instant.now(), Instant.now().plusSeconds(1800));
        when(tokenService.createSession(user)).thenReturn(session);

        LoginResponse response = authService.login("alice", "password123");

        assertThat(response.token()).isEqualTo("tok");
        assertThat(user.getFailedAttempts()).isZero();
        verify(userRepository).save(user);
    }

    @Test
    void loginConPasswordIncorrectaRegistraElFalloYNoCreaSesion() {
        User user = new User("alice", passwordEncoder.encode("password123"));
        when(userRepository.findByUsername("alice")).thenReturn(Optional.of(user));

        assertThatThrownBy(() -> authService.login("alice", "otra-cosa"))
                .isInstanceOf(InvalidCredentialsException.class);

        assertThat(user.getFailedAttempts()).isEqualTo(1);
        verify(tokenService, never()).createSession(any());
    }

    @Test
    void loginConUsuarioInexistenteNoRevelaSuAusenciaYNoTocaElTierDeDatosParaEscritura() {
        when(userRepository.findByUsername("fantasma")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> authService.login("fantasma", "cualquiera"))
                .isInstanceOf(InvalidCredentialsException.class);

        // mismo tipo de excepcion que una password incorrecta: el cliente no
        // puede distinguir "no existe" de "existe pero la clave esta mal".
        verify(userRepository, times(0)).save(any());
        verify(tokenService, never()).createSession(any());
    }

    @Test
    void loginConCuentaBloqueadaRechazaAntesDeMirarLaPassword() {
        User user = new User("alice", passwordEncoder.encode("password123"));
        for (int i = 0; i < 5; i++) {
            user.setFailedAttempts(user.getFailedAttempts() + 1);
        }
        user.setLockedUntil(Instant.now().plusSeconds(60));
        when(userRepository.findByUsername("alice")).thenReturn(Optional.of(user));

        // incluso con la password CORRECTA, la cuenta bloqueada rechaza el intento.
        assertThatThrownBy(() -> authService.login("alice", "password123"))
                .isInstanceOf(AccountLockedException.class);

        verify(tokenService, never()).createSession(any());
    }

    @Test
    void validateYLogoutDelegantEnTokenService() {
        SessionEntity session = new SessionEntity("tok", 1L, "alice", Instant.now(), Instant.now().plusSeconds(1800));
        when(tokenService.validate("tok"))
                .thenReturn(new TokenService.ValidateResult("alice", session.getExpiresAt(), false));

        authService.validate("tok");
        authService.logout("tok");

        verify(tokenService).validate("tok");
        verify(tokenService).invalidate("tok");
    }
}
