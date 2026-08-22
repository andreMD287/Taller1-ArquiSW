package com.taller.auth.controller;

import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.taller.auth.dto.ChangePasswordRequest;
import com.taller.auth.dto.ChangeRoleRequest;
import com.taller.auth.dto.PageResponse;
import com.taller.auth.dto.UpdateUserRequest;
import com.taller.auth.dto.UserResponse;
import com.taller.auth.model.User;
import com.taller.auth.service.UserService;

import jakarta.validation.Valid;

/**
 * Traduce HTTP hacia/desde UserService. Sin logica de negocio aqui.
 *
 * MATRIZ DE AUTORIZACION
 *
 * | Operacion            | Quien puede            | Por que                          |
 * |----------------------|------------------------|----------------------------------|
 * | GET /users           | Solo ADMIN             | El directorio completo de cuentas |
 * |                      |                        | es material de partida para       |
 * |                      |                        | ataques dirigidos                 |
 * | GET /users/{id}      | El propio usuario o ADMIN                                 |
 * | PUT /users/{id}      | El propio usuario o ADMIN                                 |
 * | PATCH .../password   | SOLO el propio usuario | Ni siquiera un ADMIN puede tomar  |
 * |                      |                        | una cuenta ajena: se exige la     |
 * |                      |                        | clave vigente, que solo el dueno  |
 * |                      |                        | conoce                            |
 * | PATCH .../role       | Solo ADMIN             | Es la operacion que concede       |
 * |                      |                        | privilegios                       |
 * | DELETE /users{id}    | El propio usuario o ADMIN                                 |
 *
 * El rol y la contrasena viajan en endpoints propios y no dentro del PUT. Si
 * fueran campos del mismo cuerpo, la autorizacion tendria que depender de QUE
 * campos trae la peticion -"puedes editarte a ti mismo, salvo estos dos"-, y
 * ese condicional es exactamente donde se cuelan las escaladas de privilegio.
 * Separados, cada endpoint tiene una regla sin ramas.
 */
@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping
    @PreAuthorize("hasRole('ADMIN')")
    public PageResponse<UserResponse> list(
            @PageableDefault(size = 20, sort = "username", direction = Sort.Direction.ASC)
            Pageable pageable) {
        return PageResponse.from(userService.list(pageable), UserController::toResponse);
    }

    @GetMapping("/{id}")
    @PreAuthorize("@userSecurity.isSelf(#id) or hasRole('ADMIN')")
    public UserResponse get(@PathVariable Long id) {
        return toResponse(userService.findActiveById(id));
    }

    @PutMapping("/{id}")
    @PreAuthorize("@userSecurity.isSelf(#id) or hasRole('ADMIN')")
    public UserResponse update(@PathVariable Long id, @Valid @RequestBody UpdateUserRequest request) {
        return toResponse(userService.updateUsername(id, request.username()));
    }

    /**
     * Cambio de contrasena. Solo el propio usuario, nunca un ADMIN.
     *
     * Responde 204: devolver el usuario no aportaria nada -ningun campo
     * visible cambia- y obligaria a pensar si el cuerpo podria filtrar algo.
     */
    @PatchMapping("/{id}/password")
    @PreAuthorize("@userSecurity.isSelf(#id)")
    public ResponseEntity<Void> changePassword(
            @PathVariable Long id,
            @Valid @RequestBody ChangePasswordRequest request) {
        userService.changePassword(id, request.currentPassword(), request.newPassword());
        return ResponseEntity.noContent().build();
    }

    @PatchMapping("/{id}/role")
    @PreAuthorize("hasRole('ADMIN')")
    public UserResponse changeRole(@PathVariable Long id, @Valid @RequestBody ChangeRoleRequest request) {
        return toResponse(userService.changeRole(id, request.role()));
    }

    /**
     * Borrado LOGICO: la fila sobrevive con active=false. 204 sin cuerpo
     * porque, de cara al cliente, el usuario deja de existir — que por dentro
     * sea un soft delete es un detalle de persistencia.
     *
     * Puede fallar con 409 last_admin_protected si dejaria al sistema sin
     * administradores activos (ver UserService.guardLastAdmin).
     */
    @DeleteMapping("/{id}")
    @PreAuthorize("@userSecurity.isSelf(#id) or hasRole('ADMIN')")
    public ResponseEntity<Void> delete(@PathVariable Long id) {
        userService.deactivate(id);
        return ResponseEntity.noContent().build();
    }

    // misma convencion que AuthService.toResponse: el mapeo vive junto a quien
    // lo usa mientras no haga falta en otro sitio.
    private static UserResponse toResponse(User user) {
        return new UserResponse(
                user.getId(),
                user.getUsername(),
                user.getRole(),
                user.isActive(),
                user.getCreatedAt());
    }
}
