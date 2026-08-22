/**
 * frontend/src/app.js — Punto ÚNICO de composición de la aplicación.
 *
 * Es el único módulo que conoce a los tres lados a la vez: la configuración, la
 * plataforma (sesión) y el motor de CRUD con los descriptores de recurso. La
 * dirección permitida es:
 *
 *     app → resources
 *     app → crud → platform
 *     app → platform
 *
 * y nunca al revés: `crud/` no importa recursos, y `platform/` no importa ni
 * CRUD ni recursos (ADR-F01, ADR-F02).
 *
 * AUTORIZACIÓN DEL BACKEND — ESTADO VERIFICADO
 * --------------------------------------------
 * Verificado leyendo `SecurityConfig`, `JwtAuthenticationFilter`,
 * `ProductController` y `ProductSecurityIT`, y ejercitando el backend real:
 *
 *   - `JwtAuthenticationFilter` valida el access token y, si es válido,
 *     construye el `Authentication` de la petición.
 *   - El claim firmado `role` se traduce a la authority `ROLE_USER` o
 *     `ROLE_ADMIN`.
 *   - `@EnableMethodSecurity` está activo, así que los
 *     `@PreAuthorize("hasRole('ADMIN')")` de `ProductController` SÍ se aplican.
 *   - Leer `/api/products` requiere estar autenticado.
 *   - `POST`, `PUT` y `DELETE` requieren ADMIN.
 *
 * QUÉ SIGNIFICA ESO PARA ESTA COMPOSICIÓN — Y QUÉ NO
 * --------------------------------------------------
 * Que el frontend lea `session.role()` para ocultar acciones de escritura NO es
 * seguridad: es adaptación visual. La frontera de autorización sigue estando en
 * el backend, que vuelve a comprobar el rol en cada petición. Ocultar el botón
 * evita un rechazo previsible; no evita nada si alguien llama al API por su
 * cuenta. Por eso un 403 se sigue manejando —informar sin cerrar sesión—
 * aunque la interfaz creyera que la operación era imposible.
 *
 * Las dos respuestas de seguridad NO tienen la misma forma (§1.5 del contrato):
 * el 401 de `SecurityConfig` es el JSON mínimo `{"code":"unauthorized"}` y el
 * 403 de `@PreAuthorize` pasa por `GlobalExceptionHandler` con un
 * `ErrorResponse` completo. Esta composición no depende de esa diferencia
 * porque solo consume el modelo normalizado de `platform/errors.js`.
 */

import { config } from "../config.js";
import * as session from "./platform/session.js";
import { mount } from "./crud/engine.js";
import { resources } from "./resources/index.js";

/* ------------------------------------------------------------------ *
 * Capacidades de presentación
 * ------------------------------------------------------------------ */

/**
 * Traduce las capacidades declarativas de un descriptor a una respuesta
 * booleana. El motor no sabe qué es "ADMIN": solo pregunta.
 *
 * Una capacidad desconocida se DENIEGA, y `role()` nulo —sin sesión, token
 * vencido, JWT ilegible o rol fuera del vocabulario— no es ADMIN. En los dos
 * casos se elige lo más restrictivo, que es lo que un fallo debe producir.
 */
export function can(capability) {
    if (capability === "AUTHENTICATED") {
        return session.isAuthenticated();
    }
    if (capability === "ADMIN") {
        return session.role() === "ADMIN";
    }
    return false;
}

/* ------------------------------------------------------------------ *
 * Utilidades de vista
 * ------------------------------------------------------------------ */

/** Texto seguro: SIEMPRE textContent. Nada que venga del servidor se interpreta. */
function setText(element, text) {
    if (element) {
        element.textContent = text === null || text === undefined ? "" : String(text);
    }
}

function show(element, visible) {
    if (element) {
        element.hidden = visible !== true;
    }
}

/** Mensaje legible a partir de la CATEGORÍA del error, nunca de una regla. */
function describe(error) {
    if (!error) return "Ha ocurrido un error.";
    switch (error.category) {
        case "unauthorized": return "La sesión no es válida. Vuelve a iniciar sesión.";
        case "forbidden": return "No tienes permiso para esta operación.";
        case "unavailable": return "El servicio no está disponible en este momento.";
        case "timeout": return "La operación tardó demasiado y se canceló.";
        case "network": return "No se pudo contactar con el servidor.";
        case "locked": return error.message || "La cuenta está bloqueada temporalmente.";
        default: return error.message || "Ha ocurrido un error.";
    }
}

/** Extrae el modelo normalizado de un HttpError, o null si no lo es. */
function modelOf(cause) {
    return cause && cause.error && typeof cause.error === "object" ? cause.error : null;
}

