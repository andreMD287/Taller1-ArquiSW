/**
 * CONTROLADOR — coordina modelo y vista, y no hace el trabajo de ninguno.
 *
 * Responsabilidades del controlador en este MVC:
 *   - recibir el evento que la vista reporta;
 *   - pedirle al modelo la operacion correspondiente;
 *   - traducir el resultado (o el error) a instrucciones para la vista.
 *
 * No toca el DOM y no llama a la API: solo conoce las interfaces de ambos.
 * Por eso se puede probar sustituyendo modelo y vista por dobles.
 *
 * ESTE ES EL ARCHIVO DE REFERENCIA para agregar pantallas nuevas. Un
 * ProductController se escribe igual: recibe eventos de ProductView, llama a
 * ProductModel y traduce errores con el mismo criterio de abajo.
 */
export class LoginController {

    constructor(model, view) {
        this.model = model;
        this.view = view;
    }

    init() {
        this.view.bindSubmit((credentials) => this.onSubmit(credentials));
        if (this.model.isAuthenticated) {
            this.view.showSuccess(`Sesion activa como ${this.model.username}`);
        }
    }

    async onSubmit({ username, password }) {
        this.view.clearFieldViolations();
        this.view.setBusy(true);
        this.view.showInfo("Autenticando...");

        try {
            const session = await this.model.login(username, password);
            this.view.showSuccess(`Inicio de sesion exitoso. Bienvenido ${session.username}`);
        } catch (error) {
            this.#reportError(error);
        } finally {
            this.view.setBusy(false);
        }
    }

    /**
     * Un unico lugar traduce errores de la API a mensajes de usuario.
     *
     * El orden importa: las violaciones con campo se muestran resaltando el
     * input, que es mas util que un texto generico. Solo cuando no hay
     * informacion de campo se cae al mensaje plano.
     */
    #reportError(error) {
        if (error.violations && error.violations.length > 0) {
            this.view.showFieldViolations(error.violations);
            return;
        }
        if (error.isUnavailable) {
            this.view.showError("El servicio no esta disponible en este momento. Intenta de nuevo en unos segundos.");
            return;
        }
        this.view.showError(error.message);
    }
}
