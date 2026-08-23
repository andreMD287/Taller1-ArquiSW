package com.taller.auth.unit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import com.taller.auth.controller.UserController;
import com.taller.auth.dto.ChangePasswordRequest;
import com.taller.auth.dto.ChangeRoleRequest;
import com.taller.auth.dto.PageResponse;
import com.taller.auth.dto.UpdateUserRequest;
import com.taller.auth.dto.UserResponse;
import com.taller.auth.model.Role;
import com.taller.auth.model.User;
import com.taller.auth.service.UserService;

@ExtendWith(MockitoExtension.class)
class UserControllerTest {

    @Mock
    private UserService userService;

    private UserController controller;

    @BeforeEach
    void setUp() {
        controller = new UserController(userService);
    }

    @Test
    void listarUsuariosDevuelvePaginaMapeada() {
        var pageable = PageRequest.of(0, 20);

        User user1 = new User("alice", "hash1");
        User user2 = new User("bob", "hash2");

        var page = new PageImpl<>(
                List.of(user1, user2),
                pageable,
                2
        );

        when(userService.list(pageable)).thenReturn(page);

        PageResponse<UserResponse> response = controller.list(pageable);

        assertNotNull(response);
        assertEquals(2, response.content().size());
        assertEquals("alice", response.content().get(0).username());
        assertEquals("bob", response.content().get(1).username());
        assertEquals(0, response.page());
        assertEquals(20, response.size());
        assertEquals(2, response.totalElements());
        assertTrue(response.last());

        verify(userService).list(pageable);
    }

    @Test
    void obtenerUsuarioDevuelveRespuestaPublica() {
        User user = new User("alice", "hash-secreto");

        when(userService.findActiveById(1L)).thenReturn(user);

        UserResponse response = controller.get(1L);

        assertEquals("alice", response.username());
        assertEquals(Role.USER, response.role());
        assertTrue(response.active());
        assertNotNull(response.createdAt());

        verify(userService).findActiveById(1L);
    }

    @Test
    void actualizarUsernameDelegaAlServicioYDevuelveUsuarioActualizado() {
        UpdateUserRequest request = new UpdateUserRequest("nuevoNombre");

        User updated = new User("nuevoNombre", "hash");

        when(userService.updateUsername(1L, "nuevoNombre"))
                .thenReturn(updated);

        UserResponse response = controller.update(1L, request);

        assertEquals("nuevoNombre", response.username());
        assertTrue(response.active());

        verify(userService).updateUsername(1L, "nuevoNombre");
    }

    @Test
    void cambiarPasswordDevuelve204SinCuerpo() {
        ChangePasswordRequest request =
                new ChangePasswordRequest("passwordActual", "passwordNueva123");

        ResponseEntity<Void> response =
                controller.changePassword(1L, request);

        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode());
        assertFalse(response.hasBody());

        verify(userService)
                .changePassword(1L, "passwordActual", "passwordNueva123");
    }

    @Test
    void cambiarRolDelegaAlServicioYDevuelveRolActualizado() {
        ChangeRoleRequest request =
                new ChangeRoleRequest(Role.ADMIN);

        User user = new User("alice", "hash");
        user.setRole(Role.ADMIN);

        when(userService.changeRole(1L, Role.ADMIN))
                .thenReturn(user);

        UserResponse response =
                controller.changeRole(1L, request);

        assertEquals("alice", response.username());
        assertEquals(Role.ADMIN, response.role());

        verify(userService)
                .changeRole(1L, Role.ADMIN);
    }

    @Test
    void eliminarUsuarioDevuelve204SinCuerpo() {
        ResponseEntity<Void> response =
                controller.delete(1L);

        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode());
        assertFalse(response.hasBody());

        verify(userService).deactivate(1L);
    }
}