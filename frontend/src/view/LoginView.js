/**
 * VISTA — todo el acceso al DOM del formulario de login, y nada mas.
 *
 * Responsabilidades de la vista en este MVC:
 *   - leer lo que el usuario escribio y mostrar lo que haya que mostrar;
 *   - avisar al controlador cuando el usuario hace algo (onSubmit);
 *   - NO llamar a la API. Este archivo no menciona fetch ni ApiClient.
 *
 * La vista no decide nada: no sabe si unas credenciales son validas ni que
 * significa un 422. Solo pinta lo que el controlador le manda pintar.
 */
export class LoginView {

    constructor(root = document) {
        this.form = root.getElementById("loginForm");
        this.usernameInput = root.getElementById("username");
        this.passwordInput = root.getElementById("password");
        this.message = root.getElementById("message");
    }

    /** Registra el manejador del controlador. La vista no sabe que hace. */
    bindSubmit(handler) {
        this.form.addEventListener("submit", (event) => {
            event.preventDefault();
            handler({
                username: this.usernameInput.value,
                password: this.passwordInput.value
            });
        });
    }

    showInfo(text) {
        this.#setMessage(text, "info");
    }

    showSuccess(text) {
        this.#setMessage(text, "success");
    }

    showError(text) {
        this.#setMessage(text, "error");
    }

    /**
     * Resalta los campos que el backend rechazo, uno por uno.
     *
     * Esto es lo que habilita el array `violations` del contrato de error: sin
     * el campo `field` en cada violacion, la vista solo podria mostrar un
     * texto plano y el usuario tendria que adivinar que input corregir.
     */
    showFieldViolations(violations) {
        this.clearFieldViolations();
        violations.forEach(violation => {
            const input = this.form.querySelector(`[name="${violation.field}"]`);
            if (input) {
                input.classList.add("field-error");
            }
        });
        this.showError(violations.map(v => v.message).join(" · "));
    }

    clearFieldViolations() {
        this.form.querySelectorAll(".field-error")
            .forEach(input => input.classList.remove("field-error"));
    }

    setBusy(busy) {
        this.form.querySelector("button[type=submit]").disabled = busy;
    }

    #setMessage(text, kind) {
        this.message.textContent = text;
        this.message.className = kind;
    }
}
