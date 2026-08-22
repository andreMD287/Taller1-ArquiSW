/**
 * frontend/tests/platform.test.js — Pruebas de config.js, metrics.js,
 * errors.js y http.js.
 *
 * Ninguna necesita el backend: se sustituye globalThis.fetch de forma
 * controlada. Los casos de timeout y de presupuesto usan configureHttp() para
 * trabajar en decenas de milisegundos; los valores de producción de config.js
 * NO se tocan, y una prueba explícita comprueba que siguen siendo 5000 y 2000.
 */

import { test, assert, assertEqual, assertDeepEqual, assertRejects,
         installFetch, jsonResponse, makeResponse, delayed, neverResolves } from "./harness.js";
import { config, resolveUrl, normalizeBaseUrl } from "../config.js";
import * as metrics from "../src/platform/metrics.js";
import { CATEGORY } from "../src/platform/errors.js";
import { get, post, put, del, configureAuthProvider, configureHttp, resetHttpConfig,
         HttpError } from "../src/platform/http.js";

/** Cada prueba parte de cero: sin muestras, sin proveedor, sin overrides. */
function fresh() {
    metrics.reset();
    configureAuthProvider(null);
    resetHttpConfig();
}

function onlySample() {
    const samples = metrics.getSamples();
    assertEqual(samples.length, 1, "debe registrarse exactamente una muestra por intento");
    return samples[0];
}

/* =================== 1-2. Respuestas correctas con JSON =================== */

test("200 con JSON: devuelve el cuerpo parseado y registra available=1", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, { username: "maria123" }));
    try {
        const result = await get("/api/auth/validate");
        assertEqual(result.status, 200, "status");
        assertEqual(result.data.username, "maria123", "cuerpo parseado");
        const sample = onlySample();
        assertEqual(sample.available, 1, "2xx es disponible");
        assertEqual(sample.httpStatus, 200, "httpStatus");
        assertEqual(sample.timeout, false, "no es timeout");
        assertEqual(sample.cacheHit, false, "cacheHit siempre false en este commit");
        assert(sample.bytes > 0, "debe medir bytes del cuerpo leído");
    } finally {
        net.restore();
    }
});

test("201 con JSON: se trata como éxito y conserva el status", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(201, { id: 42, name: "Teclado" }));
    try {
        const result = await post("/api/products", { body: { name: "Teclado" } });
        assertEqual(result.status, 201, "status 201");
        assertEqual(result.data.id, 42, "cuerpo del recurso creado");
        assertEqual(onlySample().available, 1, "201 es disponible");
    } finally {
        net.restore();
    }
});

/* ============================ 3. 204 sin cuerpo ============================ */

test("204 sin cuerpo: no intenta parsear JSON, devuelve data null y available=1", async () => {
    fresh();
    let textCalls = 0;
    const net = installFetch(() => {
        const response = makeResponse({ status: 204, body: "" });
        const originalText = response.text;
        response.text = async () => { textCalls++; return originalText(); };
        return response;
    });
    try {
        const result = await del("/api/products/42");
        assertEqual(result.status, 204, "status 204");
        assertEqual(result.data, null, "204 no tiene cuerpo: data es null");
        assertEqual(textCalls, 0, "no se debe leer el cuerpo de un 204");
        const sample = onlySample();
        assertEqual(sample.available, 1, "204 es disponible");
        assertEqual(sample.bytes, 0, "sin cuerpo, cero bytes");
        assertEqual(sample.operation, "DELETE /api/products/:id", "id normalizado en la etiqueta");
    } finally {
        net.restore();
    }
});

/* ===================== 4. 422 con violaciones de negocio ==================== */

