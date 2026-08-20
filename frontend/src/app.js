import { ApiClient } from "./model/ApiClient.js";
import { AuthModel } from "./model/AuthModel.js";
import { LoginView } from "./view/LoginView.js";
import { LoginController } from "./controller/LoginController.js";

/**
 * Punto de arranque: construye las piezas y las conecta.
 *
 * Es el unico archivo que conoce a las tres capas a la vez. Ni el modelo
 * conoce a la vista, ni la vista al modelo: se enteran uno del otro
 * exclusivamente a traves del controlador, y el cableado ocurre aqui. Es el
 * equivalente en el frontend a la inyeccion de dependencias del backend.
 *
 * Para agregar una pantalla nueva se agrega su trio aqui, sin tocar los
 * existentes.
 */
document.addEventListener("DOMContentLoaded", () => {
    const api = new ApiClient();

    const loginController = new LoginController(
        new AuthModel(api),
        new LoginView()
    );
    loginController.init();
});
