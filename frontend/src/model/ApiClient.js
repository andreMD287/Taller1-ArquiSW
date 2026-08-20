import { API_BASE } from "../config.js";

/**
 * Error normalizado de la API.
 *
 * Traduce el contrato de error del backend (ErrorResponse) a algo que la vista
 * pueda usar sin conocer codigos HTTP. El campo `violations` solo viene en los
 * 422 y trae, por cada regla incumplida, a que campo del formulario apunta.
 */
export class ApiError extends Error {

    constructor(status, code, message, violations) {
        super(message);
        this.status = status;
        this.code = code;
        this.violations = violations || [];
    }

    /** true si el servidor rechazo los datos enviados (400 o 422). */
    get isValidation() {
        return this.status === 400 || this.status === 422;
    }

    /** true si el problema es del servidor y reintentar puede funcionar. */
    get isUnavailable() {
        return this.status === 503;
    }
}

/**
 * Unico punto de la aplicacion que habla HTTP.
 *
 * Ninguna vista ni controlador llama a fetch directamente: si el contrato de
 * la API cambia, se cambia aqui y en ningun otro sitio. Es la contraparte en
 * el frontend del patron Repositorio del backend — oculta la decision de
 * "como se obtienen los datos" detras de una interfaz estable.
 */
export class ApiClient {

    constructor(baseUrl = API_BASE) {
        this.baseUrl = baseUrl;
    }

    async post(path, body, token) {
        return this.#request("POST", path, body, token);
    }

    async get(path, token) {
        return this.#request("GET", path, null, token);
    }

    async put(path, body, token) {
        return this.#request("PUT", path, body, token);
    }

    async delete(path, token) {
        return this.#request("DELETE", path, null, token);
    }

    async #request(method, path, body, token) {
        const options = { method, headers: {} };

        if (body !== null && body !== undefined) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
        }
        if (token) {
            options.headers["Authorization"] = `Bearer ${token}`;
        }

        let response;
        try {
            response = await fetch(this.baseUrl + path, options);
        } catch (networkError) {
            // el servidor no respondio: ni siquiera hay codigo HTTP.
            throw new ApiError(0, "network_error",
                "No se pudo contactar el servicio. Revisa tu conexion.", []);
        }

        // 204 No Content: operacion exitosa sin cuerpo (ej. borrado logico).
        if (response.status === 204) {
            return null;
        }

        const payload = await this.#readJson(response);

        if (!response.ok) {
            throw new ApiError(
                response.status,
                payload?.code ?? "unknown_error",
                payload?.message ?? "Ocurrio un error inesperado.",
                payload?.violations);
        }
        return payload;
    }

    async #readJson(response) {
        try {
            return await response.json();
        } catch (e) {
            // un cuerpo vacio o no-JSON no debe reventar el cliente.
            return null;
        }
    }
}
