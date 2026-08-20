import { STORAGE_KEYS } from "../config.js";

/**
 * MODELO — estado y reglas de la sesion del usuario.
 *
 * Responsabilidades del modelo en este MVC:
 *   - guardar el estado de la aplicacion (quien esta autenticado);
 *   - saber como obtener y modificar ese estado (a traves del ApiClient);
 *   - NO saber nada del DOM. Este archivo no menciona document ni window.
 *
 * Esa ultima regla es la que hace verificable la separacion: si algun dia
 * alguien mete un getElementById aqui, el MVC dejo de existir.
 */
export class AuthModel {

    constructor(apiClient, storage = window.localStorage) {
        this.api = apiClient;
        this.storage = storage;
    }

    get accessToken() {
        return this.storage.getItem(STORAGE_KEYS.accessToken);
    }

    get username() {
        return this.storage.getItem(STORAGE_KEYS.username);
    }

    get isAuthenticated() {
        return this.accessToken !== null;
    }

    /**
     * Autentica y persiste la sesion.
     *
     * Deja que los errores del ApiClient se propaguen tal cual: traducirlos a
     * un mensaje para el usuario es trabajo del controlador, no del modelo.
     */
    async login(username, password) {
        const tokens = await this.api.post("/auth/login", { username, password });
        this.#persist(tokens);
        return tokens;
    }

    async register(username, password) {
        return this.api.post("/auth/register", { username, password });
    }

    /**
     * Cierra la sesion. Se limpia el estado local pase lo que pase en el
     * servidor: si la revocacion del refresh token falla, el usuario igual
     * debe quedar deslogueado en este navegador.
     */
    async logout() {
        const refreshToken = this.storage.getItem(STORAGE_KEYS.refreshToken);
        try {
            if (refreshToken) {
                await this.api.post("/auth/logout", { refreshToken });
            }
        } finally {
            this.#clear();
        }
    }

    #persist(tokens) {
        this.storage.setItem(STORAGE_KEYS.accessToken, tokens.accessToken);
        this.storage.setItem(STORAGE_KEYS.refreshToken, tokens.refreshToken);
        this.storage.setItem(STORAGE_KEYS.username, tokens.username);
    }

    #clear() {
        Object.values(STORAGE_KEYS).forEach(key => this.storage.removeItem(key));
    }
}
