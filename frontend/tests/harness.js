/**
 * frontend/tests/harness.js — Arnés de pruebas mínimo, sin dependencias.
 *
 * No hay framework, ni bundler, ni paquetes: ADR-F01 descarta la toolchain, y
 * añadir una solo para probar cuatro módulos contradiría esa decisión. Esto es
 * un registro de pruebas, unas cuantas aserciones y un doble de fetch.
 *
 * CÓMO EJECUTARLAS
 * ----------------
 * 1. NAVEGADOR (mecanismo de verificación de referencia). Los módulos ES no se
 *    cargan desde file://, así que hay que servir el repositorio por HTTP:
 *
 *        python3 -m http.server 8123
 *        # y abrir  http://localhost:8123/frontend/tests/index.html
 *
 *    El total aparece en la página y en la consola del navegador.
 *
 * 2. NODE 18+, únicamente si está instalado y configurado para ejecutar estos
 *    módulos ES:
 *
 *        node frontend/tests/run.js
 *
 * OPCIONAL, NO GARANTIZADO: el binario `jsc` de JavaScriptCore puede ejecutar
 * `jsc -m frontend/tests/run.js`. NO viene garantizado con macOS —en esta
 * máquina no se encuentra ni en PATH ni vía `xcrun`—, solo sirve si está
 * instalado y disponible, y NO fue el mecanismo de verificación final.
 *
 * No hace falta instalar nada más: no hay dependencias, ni toolchain, ni
 * gestor de paquetes.
 *
 * VERIFICACIÓN REPRODUCIBLE CONFIRMADA
 * ------------------------------------
 * Ejecutadas en NAVEGADOR (Chrome, servidas con `python3 -m http.server`) el
 * 2026-08-21: 23 pruebas aprobadas de 23 —las 20 originales del cliente HTTP
 * más las 3 de fallo local de serialización—. El navegador es el mecanismo de
 * verificación de referencia porque es el entorno real de este tier: trae
 * AbortController, crypto.randomUUID y TextEncoder nativos, así que ejercita
 * los caminos que de verdad se van a ejecutar en producción.
 *
 * SHIMS DE ENTORNO
 * ----------------
 * Los motores mínimos no traen todo lo que sí tiene un navegador. Los shims de
 * abajo solo se instalan si algo FALTA, nunca reemplazan una implementación
 * real, y viven en las pruebas: el código de producción no los conoce.
 * Deliberadamente NO se hace shim de crypto ni de TextEncoder, para que las
 * pruebas ejerciten los fallbacks reales de http.js en vez de esconderlos.
 */

/* ------------------------------- shims -------------------------------- */

export function installEnvironmentShims() {
    const installed = [];

    // Algunos motores mínimos traen setTimeout pero no devuelven id ni ofrecen
    // clearTimeout. Sin poder cancelar, el temporizador de timeout seguiría
    // vivo tras cada petición. El navegador y Node no entran por aquí.
    if (typeof globalThis.clearTimeout !== "function") {
        const realSetTimeout = globalThis.setTimeout;
        const cancelled = new Set();
        let nextId = 1;
        globalThis.setTimeout = (fn, ms, ...args) => {
            const id = nextId++;
            realSetTimeout(() => {
                if (!cancelled.has(id)) fn(...args);
            }, ms);
            return id;
        };
        globalThis.clearTimeout = (id) => cancelled.add(id);
        installed.push("setTimeout/clearTimeout");
    }

    if (typeof globalThis.AbortController !== "function") {
        class ShimAbortSignal {
            constructor() {
                this.aborted = false;
                this.reason = undefined;
                this._listeners = [];
            }
            addEventListener(type, fn) {
                if (type === "abort") this._listeners.push(fn);
            }
            removeEventListener(type, fn) {
                if (type !== "abort") return;
                const at = this._listeners.indexOf(fn);
                if (at >= 0) this._listeners.splice(at, 1);
            }
            _fire() {
                for (const fn of this._listeners.slice()) fn();
            }
        }
        globalThis.AbortController = class ShimAbortController {
            constructor() {
                this.signal = new ShimAbortSignal();
            }
            abort(reason) {
                if (this.signal.aborted) return;
                this.signal.aborted = true;
                this.signal.reason = reason;
                this.signal._fire();
            }
        };
        installed.push("AbortController");
    }

    return installed;
}

