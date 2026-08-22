/**
 * frontend/tests/app.test.js — Descriptor de productos y arranque de la aplicación.
 *
 * El shell no se duplica aquí: se carga el `index.html` REAL y se clona su
 * `[data-app-shell]`. Así estas pruebas comprueban el marcado que de verdad se
 * sirve, y no una copia que podría divergir en silencio.
 *
 * NOTA SOBRE EL BACKEND ACTUAL: `SecurityConfig` no registra ningún filtro que
 * traduzca el JWT en un `Authentication` y no lleva `@EnableMethodSecurity`, así
 * que contra el backend real `/api/products` responde 403 incluso con un token
 * válido. Aquí se sustituye `fetch`, de modo que estas pruebas describen la
 * composición, no el estado de esa pieza pendiente.
 */

import { test, assert, assertEqual, installFetch, jsonResponse, makeResponse, errorResponse,
         memoryStorage, fakeClock, deferred, tick, fakeJwt, tokenPair } from "./harness.js";
import * as metrics from "../src/platform/metrics.js";
import { configureAuthProvider, resetHttpConfig } from "../src/platform/http.js";
import * as session from "../src/platform/session.js";
import { validateDescriptor } from "../src/crud/engine.js";
import products from "../src/resources/products.js";
import { resources, findResource } from "../src/resources/index.js";
import { start, can } from "../src/app.js";

const HAS_DOM = typeof document !== "undefined" && typeof document.createElement === "function";
const MINUTE = 60_000;

let clock;
let store;
let apps;

function fresh() {
    metrics.reset();
    session.clear();
    session.resetSessionConfig();
    configureAuthProvider(null);
    resetHttpConfig();
    clock = fakeClock();
    store = memoryStorage();
    session.configureSession({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        storage: store
    });
    // Ningún shell de una prueba anterior puede quedar en el documento: el
    // arranque automático de app.js se guía por su presencia.
    for (const previo of document.querySelectorAll("[data-app-shell]")) previo.remove();
    apps = [];
}

/** Clona el shell del index.html real dentro del documento de pruebas. */
async function loadShell() {
    const html = await (await fetch("../index.html")).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const original = doc.querySelector("[data-app-shell]");
    const shell = document.importNode(original, true);
    document.body.appendChild(shell);
    return { shell, html, doc };
}

function launch(shell, options = {}) {
    const app = start({ shell, confirm: () => true, ...options });
    apps.push(app);
    return app;
}

function cleanup() {
    for (const app of apps) app.destroy();
    apps = [];
    for (const shell of document.querySelectorAll("[data-app-shell]")) shell.remove();
}

/**
 * ¿Se ve de verdad? No basta con que el nodo exista y tenga texto: si él o
 * cualquiera de sus ancestros está `hidden`, el mensaje está en el DOM pero
 * nadie puede leerlo.
 */
function isVisible(element) {
    let node = element;
    while (node && node.nodeType === 1) {
        if (node.hidden === true) return false;
        node = node.parentElement;
    }
    return true;
}

function tokens({ role = "ADMIN", username = "maria123" } = {}) {
    return tokenPair({
        role,
        username,
        accessExpiresAtMs: clock.now() + 15 * MINUTE,
        refreshExpiresAtMs: clock.now() + 7 * 24 * 60 * MINUTE
    });
}

function storedSession({ role = "ADMIN", accessOffsetMs = 15 * MINUTE } = {}) {
    return {
        version: 1,
        accessToken: fakeJwt({ sub: "1", username: "maria123", role }),
        refreshToken: "refresh-guardado",
        username: "maria123",
        accessTokenExpiresAt: new Date(clock.now() + accessOffsetMs).toISOString(),
        refreshTokenExpiresAt: new Date(clock.now() + 7 * 24 * 60 * MINUTE).toISOString()
    };
}

const emptyPage = { content: [], page: 0, size: 20, totalElements: 0, totalPages: 0, last: true };

function productPage(items) {
    return {
        content: items, page: 0, size: 20,
        totalElements: items.length,
        totalPages: items.length === 0 ? 0 : 1,
        last: true
    };
}

function product(id, overrides = {}) {
    return {
        id, name: "Producto " + id, price: 19.99, stock: 3,
        active: true, createdAt: "2026-08-22T10:00:00Z", ...overrides
    };
}