test("422 ErrorResponse: kind EXPECTED, available=1 y violaciones indexadas por campo", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(422, {
        code: "business_rule_violation",
        kind: "EXPECTED",
        message: "La operacion incumple una o mas reglas de negocio",
        retryable: false,
        requestId: "req-422",
        violations: [
            { rule: "price.must-be-positive", field: "price", message: "El precio debe ser mayor a 0" },
            { rule: "stock.must-not-be-negative", field: "stock", message: "El stock no puede ser negativo" },
            { rule: "global.something", field: null, message: "Violación sin campo" }
        ]
    }));
    try {
        const failure = await assertRejects(post("/api/products", { body: {} }), "422 debe lanzar");
        assert(failure instanceof HttpError, "debe ser HttpError");
        const error = failure.error;
        assertEqual(error.code, "business_rule_violation", "code del backend, tal cual");
        assertEqual(error.kind, "EXPECTED", "kind conservado");
        assertEqual(error.category, CATEGORY.BUSINESS_RULE, "categoría de UI");
        assertEqual(error.violations.length, 3, "violations se conserva como array");
        assertEqual(error.violationsByField.price[0].rule, "price.must-be-positive", "indexado por price");
        assertEqual(error.violationsByField.stock[0].rule, "stock.must-not-be-negative", "indexado por stock");
        assertEqual(error.generalViolations.length, 1, "violación sin field va a generales");
        assertEqual(error.requestId, "req-422", "requestId del cuerpo");
        assertEqual(onlySample().available, 1, "EXPECTED cuenta como disponible");
    } finally {
        net.restore();
    }
});

/* ============ 5. 403 sin cuerpo: robustez del cliente HTTP ================= */

/**
 * ESTO YA NO ES EL COMPORTAMIENTO ACTUAL DEL BACKEND. Hoy un 403 sobre una
 * escritura pasa por GlobalExceptionHandler y llega con un ErrorResponse
 * completo (`code: "access_denied"`, `kind: "EXPECTED"`, `message`, `requestId`),
 * y el accessDeniedHandler de SecurityConfig produce al menos
 * `{"code":"access_denied"}`. La prueba se conserva porque sigue siendo válida
 * como prueba de ROBUSTEZ: un proxy, un cuerpo truncado o un 204 pueden dejar
 * al cliente sin JSON, y en ese caso no debe fabricar un `code` ni perder el
 * requestId de la cabecera. Fija una garantía del cliente, no un contrato del
 * servidor.
 */
test("403 sin cuerpo (robustez, no el caso actual): code null, category forbidden, requestId de cabecera, available=0", async () => {
    fresh();
    const net = installFetch(() => makeResponse({
        status: 403,
        body: "",
        headers: { "X-Request-Id": "req-403-abc" }
    }));
    try {
        const failure = await assertRejects(get("/api/products"), "403 debe lanzar");
        const error = failure.error;
        assertEqual(error.code, null, "el cliente no inventa un code que el backend no produce");
        assertEqual(error.httpStatus, 403, "conserva el status");
        assertEqual(error.category, CATEGORY.FORBIDDEN, "categoría del modelo interno");
        assertEqual(error.requestId, "req-403-abc", "requestId tomado de la cabecera");
        assertEqual(error.kind, null, "sin kind");
        assertEqual(error.retryable, false, "no reintentable");
        assertDeepEqual(error.violations, [], "violations vacío, no ausente");
        assertDeepEqual(error.violationsByField, {}, "sin violaciones por campo");
        assertEqual(onlySample().available, 0, "403 no es disponible");
    } finally {
        net.restore();
    }
});

/* ====================== 6. Error con cuerpo no JSON ======================== */

test("error con texto no JSON: no rompe el parseo y el texto va a detail", async () => {
    fresh();
    const net = installFetch(() => makeResponse({
        status: 500,
        body: "Internal Server Error",
        headers: { "Content-Type": "text/plain" }
    }));
    try {
        const failure = await assertRejects(get("/api/products"), "500 debe lanzar");
        const error = failure.error;
        assertEqual(error.code, null, "sin code: no había ErrorResponse");
        assertEqual(error.category, CATEGORY.SERVER, "categoría server");
        assertEqual(error.message, null, "no se fabrica un message de UI");
        assertEqual(error.detail, "Internal Server Error", "el texto crudo es diagnóstico");
        assertEqual(onlySample().available, 0, "500 no es disponible");
    } finally {
        net.restore();
    }
});

/* =========================== 7. Error de red ============================== */

test("error de red: httpStatus 000, available=0, categoría network", async () => {
    fresh();
    const net = installFetch(() => { throw new TypeError("Failed to fetch"); });
    try {
        const failure = await assertRejects(get("/api/products"), "un fallo de red debe lanzar");
        assertEqual(failure.error.category, CATEGORY.NETWORK, "categoría network");
        assertEqual(failure.error.httpStatus, "000", "convención 000, igual que probe.sh");
        const sample = onlySample();
        assertEqual(sample.available, 0, "sin respuesta no es disponible");
        assertEqual(sample.timeout, false, "no es un timeout");
    } finally {
        net.restore();
    }
});

