/**
 * Configuracion de la capa de presentacion.
 *
 * API_BASE es una ruta RELATIVA a proposito. El servidor web que sirve estos
 * archivos tambien hace proxy de /api hacia el tier de logica, asi que el
 * navegador ve un unico origen. Tres consecuencias:
 *
 *   1. No hay ninguna URL de backend escrita en el codigo. Antes estaba
 *      "http://localhost:8080" hardcodeada, lo que hacia que la aplicacion
 *      solo funcionara en la maquina del desarrollador.
 *   2. No hay CORS: mismo origen. El backend puede dejar de aceptar
 *      cualquier origen ("*") y restringirse.
 *   3. El mismo artefacto sirve en cualquier entorno sin recompilar, que es
 *      la misma regla que ADR-06 aplica al backend.
 */
export const API_BASE = "/api";

/** Claves de almacenamiento de sesion en el navegador. */
export const STORAGE_KEYS = {
    accessToken: "authToken",
    refreshToken: "refreshToken",
    username: "username"
};
