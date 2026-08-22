package com.taller.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * La operacion dejaria al sistema sin ningun ADMIN activo.
 *
 * Materializa el INTERLOCK del Cap. 10: un invariante del sistema que ninguna
 * secuencia de operaciones legitimas puede violar. Sin el, un administrador
 * puede dejar el sistema en un estado del que no hay salida por la interfaz —
 * nadie podria volver a asignar el rol ADMIN, porque solo un ADMIN puede
 * hacerlo, y recuperarlo exigiria tocar la base de datos a mano.
 *
 * 409 CONFLICT y no 422: la peticion es valida y el estado del recurso es
 * correcto; lo que impide la operacion es el estado GLOBAL del sistema en
 * este momento. La misma peticion sera valida en cuanto exista otro ADMIN
 * activo, y por eso el error describe una situacion transitoria, no un dato
 * mal formado.
 *
 * Quien aplica el interlock es UserService: bloquea las filas de los
 * administradores activos con PESSIMISTIC_WRITE antes de comprobar, dentro de
 * la misma transaccion que hace la mutacion. Un conteo sin bloqueo dejaria una
 * ventana en la que dos bajas concurrentes verian ambas dos administradores.
 */
public class LastAdminException extends AppException {

    public LastAdminException() {
        super(
                "last_admin_protected",
                FaultKind.EXPECTED,
                HttpStatus.CONFLICT,
                false,
                "No se puede desactivar ni quitar el rol al ultimo administrador activo"
        );
    }
}