/** Backend simulado: solo lo que esta composición usa. */
function api({ login = null, products: page = emptyPage, logout = null } = {}) {
    return installFetch((url, init) => {
        if (url.includes("/api/auth/login")) {
            return login || jsonResponse(200, tokens());
        }
        if (url.includes("/api/auth/refresh")) return jsonResponse(200, tokens());
        if (url.includes("/api/auth/logout")) {
            return logout || jsonResponse(200, { revoked: true, note: null });
        }
        if (url.includes("/api/products")) {
            return typeof page === "function" ? page(url, init) : jsonResponse(200, page);
        }
        return makeResponse({ status: 404, body: "" });
    });
}

async function loginThrough(app, shell) {
    shell.querySelector("[data-login-username]").value = "maria123";
    shell.querySelector("[data-login-password]").value = "unaClaveSegura1";
    shell.querySelector("[data-login-form]").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick(8);
    const instance = app.getInstance();
    if (instance) await instance.ready;
    await tick(3);
}

if (!HAS_DOM) {
    test("app: suite omitida (este entorno no tiene DOM; ejecútala en navegador)", () => {
        assert(true, "el arnés de referencia es el navegador");
    });
}

if (HAS_DOM) {

/* =============================== Descriptor ============================= */

test("app 1: el descriptor de productos cumple validateDescriptor()", () => {
    assertEqual(validateDescriptor(products), products, "es válido para el motor actual");
    assertEqual(products.key, "products", "key");
    assertEqual(products.label, "Productos", "label en plural");
    assertEqual(products.singularLabel, "Producto", "label en singular");
    assertEqual(products.idField, "id", "idField");
});

test("app 2 y 3: ruta /api/products y búsqueda por el queryParam name", () => {
    assertEqual(products.path, "/api/products", "ruta real del backend");
    assertEqual(products.search.field, "name", "campo buscable");
    assertEqual(products.search.queryParam, "name", "parámetro que espera el backend");
    assert(typeof products.search.placeholder === "string" && products.search.placeholder.length > 0,
        "placeholder en español");
    assertEqual(products.defaultSort.field, "name", "orden por nombre");
    assertEqual(products.defaultSort.direction, "asc", "ascendente");
    assertEqual(products.permits.read, "AUTHENTICATED", "lectura");
    assertEqual(products.permits.write, "ADMIN", "escritura");
    assertEqual(products.danger.delete, "confirm", "modo soportado por el motor");
});

test("app 4: solo name, price y stock son editables, como ProductRequest", () => {
    const editables = products.fields.filter((f) => f.readOnly !== true).map((f) => f.name);
    assertEqual(editables.join(","), "name,price,stock", "coinciden con ProductRequest");
    for (const nombre of ["id", "active", "createdAt"]) {
        const campo = products.fields.find((f) => f.name === nombre);
        assertEqual(campo.readOnly, true, nombre + " es readOnly");
    }
    const declarados = products.fields.map((f) => f.name).join(",");
    assertEqual(declarados, "id,name,price,stock,active,createdAt", "campos de ProductResponse");

    const name = products.fields.find((f) => f.name === "name");
    assertEqual(name.type, "text", "name es texto");
    assertEqual(name.required, true, "obligatorio");
    assertEqual(name.maxLength, 120, "con el máximo del DTO");
    assertEqual(products.fields.find((f) => f.name === "price").type, "decimal", "price decimal");
    assertEqual(products.fields.find((f) => f.name === "price").required, true, "price obligatorio");
    assertEqual(products.fields.find((f) => f.name === "stock").type, "integer", "stock entero");
    assertEqual(products.fields.find((f) => f.name === "stock").required, true, "stock obligatorio");
    assertEqual(products.fields.find((f) => f.name === "price").align, "right", "cantidades a la derecha");
    assertEqual(products.fields.find((f) => f.name === "stock").align, "right", "idem stock");
    assert(products.fields.filter((f) => f.inList === true).length >= 4, "columnas útiles en el listado");
    for (const campo of products.fields) {
        if (campo.sortable === true) {
            assert(["name", "price", "stock", "createdAt"].includes(campo.name),
                campo.name + " debe ser un campo real ordenable");
        }
    }
});

test("app 5: el descriptor es solo datos: sin reglas de negocio ni autorización", () => {
    const plano = JSON.parse(JSON.stringify(products));
    assertEqual(JSON.stringify(plano), JSON.stringify(products),
        "es serializable: no contiene funciones");
    const texto = JSON.stringify(products);
    for (const prohibido of ["min", "max\"", "positive", "greaterThan", "rule", "can", "authorize"]) {
        assertEqual(texto.indexOf(prohibido) >= 0 && prohibido !== "max\"", false,
            "no declara '" + prohibido + "'");
    }
    // maxLength sí es estructural y debe estar; lo demás no.
    assert(texto.indexOf("maxLength") >= 0, "conserva la validación estructural");
});

test("app 6: el registro contiene productos, sin duplicados", () => {
    assert(Array.isArray(resources), "es una lista");
    assert(resources.includes(products), "incluye el descriptor de productos");
    const claves = resources.map((r) => r.key);
    assertEqual(claves.length, new Set(claves).size, "sin claves duplicadas");
    assertEqual(findResource("products"), products, "se puede buscar por clave");
    assertEqual(findResource("no-existe"), null, "y devuelve null si no está");
});

/* ============================== Composición ============================= */

test("app 7: importar los módulos secundarios no dispara peticiones", async () => {
    fresh();
    const realFetch = globalThis.fetch;
    let llamadas = 0;
    globalThis.fetch = async (...args) => { llamadas += 1; return realFetch(...args); };
    try {
        const marca = "?probe=" + Date.now();
        await import("../src/resources/products.js" + marca);
        await import("../src/resources/index.js" + marca);
        await import("../src/app.js" + marca);
        await tick(3);
        assertEqual(llamadas, 0,
            "ni el descriptor, ni el registro, ni app.js hacen nada al importarse");
    } finally {
        globalThis.fetch = realFetch;
        cleanup();
    }
});

test("app 8: sin sesión se muestra el login y no se monta ningún CRUD", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api();
    try {
        const app = launch(shell);
        await app.ready;
        await tick(3);
        assertEqual(shell.dataset.view, "login", "vista de login");
        assertEqual(shell.querySelector('[data-view="login"]').hidden, false, "visible");
        assertEqual(shell.querySelector('[data-view="app"]').hidden, true, "shell autenticado oculto");
        assertEqual(app.getInstance(), null, "sin instancia de CRUD");
        assertEqual(shell.querySelector("[data-crud-container]").textContent, "", "contenedor vacío");
        assertEqual(net.calls.length, 0, "y sin peticiones: restore() no tenía registro que usar");
    } finally { net.restore(); cleanup(); }
});