/* ----------------------------- aserciones ----------------------------- */

export class AssertionError extends Error {}

function fail(message) {
    throw new AssertionError(message);
}

export function assert(condition, message) {
    if (!condition) fail(message || "se esperaba una condición verdadera");
}

export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        fail((message || "valores distintos") + " — esperado " + JSON.stringify(expected) +
             ", obtenido " + JSON.stringify(actual));
    }
}

export function assertDeepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) fail((message || "estructuras distintas") + " — esperado " + e + ", obtenido " + a);
}

export async function assertRejects(promise, message) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    return fail(message || "se esperaba un rechazo y la promesa resolvió");
}

/* -------------------------- registro de pruebas ------------------------ */

const registry = [];

export function test(name, fn) {
    registry.push({ name, fn });
}

export async function run({ log = (line) => console.log(line) } = {}) {
    const shims = installEnvironmentShims();
    if (shims.length > 0) log("shims de entorno instalados: " + shims.join(", "));
    log("");

    let passed = 0;
    const failures = [];
    for (const { name, fn } of registry) {
        try {
            await fn();
            passed++;
            log("  ok    " + name);
        } catch (error) {
            failures.push({ name, error });
            log("  FALLA " + name);
            log("        " + (error && error.message ? error.message : String(error)));
        }
    }

    log("");
    log(passed + " pasaron, " + failures.length + " fallaron, " + registry.length + " en total");
    return { passed, failed: failures.length, total: registry.length, failures };
}

/* ------------------------- dobles de red (fetch) ----------------------- */

/**
 * Respuesta simulada con la superficie que http.js consume de verdad:
 * status, ok, headers.get() y text(). Nada más, para que la prueba no dependa
 * de una implementación completa de Response.
 */
export function makeResponse({ status = 200, body = "", headers = {} } = {}) {
    const lowercased = {};
    for (const [name, value] of Object.entries(headers)) {
        lowercased[name.toLowerCase()] = value;
    }
    return {
        status,
        ok: status >= 200 && status <= 299,
        headers: { get: (name) => lowercased[String(name).toLowerCase()] ?? null },
        text: async () => body
    };
}

export function jsonResponse(status, payload, headers = {}) {
    return makeResponse({ status, body: JSON.stringify(payload), headers });
}

/**
 * Instala un doble de globalThis.fetch y devuelve un registro de las llamadas
 * más una función para restaurar el original.
 *
 * El handler recibe (url, init) y puede devolver una respuesta, una promesa, o
 * lanzar para simular un fallo de red. Si tarda, honra init.signal: así el
 * timeout y la cancelación externa se comportan como en la red real.
 */
export function installFetch(handler) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url, init });
        return handler(url, init, calls.length - 1);
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Respuesta que tarda `ms` y se cancela si el signal aborta antes. */
export function delayed(ms, response) {
    return (url, init) => new Promise((resolve, reject) => {
        const signal = init && init.signal;
        const timer = setTimeout(() => resolve(typeof response === "function" ? response() : response), ms);
        if (signal) {
            signal.addEventListener("abort", () => {
                clearTimeout(timer);
                const error = new Error("The operation was aborted.");
                error.name = "AbortError";
                reject(error);
            });
        }
    });
}

/**
 * Respuesta que nunca llega; solo termina si el signal aborta.
 *
 * No programa ningun temporizador a proposito: un timer pendiente mantiene vivo
 * el bucle de eventos y el proceso de pruebas no terminaria nunca.
 */
export function neverResolves() {
    return (url, init) => new Promise((_resolve, reject) => {
        const signal = init && init.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
        });
    });
}