/* ============================== 8. Timeout ================================ */

test("timeout: categoría timeout, 000, available=0, latencia real y contador propio", async () => {
    fresh();
    configureHttp({ timeoutMs: 60, latencyBudgetMs: 1000 });
    const net = installFetch(neverResolves());
    try {
        const failure = await assertRejects(get("/api/products"), "debe vencer el timeout");
        assertEqual(failure.error.category, CATEGORY.TIMEOUT, "categoría timeout, no network");
        assertEqual(failure.error.httpStatus, "000", "sin respuesta");
        const sample = onlySample();
        assertEqual(sample.available, 0, "un timeout no es disponible");
        assertEqual(sample.timeout, true, "marcado como timeout");
        assert(sample.latencyMs >= 50, "conserva la latencia realmente observada, no 0: " + sample.latencyMs);
        assertEqual(metrics.report().timeouts, 1, "incrementa el contador de timeouts");
    } finally {
        net.restore();
    }
});

/* ======================= 9. Cancelación externa ============================ */

test("cancelación externa: categoría aborted, distinta de timeout y de network", async () => {
    fresh();
    configureHttp({ timeoutMs: 5000 });
    const controller = new AbortController();
    const net = installFetch(delayed(200, jsonResponse(200, {})));
    try {
        const pending = get("/api/products", { signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        const failure = await assertRejects(pending, "una cancelación debe rechazar");
        assertEqual(failure.error.category, CATEGORY.ABORTED, "aborted, no network ni timeout");
        assertEqual(failure.error.retryable, false, "cancelar no es un fallo que se reintente solo");
        const sample = onlySample();
        assertEqual(sample.timeout, false, "no cuenta como timeout");
        assertEqual(metrics.report().timeouts, 0, "no incrementa el contador de timeouts");
    } finally {
        net.restore();
    }
});

/* ================== 10. Presupuesto excedido sin timeout =================== */

test("presupuesto excedido sin timeout: budgetExceeded, latencia real, sigue disponible", async () => {
    fresh();
    // Misma relación que en producción (presupuesto < timeout), a escala de ms.
    configureHttp({ latencyBudgetMs: 20, timeoutMs: 500 });
    const net = installFetch(delayed(60, jsonResponse(200, { ok: true })));
    try {
        const result = await get("/api/products");
        assertEqual(result.status, 200, "responde antes del timeout");
        const sample = onlySample();
        assertEqual(sample.budgetExceeded, true, "excede el presupuesto de latencia");
        assertEqual(sample.timeout, false, "pero no expira");
        assertEqual(sample.available, 1, "una respuesta lenta sigue siendo disponible");
        assert(sample.latencyMs >= 50, "conserva su latencia real: " + sample.latencyMs);
        const summary = metrics.report();
        assertEqual(summary.budgetExceeded, 1, "contador de incumplimientos");
        assertEqual(summary.timeouts, 0, "contador de timeouts separado");
    } finally {
        net.restore();
    }
});

test("los valores de producción no se bajaron para acelerar pruebas", () => {
    assertEqual(config.requestTimeoutMs, 5000, "timeout de producción");
    assertEqual(config.latencyBudgetMs, 2000, "presupuesto de producción");
    assert(config.latencyBudgetMs < config.requestTimeoutMs,
        "el presupuesto debe ser menor que el timeout o la medición queda censurada");
});

/* ==================== 11. Proveedor de autenticación ====================== */

test("sin proveedor no se envía Authorization", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        await get("/api/products");
        assertEqual(net.calls[0].init.headers.Authorization, undefined, "no debe haber Authorization");
        assert(net.calls[0].init.headers["X-Request-Id"], "sí debe haber correlación");
    } finally {
        net.restore();
    }
});