test("app 9: un login correcto monta productos UNA sola vez", async () => {
    fresh();
    const { shell } = await loadShell();
    let listados = 0;
    const net = api({ products: (url) => { listados += 1; return jsonResponse(200, productPage([product(1)])); } });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        assertEqual(shell.dataset.view, "app", "se muestra la aplicación");
        assertEqual(app.getResourceKey(), "products", "montó productos");
        assertEqual(listados, 1, "una sola petición de listado");
        assertEqual(shell.querySelectorAll("[data-crud-container] .crud").length, 1,
            "exactamente una instancia en el DOM");
        assertEqual(shell.querySelector("[data-user-name]").textContent, "maria123", "usuario visible");
        assertEqual(shell.querySelector("[data-user-role]").textContent, "ADMIN", "rol de presentación");
        assert(shell.querySelector("[data-resource-nav] button") !== null, "menú construido");
    } finally { net.restore(); cleanup(); }
});

test("app 10: un login fallido conserva el formulario y muestra un error seguro", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api({ login: errorResponse(401, { code: "invalid_credentials", requestId: "req-401" }) });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        assertEqual(shell.dataset.view, "login", "sigue en el login");
        assertEqual(app.getInstance(), null, "sin CRUD montado");
        const mensaje = shell.querySelector("[data-auth-message]");
        assertEqual(mensaje.textContent, "Usuario o contraseña incorrectos.",
            "solo eso: no se infiere si la cuenta existe o está desactivada");
        assertEqual(mensaje.querySelector("*"), null, "el mensaje es texto, no HTML");
    } finally { net.restore(); cleanup(); }
});

