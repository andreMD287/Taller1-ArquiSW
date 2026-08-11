package com.taller.auth.controller;

import com.taller.auth.dto.LoginRequest;
import com.taller.auth.dto.LoginResponse;
import com.taller.auth.dto.RegisterRequest;
import com.taller.auth.dto.RegisterResponse;
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
    public ResponseEntity<LoginResponse> login(@Valid @RequestBody LoginRequest request) {
        return ResponseEntity.ok(authService.login(request.username(), request.password()));
    }

    @PostMapping("/validate")
    public ResponseEntity<ValidateResponse> validate(@Valid @RequestBody ValidateRequest request) {
        return ResponseEntity.ok(authService.validate(request.token()));
    }

    @PostMapping("/logout")
    public ResponseEntity<Void> logout(@Valid @RequestBody ValidateRequest request) {
        authService.logout(request.token());
        return ResponseEntity.noContent().build();
    }
}