test("con proveedor configurado se envía Bearer, y {auth:false} lo omite", async () => {
    fresh();
    configureAuthProvider({ getToken: () => "t0k3n" });
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        await get("/api/products");
        assertEqual(net.calls[0].init.headers.Authorization, "Bearer t0k3n", "Bearer inyectado");
        await get("/api/diagnostics", { auth: false });
        assertEqual(net.calls[1].init.headers.Authorization, undefined, "auth:false no autoriza");
    } finally {
        net.restore();
    }
});

test("una cabecera Authorization pasada a mano no puede suplantar al proveedor", async () => {
    fresh();
    configureAuthProvider({ getToken: () => "real" });
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        await get("/api/products", { headers: { Authorization: "Bearer falso", "X-Trace": "ok" } });
        assertEqual(net.calls[0].init.headers.Authorization, "Bearer real", "gana el proveedor");
        assertEqual(net.calls[0].init.headers["X-Trace"], "ok", "las cabeceras no críticas sí pasan");
    } finally {
        net.restore();
    }
});

/* ========= 11b. Refresh reactivo ante un 401 sobre petición autenticada ===== */

/**
 * El 401 mínimo que escribe SecurityConfig. NO trae requestId en el cuerpo: el
 * único correlacionador es la cabecera (CONTRATO §1.5).
 */
const unauthorized401 = (requestId = "req-401") => makeResponse({
    status: 401,
    body: '{"code":"unauthorized"}',
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId }
});

/** Proveedor mínimo: un token que cambia tras renovar, y un contador de refresh. */
function authProviderStub({ token = "viejo", onRefresh = null } = {}) {
    const state = { token, refreshes: 0 };
    configureAuthProvider({
        getToken: () => state.token,
        refresh: () => {
            state.refreshes += 1;
            return onRefresh
                ? onRefresh(state)
                : Promise.resolve().then(() => { state.token = "nuevo"; });
        }
    });
    return state;
}

/**
 * Los dos códigos con los que el backend rechaza una sesión inválida deben
 * comportarse igual. Se prueban en tabla para no duplicar la garantía:
 * `invalid_session` nace en un controlador de /api/auth/**, `unauthorized` en el
 * entry point de SecurityConfig — que es el que llega en /api/products.
 */
for (const code of ["invalid_session", "unauthorized"]) {
    test("401 " + code + " con Bearer: un refresh, un reintento y el token nuevo", async () => {
        fresh();
        const auth = authProviderStub();
        let intentos = 0;
        const net = installFetch(() => {
            intentos += 1;
            if (intentos === 1) {
                return code === "unauthorized"
                    ? unauthorized401("req-" + code)
                    : makeResponse({ status: 401,
                        body: JSON.stringify({ code, kind: "EXPECTED", requestId: "req-" + code }),
                        headers: { "Content-Type": "application/json" } });
            }
            return jsonResponse(200, { ok: true });
        });
        try {
            const respuesta = await get("/api/products");

            assertEqual(respuesta.status, 200, "la petición original acaba bien");
            assertEqual(auth.refreshes, 1, "exactamente UN refresh");
            assertEqual(intentos, 2, "exactamente UN reintento");
            assertEqual(net.calls[0].init.headers.Authorization, "Bearer viejo", "el primero llevó el token viejo");
            assertEqual(net.calls[1].init.headers.Authorization, "Bearer nuevo",
                "y el reintento reconstruye cabeceras con el token nuevo");
            assert(net.calls[0].init.headers["X-Request-Id"] !== net.calls[1].init.headers["X-Request-Id"],
                "cada intento lleva su propia correlación");

            // Dos intentos HTTP reales = dos muestras. Ocultar una falsearía la medición.
            const muestras = metrics.getSamples();
            assertEqual(muestras.length, 2, "una muestra por intento HTTP real");
            assertEqual(muestras[1].available, 1, "el reintento es disponible");
            // La disponibilidad del PRIMER intento depende de si el backend
            // etiquetó la respuesta, no de que fuera un 401: `invalid_session`
            // pasa por GlobalExceptionHandler y trae kind EXPECTED —el sistema
            // respondió según su especificación—, mientras que el 401 mínimo de
            // SecurityConfig no trae kind y cuenta como no disponible.
            assertEqual(muestras[0].available, code === "invalid_session" ? 1 : 0,
                "disponibilidad del 401 según traiga kind o no");
            assertEqual(muestras[0].kind, code === "invalid_session" ? "EXPECTED" : null,
                "y el kind observado");
        } finally { net.restore(); }
    });
}