test("app 11: el doble envío no produce dos peticiones de login", async () => {
    fresh();
    const { shell } = await loadShell();
    const puerta = deferred();
    let logins = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) { logins += 1; return puerta.promise; }
        return jsonResponse(200, emptyPage);
    });
    try {
        const app = launch(shell);
        await app.ready;
        const form = shell.querySelector("[data-login-form]");
        shell.querySelector("[data-login-username]").value = "maria123";
        shell.querySelector("[data-login-password]").value = "clave";

        form.dispatchEvent(new Event("submit", { cancelable: true }));
        await tick(2);
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        await tick(2);

        assertEqual(logins, 1, "el segundo envío queda bloqueado");
        assertEqual(shell.querySelector("[data-login-submit]").disabled, true, "y el botón se deshabilita");
        puerta.resolve(jsonResponse(200, tokens()));
        // La cadena completa —fetch, lectura del cuerpo, guardado de la sesión y
        // los dos manejadores del login— necesita varios turnos de microtareas.
        await tick(14);
        assertEqual(shell.querySelector("[data-login-submit]").disabled, false, "se libera al terminar");
    } finally { net.restore(); cleanup(); }
});

test("app 12: cerrar sesión destruye el CRUD y vuelve al login", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api({ products: () => jsonResponse(200, productPage([product(1)])) });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);
        const instancia = app.getInstance();
        assert(instancia !== null, "había una instancia");

        shell.querySelector("[data-logout]").click();
        await tick(6);

        assertEqual(shell.dataset.view, "login", "vuelve al login");
        assertEqual(app.getInstance(), null, "sin instancia");
        assertEqual(instancia.getState().destroyed, true, "la anterior quedó destruida");
        assertEqual(shell.querySelector("[data-crud-container]").textContent, "", "contenedor limpio");
        assertEqual(session.isAuthenticated(), false, "y la sesión local está limpia");
    } finally { net.restore(); cleanup(); }
});

test("app 13: si el logout remoto falla, la interfaz NO queda autenticada", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api({
        products: () => jsonResponse(200, productPage([product(1)])),
        logout: errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-logout" })
    });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        shell.querySelector("[data-logout]").click();
        await tick(8);

        assertEqual(shell.dataset.view, "login", "vuelve al login igualmente");
        assertEqual(session.isAuthenticated(), false, "session.js garantiza la limpieza local");

        // El diagnóstico tiene que VERSE, no solo existir en el DOM.
        const aviso = shell.querySelector("[data-login-notice]");
        assert(aviso.textContent.indexOf("req-logout") >= 0,
            "conserva el requestId: " + aviso.textContent);
        assertEqual(isVisible(aviso), true, "y está en una región visible del login");
        assertEqual(aviso.dataset.requestId, "req-logout", "con el requestId disponible");
        assertEqual(isVisible(shell.querySelector("[data-notice]")), false,
            "el aviso de la vista autenticada está oculto: por eso no sirve aquí");
    } finally { net.restore(); cleanup(); }
});

test("app 14: session:expired desmonta y vuelve al login", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api({ products: () => jsonResponse(200, productPage([product(1)])) });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);
        const instancia = app.getInstance();

        // El evento llega por la API pública de sesión, no por el DOM.
        net.restore();
        const net2 = installFetch((url) => url.includes("/api/auth/refresh")
            ? errorResponse(401, { code: "invalid_session", requestId: "req-exp" })
            : jsonResponse(200, emptyPage));
        try {
            await session.refresh().catch(() => {});
            await tick(4);
            assertEqual(shell.dataset.view, "login", "vuelve al login");
            assertEqual(app.getInstance(), null, "y desmonta el recurso");
            assertEqual(instancia.getState().destroyed, true, "la instancia quedó destruida");
        } finally { net2.restore(); }
    } finally { cleanup(); }
});

test("app 15: session:forbidden conserva la sesión y muestra el requestId", async () => {
    fresh();
    const { shell } = await loadShell();
    let listados = 0;
    const net = installFetch((url, init) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, tokens());
        listados += 1;
        // El 403 vacío que hoy devuelve el backend a /api/products.
        return makeResponse({ status: 403, body: "", headers: { "X-Request-Id": "req-403" } });
    });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        assertEqual(shell.dataset.view, "app", "la sesión se conserva");
        assertEqual(session.isAuthenticated(), true, "sigue autenticado");
        const aviso = shell.querySelector("[data-notice]").textContent;
        assert(aviso.indexOf("req-403") >= 0, "muestra el requestId: " + aviso);
        assertEqual(shell.querySelector("[data-notice]").dataset.requestId, "req-403", "y lo conserva");
        const refrescos = net.calls.filter((c) => c.url.includes("/api/auth/refresh")).length;
        assertEqual(refrescos, 0, "no intenta refresh ante un 403");
        assertEqual(listados, 1, "ni reintenta en bucle");
    } finally { net.restore(); cleanup(); }
});

