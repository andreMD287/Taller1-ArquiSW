package com.taller.auth.controller;

import com.taller.auth.dto.LoginRequest;
import com.taller.auth.dto.LogoutResponse;
import com.taller.auth.dto.RefreshTokenRequest;
import com.taller.auth.dto.RegisterRequest;
import com.taller.auth.dto.RegisterResponse;
import com.taller.auth.dto.TokenResponse;
import com.taller.auth.dto.ValidateRequest;
import com.taller.auth.dto.ValidateResponse;
import com.taller.auth.service.AuthService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Traduce HTTP hacia/desde el servicio. Sin logica de negocio aqui: eso
 * vive en AuthService/TokenService/LockoutPolicy.
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/register")
    public ResponseEntity<RegisterResponse> register(@Valid @RequestBody RegisterRequest request) {
        String username = authService.register(request.username(), request.password());
        return ResponseEntity.status(HttpStatus.CREATED).body(new RegisterResponse(username));
    }

    @PostMapping("/login")
    public ResponseEntity<TokenResponse> login(@Valid @RequestBody LoginRequest request) {
        return ResponseEntity.ok(authService.login(request.username(), request.password()));
    }

    // Canjea un refresh token vigente por un par nuevo (rotacion). El token
    // de acceso tiene un TTL corto (15 min por defecto) a proposito: este es
    // el endpoint que un cliente llama para renovarlo sin volver a pedir
    // usuario/password.
    @PostMapping("/refresh")
    public ResponseEntity<TokenResponse> refresh(@Valid @RequestBody RefreshTokenRequest request) {
        return ResponseEntity.ok(authService.refresh(request.refreshToken()));
    }

    // Verificacion en memoria (firma JWT), nunca toca el tier de datos.
    @PostMapping("/validate")
    public ResponseEntity<ValidateResponse> validate(@Valid @RequestBody ValidateRequest request) {
        return ResponseEntity.ok(authService.validate(request.token()));
    }

    // Best-effort: si el tier de datos esta caido, revoked=false y 202
    // Accepted en vez de fallar (ver TokenService.revokeRefreshTokenFallback).
    @PostMapping("/logout")
    public ResponseEntity<LogoutResponse> logout(@Valid @RequestBody RefreshTokenRequest request) {
        LogoutResponse result = authService.logout(request.refreshToken());
        HttpStatus status = result.revoked() ? HttpStatus.OK : HttpStatus.ACCEPTED;
        return ResponseEntity.status(status).body(result);
    }
}
