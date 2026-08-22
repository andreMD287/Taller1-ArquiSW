package com.taller.auth.security;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;

/**
 * Responde "¿el usuario autenticado es este mismo?" para las expresiones
 * @PreAuthorize de los endpoints de usuarios.
 *
 * Existe como bean en vez de escribir la comparacion dentro del SpEL
 * (`authentication.principal == #id`) por dos razones. La primera es que el
 * principal lo pone JwtAuthenticationFilter y es un Long: si algun dia
 * cambiara de tipo, la comparacion en SpEL empezaria a dar false en silencio
 * y nadie podria editar su propio perfil, sin ningun error que lo delate. La
 * segunda es que asi la regla se puede probar con un test, y una decision de
 * autorizacion sin prueba es una decision que nadie verifico.
 *
 * Falla cerrado: ante cualquier duda -sin autenticacion, principal de otro
 * tipo, id nulo- responde false y deja que decida la otra mitad de la
 * expresion (hasRole('ADMIN')).
 */
@Component("userSecurity")
public class UserSecurity {

    public boolean isSelf(Long id) {
        if (id == null) {
            return false;
        }
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            return false;
        }
        return authentication.getPrincipal() instanceof Long principalId
                && principalId.equals(id);
    }
}