test("app 16: system:degraded muestra el banner sin crear reintentos automáticos", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, tokens());
        if (url.includes("/api/auth/refresh")) {
            return errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-503" });
        }
        return jsonResponse(200, emptyPage);
    });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);
        const antes = net.calls.length;

        await session.refresh().catch(() => {});
        await tick(4);

        const banner = shell.querySelector("[data-degraded-banner]");
        assertEqual(banner.hidden, false, "banner visible");
        assert(shell.querySelector("[data-degraded-text]").textContent.length > 0, "con explicación");
        assertEqual(shell.querySelector("[data-degraded-retry]").hidden, false, "reintento manual disponible");
        assertEqual(session.isAuthenticated(), true, "no se cierra la sesión");
        assertEqual(clock.pending(), 0, "sin temporizadores: ningún reintento automático");

        const refrescos = net.calls.filter((c) => c.url.includes("/api/auth/refresh")).length;
        await tick(5);
        assertEqual(net.calls.filter((c) => c.url.includes("/api/auth/refresh")).length, refrescos,
            "y no vuelve a intentarlo solo");
        assert(net.calls.length >= antes, "el resto del tráfico no se altera");
    } finally { net.restore(); cleanup(); }
});

test("app 17: tras destroy() los eventos de sesión ya no afectan a la interfaz", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api({ products: () => jsonResponse(200, productPage([product(1)])) });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        app.destroy();
        const vistaAntes = shell.dataset.view;
        assertEqual(app.isDestroyed(), true, "destruida");

        net.restore();
        const net2 = installFetch((url) => url.includes("/api/auth/refresh")
            ? errorResponse(401, { code: "invalid_session" })
            : jsonResponse(200, emptyPage));
        try {
            await session.refresh().catch(() => {});
            await tick(4);
            assertEqual(shell.dataset.view, vistaAntes, "la vista no cambió: hubo desuscripción");
        } finally { net2.restore(); }
    } finally { cleanup(); }
});

test("app 18: una restauración válida monta la aplicación", async () => {
    fresh();
    store.data.set("taller1.session", JSON.stringify(storedSession({ role: "ADMIN" })));
    const { shell } = await loadShell();
    let listados = 0;
    const net = api({ products: () => { listados += 1; return jsonResponse(200, productPage([product(1)])); } });
    try {
        const app = launch(shell);
        await app.ready;
        const instancia = app.getInstance();
        if (instancia) await instancia.ready;
        await tick(3);

        assertEqual(shell.dataset.view, "app", "aplicación montada sin pasar por el login");
        assertEqual(app.getResourceKey(), "products", "con su recurso");
        assertEqual(listados, 1, "y una sola carga");
        const autenticaciones = net.calls.filter((c) => c.url.includes("/api/auth/")).length;
        assertEqual(autenticaciones, 0, "restaurar no llamó a /validate ni a /refresh");
    } finally { net.restore(); cleanup(); }
});

test("app 19: sin registro almacenado se muestra el login", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api();
    try {
        const app = launch(shell);
        await app.ready;
        await tick(2);
        assertEqual(shell.dataset.view, "login", "login");
        assertEqual(store.counts.getItem >= 1, true, "restore() sí leyó el almacenamiento");
        assertEqual(net.calls.length, 0, "sin peticiones");
    } finally { net.restore(); cleanup(); }
});

test("app 20: un fallo temporal de restore muestra degradación y permite reintento manual", async () => {
    fresh();
    // Access token vencido pero refresh vigente: restore() tiene que renovar.
    store.data.set("taller1.session", JSON.stringify(storedSession({ accessOffsetMs: -MINUTE })));
    const { shell } = await loadShell();
    let refrescos = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/refresh")) {
            refrescos += 1;
            return refrescos === 1
                ? errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-503" })
                : jsonResponse(200, tokens());
        }
        return jsonResponse(200, productPage([product(1)]));
    });
    try {
        const app = launch(shell);
        await app.ready;
        await tick(3);

        assertEqual(shell.dataset.view, "login", "no autenticado");
        assertEqual(shell.querySelector("[data-degraded-banner]").hidden, false, "banner de degradación");
        assertEqual(session.isAuthenticated(), false, "sin sesión utilizable todavía");
        assertEqual(refrescos, 1, "un solo intento: sin bucle");
        assertEqual(clock.pending(), 0, "y sin temporizadores automáticos");

        // Reintento MANUAL.
        shell.querySelector("[data-degraded-retry]").click();
        await tick(8);
        const instancia = app.getInstance();
        if (instancia) await instancia.ready;
        await tick(3);

        assertEqual(refrescos, 2, "el reintento lo pidió una persona");
        assertEqual(shell.dataset.view, "app", "y ahora sí monta la aplicación");
        assertEqual(shell.querySelector("[data-degraded-banner]").hidden, true, "el banner desaparece");
    } finally { net.restore(); cleanup(); }
});

