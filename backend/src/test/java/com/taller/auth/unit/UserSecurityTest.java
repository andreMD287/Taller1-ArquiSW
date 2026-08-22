package com.taller.auth.unit;

import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;

import com.taller.auth.security.UserSecurity;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * La regla que decide si alguien puede editar su propio perfil. Una decision
 * de autorizacion sin prueba es una decision que nadie verifico.
 */
class UserSecurityTest {

    private final UserSecurity userSecurity = new UserSecurity();

    @AfterEach
    void limpiarContexto() {
        SecurityContextHolder.clearContext();
    }

    private static void autenticarComo(Object principal) {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(
                        principal, null, List.of(new SimpleGrantedAuthority("ROLE_USER"))));
    }

    @Test
    void reconoceAlPropioUsuario() {
        autenticarComo(7L);

        assertThat(userSecurity.isSelf(7L)).isTrue();
    }

    @Test
    void rechazaOtroUsuario() {
        autenticarComo(7L);

        assertThat(userSecurity.isSelf(8L)).isFalse();
    }

    @Test
    void sinAutenticacionRechaza() {
        assertThat(userSecurity.isSelf(7L)).isFalse();
    }

    /**
     * Falla cerrado. Si algun dia JwtAuthenticationFilter dejara de poner un
     * Long como principal, esta regla debe negar el acceso en vez de conceder
     * el de otro. Es la razon por la que la comparacion vive en un bean y no
     * escrita dentro del SpEL, donde un cambio de tipo pasaria inadvertido.
     */
    @Test
    void unPrincipalDeOtroTipoNoSeInterpretaComoCoincidencia() {
        autenticarComo("7");

        assertThat(userSecurity.isSelf(7L)).isFalse();
    }

    @Test
    void unIdNuloRechaza() {
        autenticarComo(7L);

        assertThat(userSecurity.isSelf(null)).isFalse();
    }
}