/* ------------------------------------------------------------------ *
 * start()
 * ------------------------------------------------------------------ */

/**
 * Arranca la aplicación sobre un shell ya presente en el documento.
 *
 * @param {object}   [options]
 * @param {Element}  [options.shell]    raíz con la estructura de index.html.
 * @param {Function} [options.confirm]  confirmación para acciones peligrosas.
 * @returns {object} controlador con destroy()
 *
 * Importar este módulo NO arranca nada: `start()` es explícito. El arranque
 * automático del final del archivo solo ocurre si el documento contiene un
 * shell, cosa que la página de pruebas no hace.
 */
export function start(options = {}) {
    const shell = options.shell || document.querySelector("[data-app-shell]");
    if (!shell) {
        throw new Error("no se encontró el shell de la aplicación");
    }

    const el = {
        boot: shell.querySelector('[data-view="boot"]'),
        login: shell.querySelector('[data-view="login"]'),
        app: shell.querySelector('[data-view="app"]'),
        loginForm: shell.querySelector("[data-login-form]"),
        username: shell.querySelector("[data-login-username]"),
        password: shell.querySelector("[data-login-password]"),
        loginSubmit: shell.querySelector("[data-login-submit]"),
        authMessage: shell.querySelector("[data-auth-message]"),
        loginNotice: shell.querySelector("[data-login-notice]"),
        banner: shell.querySelector("[data-degraded-banner]"),
        bannerText: shell.querySelector("[data-degraded-text]"),
        bannerRetry: shell.querySelector("[data-degraded-retry]"),
        notice: shell.querySelector("[data-notice]"),
        userName: shell.querySelector("[data-user-name]"),
        userRole: shell.querySelector("[data-user-role]"),
        logout: shell.querySelector("[data-logout]"),
        nav: shell.querySelector("[data-resource-nav]"),
        crud: shell.querySelector("[data-crud-container]")
    };

    const confirmAction = typeof options.confirm === "function"
        ? options.confirm
        : (request) => (typeof globalThis.confirm === "function"
            ? globalThis.confirm("¿Eliminar este " + request.descriptor.singularLabel.toLowerCase() + "?")
            : true);

    /**
     * UNA SOLA instancia de motor activa a la vez. Cambiar de recurso destruye la
     * anterior antes de montar la siguiente, así que no se acumulan listeners,
     * nodos ni peticiones. Es la estrategia más simple que cumple la regla y la
     * que hace que el menú no necesite casos especiales por recurso.
     */
    let current = null;
    let currentKey = null;
    let submitting = false;
    let destroyed = false;
    let retryAction = null;
    let loggingOut = false;

    /**
     * Identidad de la sesión VISIBLE, propia de la composición.
     *
     * No sustituye a las generaciones de `session.js` —eso es asunto suyo— sino
     * que resuelve una carrera que solo existe en la interfaz: un logout limpia
     * el estado local de inmediato y su respuesta remota llega mucho después,
     * cuando ya puede haber otra sesión en pantalla. Sin esta identidad, ese
     * manejador tardío llamaría a `showLogin()` y desmontaría una sesión ajena.
     *
     * La incrementa todo lo que cambia quién está en pantalla: montar una sesión
     * y cerrar una. Cada operación captura la suya y comprueba, antes de tocar la
     * vista, que sigue siendo la vigente. Es explícita a propósito: apoyarse solo
     * en `session.isAuthenticated()` haría la carrera mucho más difícil de
     * comprobar, porque ese valor puede coincidir por casualidad.
     */
    let visibleSession = 0;

    function claimVisibleSession() {
        visibleSession += 1;
        return visibleSession;
    }

    function stillOwns(epoch) {
        return !destroyed && epoch === visibleSession;
    }

    const navButtons = new Map();

    /* ----------------------------- vistas ----------------------------- */

    function showView(name) {
        show(el.boot, name === "boot");
        show(el.login, name === "login");
        show(el.app, name === "app");
        shell.dataset.view = name;
    }

    function clearNotice() {
        setText(el.notice, "");
        if (el.notice) delete el.notice.dataset.requestId;
    }

    function clearLoginNotice() {
        setText(el.loginNotice, "");
        if (el.loginNotice) delete el.loginNotice.dataset.requestId;
    }

    /**
     * Diagnóstico para quien YA está en el login.
     *
     * El aviso de la vista autenticada (`[data-notice]`) vive dentro de ella, así
     * que al volver al login queda oculto: el texto estaría en el DOM pero nadie
     * podría leerlo. Este va en la propia vista de login, donde sí se ve.
     */
    function noticeOnLogin(text, requestId) {
        setText(el.loginNotice, requestId ? text + " (referencia: " + requestId + ")" : text);
        if (el.loginNotice && requestId) el.loginNotice.dataset.requestId = requestId;
    }

    function notify(text, requestId) {
        setText(el.notice, requestId ? text + " (referencia: " + requestId + ")" : text);
        if (el.notice && requestId) el.notice.dataset.requestId = requestId;
    }

    function showBanner(text, retry) {
        setText(el.bannerText, text);
        retryAction = typeof retry === "function" ? retry : null;
        show(el.bannerRetry, retryAction !== null);
        show(el.banner, true);
    }

    function hideBanner() {
        retryAction = null;
        show(el.banner, false);
        setText(el.bannerText, "");
    }

    /* --------------------------- desmontaje --------------------------- */

    function unmountResource() {
        if (current) {
            current.destroy();
            current = null;
            currentKey = null;
        }
        for (const button of navButtons.values()) {
            button.removeEventListener("click", button._onSelect);
        }
        navButtons.clear();
        if (el.nav) el.nav.textContent = "";
        if (el.crud) el.crud.textContent = "";
    }

    /* ---------------------------- montaje ----------------------------- */

    function selectResource(key) {
        if (destroyed) return null;
        // Destruir ANTES de montar: nunca hay dos instancias vivas, así que
        // cambiar de recurso no duplica listeners, nodos ni peticiones.
        if (current) {
            current.destroy();
            current = null;
        }
        if (el.crud) el.crud.textContent = "";

        const descriptor = resources.find((resource) => resource.key === key);
        if (!descriptor) return null;

        currentKey = key;
        for (const [otherKey, button] of navButtons) {
            button.setAttribute("aria-current", otherKey === key ? "page" : "false");
        }

        current = mount(el.crud, descriptor, {
            pageSize: config.pageSize,
            can,
            confirm: confirmAction
        });
        return current;
    }

    function buildNav() {
        if (!el.nav) return;
        el.nav.textContent = "";
        navButtons.clear();
        const list = document.createElement("ul");
        list.className = "app-nav__list";
        for (const descriptor of resources) {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.className = "app-nav__link";
            button.textContent = descriptor.label;   // texto, nunca HTML
            button.dataset.resource = descriptor.key;
            button._onSelect = () => selectResource(descriptor.key);
            button.addEventListener("click", button._onSelect);
            navButtons.set(descriptor.key, button);
            item.appendChild(button);
            list.appendChild(item);
        }
        el.nav.appendChild(list);
    }

    function showApp() {
        // Sesión nueva en pantalla: invalida cualquier operación de la anterior.
        claimVisibleSession();
        loggingOut = false;
        clearNotice();
        clearLoginNotice();
        setText(el.authMessage, "");
        setText(el.userName, session.getUsername() || "");
        // Rol SOLO para presentación. La autorización real es del backend.
        setText(el.userRole, session.role() || "sin rol");
        showView("app");
        buildNav();
        const first = resources[0];
        if (first) selectResource(first.key);
    }

    function showLogin(message) {
        unmountResource();
        setText(el.authMessage, message || "");
        setText(el.userName, "");
        setText(el.userRole, "");
        showView("login");
    }

    /* ---------------------------- sesión ------------------------------ */

    function applyRestoreOutcome() {
        if (destroyed) return;
        if (session.isAuthenticated()) {
            hideBanner();
            showApp();
        } else {
            showLogin();
        }
    }

    function handleRestoreFailure(cause) {
        if (destroyed) return;
        const model = modelOf(cause);
        // 401 invalid_session: session.js ya limpió. Solo queda volver al login.
        if (model && model.category === "unauthorized") {
            hideBanner();
            showLogin("La sesión anterior expiró. Vuelve a iniciar sesión.");
            return;
        }
        // 503, timeout o red: session.js conserva lo necesario. Se muestra
        // degradación y un reintento MANUAL. Nunca un bucle ni un intervalo.
        showLogin();
        showBanner(describe(model) + " No se pudo restaurar la sesión.", runRestore);
    }

    function runRestore() {
        if (destroyed) return Promise.resolve();
        showView("boot");
        return session.restore().then(applyRestoreOutcome, handleRestoreFailure);
    }

    const onSubmit = (event) => {
        event.preventDefault();
        if (submitting || destroyed) return;      // sin doble envío
        submitting = true;
        if (el.loginSubmit) el.loginSubmit.disabled = true;
        setText(el.authMessage, "Autenticando…");

        session.login(el.username ? el.username.value : "", el.password ? el.password.value : "")
            .then((result) => {
                if (destroyed) return;
                if (!result || result.stale === true || result.applied === false) {
                    // Login obsoleto: otra operación de sesión ganó. No se monta
                    // una sesión falsa.
                    setText(el.authMessage, "El inicio de sesión quedó obsoleto. Inténtalo otra vez.");
                    return;
                }
                if (session.isAuthenticated()) {
                    if (el.password) el.password.value = "";
                    hideBanner();
                    showApp();
                } else {
                    setText(el.authMessage, "No se pudo iniciar sesión.");
                }
            })
            .catch((cause) => {
                if (destroyed) return;
                const model = modelOf(cause);
                if (model && model.code === "invalid_credentials") {
                    // Solo eso: el backend responde igual para una cuenta
                    // inexistente y para una desactivada, así que no se infiere
                    // nada más ni se inventa un código propio.
                    setText(el.authMessage, "Usuario o contraseña incorrectos.");
                } else {
                    setText(el.authMessage, describe(model));
                }
            })
            .then(() => {
                if (destroyed) return;
                submitting = false;
                if (el.loginSubmit) el.loginSubmit.disabled = false;
            });
    };

    const onLogout = () => {
        if (destroyed || loggingOut) return;      // sin doble logout
        loggingOut = true;
        if (el.logout) el.logout.disabled = true;

        // DESMONTAJE INMEDIATO. `session.logout()` ya borró el estado local antes
        // de esperar al backend, así que mantener la aplicación en pantalla
        // mostraría una sesión que ya no existe. La interfaz se retira AHORA, sin
        // esperar al 200, al 202 best-effort, a un error HTTP, a un timeout ni a
        // un fallo de red. La llamada remota se conserva para intentar revocar el
        // refresh token, pero nada visual depende de ella.
        const epoch = claimVisibleSession();
        showLogin("Sesión cerrada.");
        clearLoginNotice();

        const settle = () => {
            if (destroyed) return;
            if (el.logout) el.logout.disabled = false;
            if (stillOwns(epoch)) loggingOut = false;
        };

        session.logout().then(
            () => { settle(); },
            (cause) => {
                settle();
                // Si mientras tanto apareció otra sesión, este fallo pertenece a
                // la anterior: no se le atribuye a la nueva, no la desmonta y no
                // la degrada. Simplemente se descarta visualmente.
                if (!stillOwns(epoch)) return;
                const model = modelOf(cause);
                // Se muestra donde el usuario está de verdad: en el login.
                noticeOnLogin("No se pudo confirmar el cierre de sesión en el servidor: " +
                    describe(model), model ? model.requestId : null);
            }
        );
    };

    const onRetry = () => {
        if (destroyed || typeof retryAction !== "function") return;
        const action = retryAction;
        hideBanner();
        action();
    };

    /* --------------------------- eventos ------------------------------ */

    const unsubscribe = session.subscribe((event) => {
        if (destroyed) return;
        if (event.type === "session:expired") {
            unmountResource();
            showLogin("La sesión expiró. Vuelve a iniciar sesión.");
            return;
        }
        if (event.type === "session:forbidden") {
            // No se cierra sesión y no se refresca: un 403 no dice que la sesión
            // sea inválida, dice que ESTA operación excede el rol. El caso vivo
            // es un USER autenticado sobre una escritura reservada a ADMIN.
            notify("El servidor rechazó la operación por falta de permisos.", event.requestId);
            return;
        }
        if (event.type === "system:degraded") {
            showBanner("El servicio está degradado. Puedes reintentar cuando quieras.",
                () => { if (current) current.reload(); });
            if (event.requestId && el.banner) el.banner.dataset.requestId = event.requestId;
        }
    });

    if (el.loginForm) el.loginForm.addEventListener("submit", onSubmit);
    if (el.logout) el.logout.addEventListener("click", onLogout);
    if (el.bannerRetry) el.bannerRetry.addEventListener("click", onRetry);

    const ready = runRestore();

    return {
        shell,
        ready,
        can,
        selectResource,
        getResourceKey: () => currentKey,
        getInstance: () => current,
        isDestroyed: () => destroyed,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            unsubscribe();                       // sin eventos después de destruir
            unmountResource();
            if (el.loginForm) el.loginForm.removeEventListener("submit", onSubmit);
            if (el.logout) el.logout.removeEventListener("click", onLogout);
            if (el.bannerRetry) el.bannerRetry.removeEventListener("click", onRetry);
        }
    };
}

/**
 * Arranque automático SOLO si el documento ya contiene un shell.
 *
 * Con esto, importar el módulo desde las pruebas —cuya página no tiene shell— no
 * dispara peticiones ni monta nada, y la inicialización sigue siendo explícita.
 */
if (typeof document !== "undefined" && document.querySelector("[data-app-shell]")) {
    start();
}