/* ================================= Roles ================================ */

test("app 21 a 24: capacidades traducidas de forma restrictiva", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api({ products: () => jsonResponse(200, productPage([product(1)])) });
    try {
        // Sin sesión: nada.
        assertEqual(can("AUTHENTICATED"), false, "sin sesión no hay lectura");
        assertEqual(can("ADMIN"), false, "ni escritura");

        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        assertEqual(session.role(), "ADMIN", "el rol viene del claim firmado");
        assertEqual(can("AUTHENTICATED"), true, "ADMIN puede leer");
        assertEqual(can("ADMIN"), true, "y escribir");
        assertEqual(can("SUPERUSER"), false, "una capacidad desconocida se deniega");
        assertEqual(can(null), false, "y null también");
        assertEqual(shell.querySelector(".crud__create").hidden, false, "ADMIN ve el botón de crear");
        assert(shell.querySelector(".crud-table__action--edit") !== null, "y las acciones de fila");
    } finally { net.restore(); cleanup(); }
});

test("app 22 y 23: USER conserva lectura pero no obtiene escritura", async () => {
    fresh();
    const { shell } = await loadShell();
    let listados = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, tokens({ role: "USER" }));
        listados += 1;
        return jsonResponse(200, productPage([product(1)]));
    });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        assertEqual(session.role(), "USER", "rol USER");
        assertEqual(can("AUTHENTICATED"), true, "conserva la lectura");
        assertEqual(can("ADMIN"), false, "no obtiene escritura");
        assertEqual(listados, 1, "y sí consulta: la lista se pidió");
        assertEqual(shell.querySelector(".crud__create").hidden, true, "sin botón de crear");
        assertEqual(shell.querySelector(".crud-table__action--edit"), null, "sin editar");
        assertEqual(shell.querySelector(".crud-table__action--delete"), null, "sin eliminar");
        assert(shell.querySelector(".crud-table__row") !== null, "pero la tabla sí muestra datos");
    } finally { net.restore(); cleanup(); }
});

test("app 25: remontar el recurso no duplica instancias, nodos ni peticiones", async () => {
    fresh();
    const { shell } = await loadShell();
    let listados = 0;
    const net = api({ products: () => { listados += 1; return jsonResponse(200, productPage([product(1)])); } });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);
        const primera = app.getInstance();
        assertEqual(listados, 1, "una carga");

        // Cambiar de vista al mismo recurso: destruye antes de montar.
        const segunda = app.selectResource("products");
        await segunda.ready;
        await tick(3);

        assert(segunda !== primera, "es una instancia nueva");
        assertEqual(primera.getState().destroyed, true, "la anterior se destruyó");
        assertEqual(shell.querySelectorAll("[data-crud-container] .crud").length, 1,
            "un solo nodo de CRUD en el DOM");
        assertEqual(listados, 2, "una carga por montaje, sin duplicar la anterior");

        // Y los botones del menú tampoco se acumulan.
        assertEqual(shell.querySelectorAll("[data-resource-nav] button").length, resources.length,
            "un botón por recurso");
    } finally { net.restore(); cleanup(); }
});

/* ============================= DOM y entrada ============================ */