test("401 unauthorized SIN Authorization: se propaga tal cual, cero refresh", async () => {
    fresh();
    // Proveedor presente y CON capacidad de refresh, pero sin token: es el caso
    // de una llamada protegida hecha sin sesión. `auth` conserva su valor por
    // defecto `true`, así que mirar solo `auth !== false` no bastaría.
    const state = { refreshes: 0 };
    configureAuthProvider({
        getToken: () => null,
        refresh: () => { state.refreshes += 1; return Promise.resolve(); }
    });
    const net = installFetch(() => unauthorized401("req-sin-token"));
    try {
        const fallo = await assertRejects(get("/api/products"), "el 401 debe propagarse");

        assertEqual(state.refreshes, 0, "no se pide renovar una sesión que no existe");
        assertEqual(net.calls.length, 1, "un solo intento: sin reintento");
        assertEqual(net.calls[0].init.headers.Authorization, undefined, "salió sin Bearer");
        // Se propaga el 401 real, no un error local por falta de refresh token.
        assertEqual(fallo.error.httpStatus, 401, "conserva el status");
        assertEqual(fallo.error.code, "unauthorized", "conserva el code");
        assertEqual(fallo.error.category, CATEGORY.UNAUTHORIZED, "y su categoría");
        assertEqual(fallo.error.requestId, "req-sin-token", "y el requestId de la cabecera");
    } finally { net.restore(); }
});

test("auth:false con 401: nunca refresca aunque haya token y proveedor", async () => {
    fresh();
    const auth = authProviderStub();
    const net = installFetch(() => unauthorized401("req-publico"));
    try {
        const fallo = await assertRejects(get("/api/diagnostics", { auth: false }), "debe propagarse");
        assertEqual(auth.refreshes, 0, "una llamada no autenticada no renueva nada");
        assertEqual(net.calls.length, 1, "sin reintento");
        assertEqual(net.calls[0].init.headers.Authorization, undefined, "salió sin Bearer");
        assertEqual(fallo.error.requestId, "req-publico", "conserva el requestId");
    } finally { net.restore(); }
});

test("segundo 401 tras el refresh: se propaga y NO hay otro refresh", async () => {
    fresh();
    const auth = authProviderStub();
    const net = installFetch(() => unauthorized401("req-otra-vez"));
    try {
        const fallo = await assertRejects(get("/api/products"), "el segundo 401 debe propagarse");

        assertEqual(auth.refreshes, 1, "una sola renovación: retryAuth:false corta el ciclo");
        assertEqual(net.calls.length, 2, "original + un reintento, y ahí termina");
        assertEqual(fallo.error.httpStatus, 401, "llega el 401");
        assertEqual(fallo.error.code, "unauthorized", "con su code");
        assertEqual(fallo.error.requestId, "req-otra-vez", "y su requestId");
        assertEqual(metrics.getSamples().length, 2, "dos intentos reales, dos muestras");
    } finally { net.restore(); }
});

test("si el refresh falla, se propaga EXACTAMENTE su error, no el 401 que lo disparó", async () => {
    fresh();
    // El refresh rechaza con un 503 propio: ese es el incidente real.
    const errorDelRefresh = new HttpError({
        httpStatus: 503, code: "data_unavailable", kind: "FAILURE",
        retryable: true, requestId: "req-refresh-503", category: CATEGORY.UNAVAILABLE
    });
    const auth = authProviderStub({ onRefresh: () => Promise.reject(errorDelRefresh) });
    const net = installFetch(() => unauthorized401("req-401-original"));
    try {
        const fallo = await assertRejects(get("/api/products"), "debe rechazar");

        assertEqual(fallo, errorDelRefresh, "es el MISMO error, ni envuelto ni sustituido");
        assertEqual(fallo.error.httpStatus, 503, "503 del refresh, no el 401");
        assertEqual(fallo.error.requestId, "req-refresh-503", "con SU requestId, no el del 401");
        assertEqual(auth.refreshes, 1, "se intentó renovar una vez");
        assertEqual(net.calls.length, 1, "y no hubo reintento de la original");
    } finally { net.restore(); }
});

