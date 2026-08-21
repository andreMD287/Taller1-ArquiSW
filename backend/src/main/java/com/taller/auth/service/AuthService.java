package com.taller.auth.service;

import java.time.Instant;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.taller.auth.dto.LogoutResponse;
import com.taller.auth.dto.TokenResponse;
import com.taller.auth.dto.ValidateResponse;
import com.taller.auth.exception.AccountLockedException;
import com.taller.auth.exception.AppException;
import com.taller.auth.exception.DataUnavailableException;
import com.taller.auth.exception.InvalidCredentialsException;
import com.taller.auth.exception.UserAlreadyExistsException;
import com.taller.auth.model.User;
import com.taller.auth.repository.UserRepository;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;

/**
 * Reglas de negocio de autenticacion. No conoce HTTP: los controladores
 * traducen DTOs de entrada/salida, esta clase decide.
 */
@Service
public class AuthService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final LockoutPolicy lockoutPolicy;
    private final TokenService tokenService;

    // hash de relleno: se verifica contra el aun cuando el usuario no existe,
    // para que un username inexistente pague el mismo costo de BCrypt que uno
    // real y no delate su ausencia por el tiempo de respuesta.
    private final String dummyHash;

    public AuthService(UserRepository userRepository, PasswordEncoder passwordEncoder,
                        LockoutPolicy lockoutPolicy, TokenService tokenService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.lockoutPolicy = lockoutPolicy;
        this.tokenService = tokenService;
        this.dummyHash = passwordEncoder.encode("no-existe-relleno-de-tiempo");
    }

    @CircuitBreaker(name = "dataTier", fallbackMethod = "registerFallback")
    @Transactional
    public String register(String username, String rawPassword) {
        if (userRepository.existsByUsername(username)) {
            throw new UserAlreadyExistsException();
        }
        User user = new User(username, passwordEncoder.encode(rawPassword));
        try {
            userRepository.save(user);
        } catch (DataIntegrityViolationException e) {
            // dos registros concurrentes con el mismo username: la carrera la
            // gana la restriccion UNIQUE de la base, no un chequeo en memoria.
            throw new UserAlreadyExistsException();
        }
        return user.getUsername();
    }

    @SuppressWarnings("unused")
    private String registerFallback(String username, String rawPassword, Throwable t) {
        // Resilience4j manda CUALQUIER excepcion al fallback, no solo fallas
        // reales de infraestructura: un AppException (ej. usuario duplicado,
        // EXPECTED) debe propagarse tal cual, nunca disfrazarse de 503.
        if (t instanceof AppException appException) {
            throw appException;
        }
        throw new DataUnavailableException(t);
    }

    // noRollbackFor es obligatorio: por defecto Spring revierte la transaccion
    // ante CUALQUIER RuntimeException, y AppException/InvalidCredentialsException
    // lo es. Sin esto, el UPDATE que registra un intento fallido se deshace justo
    // al lanzar la excepcion, y la cuenta nunca llega a bloquearse (ESC-D5 roto).
    @CircuitBreaker(name = "dataTier", fallbackMethod = "loginFallback")
    @Transactional(noRollbackFor = AppException.class)
    public TokenResponse login(String username, String rawPassword) {
        User user = userRepository.findByUsernameAndActiveTrue(username).orElse(null);
        Instant now = Instant.now();

        if (user == null) {
            // no revelar si el usuario existe: se paga el mismo costo de hash.
            passwordEncoder.matches(rawPassword, dummyHash);
            throw new InvalidCredentialsException();
        }
        if (lockoutPolicy.isLocked(user, now)) {
            throw new AccountLockedException(lockoutPolicy.secondsRemaining(user, now));
        }
        if (!passwordEncoder.matches(rawPassword, user.getPasswordHash())) {
            lockoutPolicy.registerFailure(user, now);
            userRepository.save(user);
            throw new InvalidCredentialsException();
        }

        lockoutPolicy.registerSuccess(user);
        userRepository.save(user);
        TokenService.TokenPair pair = tokenService.issue(user);
        return toResponse(pair);
    }

    @SuppressWarnings("unused")
    private TokenResponse loginFallback(String username, String rawPassword, Throwable t) {
        // misma razon que en registerFallback: credenciales invalidas o cuenta
        // bloqueada (EXPECTED) no son una caida del tier de datos.
        if (t instanceof AppException appException) {
            throw appException;
        }
        throw new DataUnavailableException(t);
    }

    // Sin @CircuitBreaker: validar un JWT es una verificacion de firma en
    // memoria (TokenService.validateAccessToken), nunca toca el tier de
    // datos. Es exactamente la garantia que pide la Fase 1.
    public ValidateResponse validate(String token) {
        TokenService.AccessClaims claims = tokenService.validateAccessToken(token);
        return new ValidateResponse(claims.username(), claims.expiresAt());
    }

    public TokenResponse refresh(String refreshToken) {
        return toResponse(tokenService.refresh(refreshToken));
    }

    public LogoutResponse logout(String refreshToken) {
        TokenService.RevokeResult result = tokenService.revokeRefreshToken(refreshToken);
        return new LogoutResponse(result.revoked(), result.note());
    }

    private static TokenResponse toResponse(TokenService.TokenPair pair) {
        return new TokenResponse(pair.accessToken(), pair.refreshToken(), pair.username(),
                pair.accessExpiresAt(), pair.refreshExpiresAt());
    }
}