test("app 26 y 27: index.html carga solo ./src/app.js como módulo y no referencia el legado", async () => {
    const html = await (await fetch("../index.html")).text();
    const scripts = html.match(/<script[^>]*>/g) || [];
    assertEqual(scripts.length, 1, "un único script");
    assert(scripts[0].indexOf('type="module"') >= 0, "cargado como módulo: " + scripts[0]);
    assert(scripts[0].indexOf('src="./src/app.js"') >= 0, "y apunta a ./src/app.js");
    assertEqual(html.indexOf('src="app.js"'), -1, "sin referencia al app.js legado");
    assertEqual(html.indexOf("onclick"), -1, "sin handlers inline");
    assertEqual(html.indexOf("onsubmit"), -1, "tampoco en el formulario");

    // Y el archivo legado ya no existe.
    const legado = await fetch("../app.js");
    assertEqual(legado.ok, false, "frontend/app.js fue eliminado (HTTP " + legado.status + ")");
});

test("app 28: los mensajes del servidor se escriben como texto y no ejecutan HTML", async () => {
    fresh();
    const { shell } = await loadShell();
    const veneno = '<img src=x onerror="window.__appXss = true">';
    const net = api({ products: () => jsonResponse(200, productPage([product(1, { name: veneno })])) });
    try {
        delete globalThis.__appXss;
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        const celda = shell.querySelector(".crud-table__row .crud-table__cell");
        assertEqual(celda.textContent, veneno, "se muestra literal");
        assertEqual(celda.querySelector("img"), null, "sin elementos creados");
        assertEqual(globalThis.__appXss, undefined, "y sin ejecutar nada");
    } finally { net.restore(); cleanup(); }
});

test("app 29 y 30: estructura accesible, regiones vivas y layout con menú y contenido", async () => {
    fresh();
    const { shell } = await loadShell();
    const net = api({ products: () => jsonResponse(200, productPage([product(1)])) });
    try {
        // Etiquetas asociadas a sus inputs.
        for (const marca of ["data-login-username", "data-login-password"]) {
            const input = shell.querySelector("[" + marca + "]");
            assert(input.id !== "", marca + " tiene id");
            const label = shell.querySelector('label[for="' + input.id + '"]');
            assert(label !== null, "y su label asociada");
        }
        // Regiones vivas.
        for (const marca of ["data-auth-message", "data-degraded-banner", "data-notice"]) {
            assertEqual(shell.querySelector("[" + marca + "]").getAttribute("aria-live"), "polite",
                marca + " es una región viva");
        }
        assertEqual(shell.querySelector('[data-view="boot"]').getAttribute("aria-live"), "polite",
            "el estado de inicialización se anuncia");
        assertEqual(shell.querySelector("[data-resource-nav]").getAttribute("aria-label"), "Recursos",
            "la navegación está etiquetada");
        assertEqual(shell.querySelector("[data-logout]").getAttribute("type"), "button",
            "el logout no es submit");

        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        assert(shell.querySelector("[data-app-header]") !== null, "hay cabecera");
        assert(shell.querySelector("[data-resource-nav] .app-nav__list") !== null, "menú de recursos");
        assert(shell.querySelector("[data-crud-container] .crud") !== null, "área de contenido con el CRUD");
        const seleccionado = shell.querySelector('[data-resource-nav] [aria-current="page"]');
        assertEqual(seleccionado.dataset.resource, "products", "el recurso activo se marca");
    } finally { net.restore(); cleanup(); }
});

/* ================= Logout: desmontaje inmediato y carreras ============== */

test("app 31: el logout desmonta la interfaz ANTES de que responda el backend", async () => {
    fresh();
    const { shell } = await loadShell();
    const puerta = deferred();
    let logouts = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, tokens());
        if (url.includes("/api/auth/logout")) { logouts += 1; return puerta.promise; }
        return jsonResponse(200, productPage([product(1)]));
    });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);
        const instancia = app.getInstance();
        assert(instancia !== null, "había CRUD montado");

        const boton = shell.querySelector("[data-logout]");
        boton.click();
        await tick(3);

        // La petición sigue pendiente y la interfaz YA se retiró.
        assertEqual(shell.dataset.view, "login", "la vista ya es login");
        assertEqual(shell.querySelector('[data-view="app"]').hidden, true, "la app está oculta");
        assertEqual(app.getInstance(), null, "sin instancia");
        assertEqual(instancia.getState().destroyed, true, "el CRUD quedó destruido");
        assertEqual(session.isAuthenticated(), false, "y la sesión local está limpia");

        boton.click();                       // doble logout
        await tick(2);
        assertEqual(logouts, 1, "solo existe UNA petición de logout");

        puerta.resolve(jsonResponse(200, { revoked: true, note: null }));
        await tick(6);
        assertEqual(shell.dataset.view, "login", "y al resolver sigue en el login");
    } finally { net.restore(); cleanup(); }
});