test("403 access_denied nunca refresca, lleve o no Bearer", async () => {
    fresh();
    const auth = authProviderStub();
    const net = installFetch(() => makeResponse({
        status: 403,
        body: JSON.stringify({ code: "access_denied", kind: "EXPECTED",
            message: "No tiene permisos", retryable: false, requestId: "req-403" }),
        headers: { "Content-Type": "application/json", "X-Request-Id": "req-403" }
    }));
    try {
        const fallo = await assertRejects(post("/api/products", { body: {} }), "el 403 se propaga");
        assertEqual(auth.refreshes, 0, "un 403 no dice que la sesión sea inválida");
        assertEqual(net.calls.length, 1, "sin reintento");
        assertEqual(fallo.error.code, "access_denied", "conserva el code");
    } finally { net.restore(); }
});

test("un 401 solo dispara refresh por 401: otros fallos HTTP se propagan intactos", async () => {
    for (const [status, code] of [[400, "validation_error"], [404, "product_not_found"],
                                  [409, "user_already_exists"], [500, "internal_error"],
                                  [503, "data_unavailable"]]) {
        fresh();
        const auth = authProviderStub();
        const net = installFetch(() => makeResponse({
            status,
            body: JSON.stringify({ code, kind: "EXPECTED", requestId: "req-" + status }),
            headers: { "Content-Type": "application/json" }
        }));
        try {
            const fallo = await assertRejects(get("/api/products"), status + " debe propagarse");
            assertEqual(auth.refreshes, 0, status + ": no renueva");
            assertEqual(net.calls.length, 1, status + ": sin reintento");
            assertEqual(fallo.error.code, code, status + ": conserva el code");
        } finally { net.restore(); }
    }
});

/* ======================= 12. La URL viene de config ======================== */

test("la URL base sale solo de config.js y no se duplican barras", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        await get("/api/products");
        await get("api/products");
        assertEqual(net.calls[0].url, config.apiBaseUrl + "/api/products", "con barra inicial");
        assertEqual(net.calls[1].url, config.apiBaseUrl + "/api/products", "sin barra inicial: mismo resultado");
        assert(net.calls[0].url.indexOf("//api") === -1, "sin barras duplicadas");
    } finally {
        net.restore();
    }
});

test("el fallback documentado de config.js es el backend local", () => {
    assertEqual(config.apiBaseUrl, "http://localhost:8080", "fallback deliberado");
    assertEqual(normalizeBaseUrl("http://ejemplo.test///"), "http://ejemplo.test", "recorta barras finales");
    assertEqual(normalizeBaseUrl(undefined), null, "sin valor no hay base");
    assertEqual(resolveUrl("/api/x"), config.apiBaseUrl + "/api/x", "concatenación normalizada");
});

test("los query params se serializan de forma determinista", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        await get("/api/products", { query: { size: 20, name: "tecl", page: 0, sort: ["name,asc", "id,desc"], vacio: null } });
        assertEqual(net.calls[0].url,
            config.apiBaseUrl + "/api/products?name=tecl&page=0&size=20&sort=name%2Casc&sort=id%2Cdesc",
            "claves ordenadas, arrays repetidos, nulos omitidos");
    } finally {
        net.restore();
    }
});

/* ============ fallo local de serialización: NO es un error de red ========== */

test("cuerpo circular: HttpError de categoría client, sin llamar a fetch y sin muestra", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        const circular = { name: "Teclado" };
        circular.self = circular;

        const failure = await assertRejects(post("/api/products", { body: circular }),
            "un cuerpo no serializable debe rechazar");
        assert(failure instanceof HttpError, "debe ser HttpError, no un TypeError crudo");
        const error = failure.error;
        assertEqual(error.category, CATEGORY.CLIENT, "es un fallo local, no de red");
        assert(error.category !== CATEGORY.NETWORK, "nunca network");
        assert(error.category !== CATEGORY.TIMEOUT, "nunca timeout");
        assert(error.category !== CATEGORY.ABORTED, "nunca aborted");
        assertEqual(error.code, null, "sin code: no hubo respuesta del backend");
        assertEqual(error.kind, null, "sin kind");
        assertEqual(error.httpStatus, "000", "no hubo respuesta HTTP");
        assertEqual(error.retryable, false, "reintentar daría el mismo resultado");
        assert(typeof error.requestId === "string" && error.requestId.length > 0,
            "conserva el requestId para correlacionar");
        assert(typeof error.detail === "string" && error.detail.length > 0, "detail diagnóstico");

        assertEqual(net.calls.length, 0, "fetch no debe haberse llamado");
        assertEqual(metrics.getSamples().length, 0, "sin intento HTTP no hay muestra que registrar");
        assertEqual(metrics.report().total, 0, "el informe no cuenta un intento inexistente");
    } finally {
        net.restore();
    }
});