test("app 32, 33 y 34: un logout antiguo que responde tarde no toca la sesión nueva", async () => {
    for (const [caso, respuesta] of [
        ["200", () => jsonResponse(200, { revoked: true, note: null })],
        ["202 best-effort", () => jsonResponse(202, { revoked: false, note: "tier de datos no disponible" })],
        ["503", () => errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-viejo" })]
    ]) {
        fresh();
        const { shell } = await loadShell();
        const puerta = deferred();
        let logins = 0;
        const net = installFetch((url) => {
            if (url.includes("/api/auth/login")) {
                logins += 1;
                return jsonResponse(200, tokens({ username: logins === 1 ? "ana" : "beto" }));
            }
            if (url.includes("/api/auth/logout")) return puerta.promise;
            return jsonResponse(200, productPage([product(1)]));
        });
        try {
            // Sesión A, en la MISMA instancia de aplicación.
            const app = launch(shell);
            await app.ready;
            await loginThrough(app, shell);
            assertEqual(shell.querySelector("[data-user-name]").textContent, "ana", caso + ": sesión A");

            // Logout A: queda pendiente.
            shell.querySelector("[data-logout]").click();
            await tick(3);
            assertEqual(shell.dataset.view, "login", caso + ": ya está en el login");

            // Login B, exitoso.
            await loginThrough(app, shell);
            const instanciaB = app.getInstance();
            assertEqual(shell.dataset.view, "app", caso + ": sesión B montada");
            assertEqual(shell.querySelector("[data-user-name]").textContent, "beto", caso + ": es B");
            assert(instanciaB !== null, caso + ": con su CRUD");

            // Ahora responde el logout ANTIGUO.
            puerta.resolve(respuesta());
            await tick(8);

            assertEqual(shell.dataset.view, "app", caso + ": la sesión B sobrevive");
            assertEqual(shell.querySelector('[data-view="app"]').hidden, false, caso + ": sigue visible");
            assertEqual(app.getInstance(), instanciaB, caso + ": su CRUD es el mismo");
            assertEqual(instanciaB.getState().destroyed, false, caso + ": y no se destruyó");
            assertEqual(shell.querySelector("[data-user-name]").textContent, "beto", caso + ": sin cambiar de usuario");
            assertEqual(session.isAuthenticated(), true, caso + ": la sesión sigue viva");
            assertEqual(shell.querySelector("[data-login-notice]").textContent, "",
                caso + ": el fallo del logout anterior no se atribuye a la sesión nueva");
            assertEqual(shell.querySelector("[data-notice]").textContent, "",
                caso + ": ni aparece en su aviso");
            assertEqual(shell.querySelector("[data-degraded-banner]").hidden, true,
                caso + ": ni la degrada falsamente");
        } finally { net.restore(); cleanup(); }
    }
});

/* ==================== Composición genérica, sin productos =============== */

test("app 35: el shell no codifica ningún recurso; el nombre viene del descriptor", async () => {
    fresh();
    const html = await (await fetch("../index.html")).text();

    // El marcado de composición no puede nombrar un recurso concreto.
    for (const termino of ["product", "Producto", "producto"]) {
        assertEqual(html.indexOf(termino), -1,
            "index.html no debe codificar '" + termino + "' como identidad de la aplicación");
    }
    assert(html.indexOf("<title>Panel de gestión</title>") >= 0, "título genérico");
    assert(html.indexOf("Panel de gestión</h1>") >= 0, "encabezado genérico");

    // Y el nombre visible del recurso sale del registro.
    const { shell } = await loadShell();
    const net = api({ products: () => jsonResponse(200, productPage([product(1)])) });
    try {
        const app = launch(shell);
        await app.ready;
        await loginThrough(app, shell);

        const boton = shell.querySelector("[data-resource-nav] button");
        assertEqual(boton.textContent, products.label, "el menú usa el label del descriptor");
        assertEqual(boton.dataset.resource, products.key, "y su key");
        assertEqual(shell.querySelector(".crud__title").textContent, products.label,
            "el título del CRUD también");
        assertEqual(shell.querySelectorAll("[data-resource-nav] button").length, resources.length,
            "un botón por recurso registrado, sin casos especiales");
    } finally { net.restore(); cleanup(); }
});
}