test("cuerpo con BigInt: mismo tratamiento de fallo local", async () => {
    fresh();
    if (typeof BigInt !== "function") {
        return; // el runtime no admite BigInt: nada que comprobar aquí.
    }
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        const failure = await assertRejects(post("/api/products", { body: { stock: BigInt(10) } }),
            "BigInt no es serializable a JSON");
        assertEqual(failure.error.category, CATEGORY.CLIENT, "categoría client");
        assertEqual(failure.error.httpStatus, "000", "sin respuesta HTTP");
        assertEqual(failure.error.retryable, false, "no reintentable");
        assertEqual(net.calls.length, 0, "fetch no se llamó");
        assertEqual(metrics.getSamples().length, 0, "sin muestra");
    } finally {
        net.restore();
    }
});

test("el detalle del fallo local no incluye el cuerpo enviado", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        const secreto = "no-debe-aparecer-en-el-detalle";
        const circular = { password: secreto };
        circular.self = circular;

        const failure = await assertRejects(post("/api/auth/register", { body: circular }));
        assert(failure.error.detail.indexOf(secreto) === -1,
            "el detalle no debe filtrar valores del cuerpo: " + failure.error.detail);
        assert(failure.message.indexOf(secreto) === -1, "ni el mensaje del error");
    } finally {
        net.restore();
    }
});

/* ============================ métricas puras ============================== */

test("percentiles sin muestras devuelven null, no cero", () => {
    metrics.reset();
    assertEqual(metrics.percentile([], 95), null, "p95 sin datos");
    const stats = metrics.latencyStats([]);
    assertEqual(stats.p50, null, "p50 sin datos");
    assertEqual(stats.max, null, "max sin datos");
    assertEqual(stats.count, 0, "cuenta cero");
    assertEqual(metrics.report().availabilityRatio, null, "sin muestras no hay ratio");
});

test("los timeouts entran en los percentiles y no se ocultan", () => {
    metrics.reset();
    metrics.record({ operation: "GET /a", httpStatus: 200, latencyMs: 10 });
    metrics.record({ operation: "GET /a", httpStatus: 200, latencyMs: 20 });
    metrics.record({ operation: "GET /a", httpStatus: "000", latencyMs: 5000, timeout: true });
    const summary = metrics.report();
    assertEqual(summary.latencyMs.count, 3, "el timeout cuenta como muestra de red");
    assertEqual(summary.latencyMs.max, 5000, "su latencia real domina el máximo");
    assertEqual(summary.timeouts, 1, "y además se cuenta aparte");
    assertEqual(summary.available, 2, "2 de 3 disponibles");
});

test("la regla de disponibilidad es única y cubre 2xx, EXPECTED y el resto", () => {
    assertEqual(metrics.isAvailable({ httpStatus: 204 }), 1, "204 disponible");
    assertEqual(metrics.isAvailable({ httpStatus: 422, kind: "EXPECTED" }), 1, "422 EXPECTED disponible");
    assertEqual(metrics.isAvailable({ httpStatus: 403 }), 0, "403 SIN kind no disponible");
    // El 403 vigente de @PreAuthorize pasa por GlobalExceptionHandler y trae
    // kind EXPECTED: negar permisos es el sistema cumpliendo su especificación.
    assertEqual(metrics.isAvailable({ httpStatus: 403, kind: "EXPECTED" }), 1,
        "403 access_denied con kind EXPECTED sí disponible");
    assertEqual(metrics.isAvailable({ httpStatus: "000" }), 0, "sin respuesta no disponible");
    assertEqual(metrics.isAvailable({ httpStatus: 503, kind: "FAILURE" }), 0, "FAILURE no disponible");
});
