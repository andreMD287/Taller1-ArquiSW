/**
 * frontend/tests/session.test.js — Pruebas de session.js y del 401/403 de http.js.
 *
 * Ninguna espera tiempo real ni toca el localStorage del navegador: el reloj,
 * los temporizadores y el almacenamiento entran por configureSession().
 */

import { test, assert, assertEqual, assertRejects, installFetch, jsonResponse, makeResponse,
         memoryStorage, fakeClock, deferred, tick, fakeJwt, tokenPair, errorResponse } from "./harness.js";
import * as metrics from "../src/platform/metrics.js";
import { CATEGORY } from "../src/platform/errors.js";
import { get, configureAuthProvider, resetHttpConfig, HttpError } from "../src/platform/http.js";
import * as session from "../src/platform/session.js";

const KEY = "taller1.session";
const MINUTE = 60_000;

let clock;
let store;

/** Cada prueba parte de cero: sin sesión, sin proveedor, sin muestras. */
function fresh({ seed = null } = {}) {
    session.clear();
    session.resetSessionConfig();
    configureAuthProvider(null);
    resetHttpConfig();
    metrics.reset();
    clock = fakeClock();
    store = memoryStorage(seed ? { [KEY]: JSON.stringify(seed) } : {});
    session.configureSession({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        storage: store
    });
    return { clock, store };
}

/** Registro persistido válido, con las vigencias que pida la prueba. */
function record({ accessOffsetMs = 15 * MINUTE, refreshOffsetMs = 7 * 24 * 60 * MINUTE,
                  role = "USER", accessToken = null } = {}) {
    return {
        version: 1,
        accessToken: accessToken !== null ? accessToken : fakeJwt({ sub: "1", username: "maria123", role }),
        refreshToken: "refresh-guardado",
        username: "maria123",
        accessTokenExpiresAt: new Date(clock.now() + accessOffsetMs).toISOString(),
        refreshTokenExpiresAt: new Date(clock.now() + refreshOffsetMs).toISOString()
    };
}

function pair(overrides = {}) {
    return tokenPair({
        accessExpiresAtMs: clock.now() + 15 * MINUTE,
        refreshExpiresAtMs: clock.now() + 7 * 24 * 60 * MINUTE,
        ...overrides
    });
}

async function loginOk(net, overrides = {}) {
    return session.login("maria123", "unaClaveSegura1");
}

function events() {
    const received = [];
    const off = session.subscribe((event) => received.push(event));
    return { received, off, types: () => received.map((e) => e.type) };
}

/* =========================== Sesión y rol =============================== */

test("sesión 1: login guarda ambos tokens, expiraciones, username y rol", async () => {
    fresh();
    const body = pair({ role: "ADMIN" });
    const net = installFetch(() => jsonResponse(200, body));
    try {
        const result = await session.login("maria123", "unaClaveSegura1");
        assertEqual(result.username, "maria123", "username devuelto");
        assertEqual(session.isAuthenticated(), true, "queda autenticada");
        assertEqual(session.getToken(), body.accessToken, "guarda el access token");
        assertEqual(session.role(), "ADMIN", "rol del token nuevo");
        const saved = store.parsed(KEY);
        assertEqual(saved.refreshToken, body.refreshToken, "guarda el refresh token");
        assertEqual(saved.username, "maria123", "guarda el username");
        assertEqual(saved.accessTokenExpiresAt, body.accessTokenExpiresAt, "guarda la expiración");
        assertEqual(saved.version, 1, "registro versionado");
    } finally {
        net.restore();
    }
});

test("sesión 2: role() devuelve ADMIN y USER", async () => {
    fresh();
    let body = pair({ role: "ADMIN" });
    let net = installFetch(() => jsonResponse(200, body));
    try {
        await loginOk();
        assertEqual(session.role(), "ADMIN", "ADMIN");
    } finally { net.restore(); }

    fresh();
    body = pair({ role: "USER" });
    net = installFetch(() => jsonResponse(200, body));
    try {
        await loginOk();
        assertEqual(session.role(), "USER", "USER");
    } finally { net.restore(); }
});

test("sesión 3: JWT mal formado, claim ausente o rol desconocido devuelve null", async () => {
    for (const [caso, token] of [
        ["mal formado", fakeJwt({ role: "ADMIN" }, { segments: 2 })],
        ["claim ausente", fakeJwt({ sub: "1", username: "maria123" })],
        ["rol desconocido", fakeJwt({ sub: "1", role: "SUPERUSER" })],
        ["payload ilegible", fakeJwt({}, { payloadOverride: "no-es-base64-json" })]
    ]) {
        fresh();
        const net = installFetch(() => jsonResponse(200, pair({ accessToken: token })));
        try {
            await loginOk();
            assertEqual(session.isAuthenticated(), true, caso + ": la sesión sí es válida");
            assertEqual(session.role(), null, caso + ": pero el rol es null");
        } finally { net.restore(); }
    }
});

test("sesión 4: refresh actualiza ambos tokens, expiraciones y rol", async () => {
    fresh();
    const primero = pair({ role: "USER", refreshToken: "refresh-1" });
    const segundo = pair({ role: "ADMIN", refreshToken: "refresh-2", accessExpiresAtMs: clock.now() + 30 * MINUTE });
    let call = 0;
    const net = installFetch(() => jsonResponse(200, call++ === 0 ? primero : segundo));
    try {
        await loginOk();
        assertEqual(session.role(), "USER", "rol inicial");
        await session.refresh();
        assertEqual(session.getToken(), segundo.accessToken, "access token nuevo");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-2", "refresh token nuevo");
        assertEqual(session.role(), "ADMIN", "rol recalculado desde el token nuevo");
        assertEqual(store.parsed(KEY).accessTokenExpiresAt, segundo.accessTokenExpiresAt, "expiración nueva");
    } finally { net.restore(); }
});

test("sesión 5: token vencido con claim ADMIN no autentica ni da rol", async () => {
    fresh();
    const body = pair({ role: "ADMIN" });
    const net = installFetch(() => jsonResponse(200, body));
    try {
        await loginOk();
        assertEqual(session.role(), "ADMIN", "vigente sí da rol");
        clock.set(clock.now() + 16 * MINUTE);      // el access token venció
        assertEqual(session.isAuthenticated(), false, "ya no está autenticada");
        assertEqual(session.getToken(), null, "no se entrega un token vencido");
        assertEqual(session.role(), null, "un token muerto no pinta controles de ADMIN");
    } finally { net.restore(); }
});

/* ============================ Coordinación ============================== */

test("sesión 6: dos 401 invalid_session simultáneos causan un solo /refresh", async () => {
    fresh();
    const inicial = pair();
    const renovado = pair({ refreshToken: "refresh-2" });
    let refreshCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, inicial);
        if (url.includes("/api/auth/refresh")) { refreshCalls++; return jsonResponse(200, renovado); }
        // /api/products: 401 la primera vez para cada una, 200 en el reintento
        return net.calls.filter((c) => c.url.includes("/api/products")).length <= 2
            ? errorResponse(401, { code: "invalid_session" })
            : jsonResponse(200, { ok: true });
    });
    try {
        await loginOk();
        const [a, b] = await Promise.all([get("/api/products"), get("/api/products")]);
        assertEqual(a.status, 200, "la primera se recupera");
        assertEqual(b.status, 200, "la segunda también");
        assertEqual(refreshCalls, 1, "un ÚNICO canje del refresh token");
    } finally { net.restore(); }
});

test("sesión 7: refresh proactivo en vuelo más dos 401 comparten un único /refresh", async () => {
    fresh();
    const inicial = pair();
    const gate = deferred();
    let refreshCalls = 0;
    let productCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, inicial);
        if (url.includes("/api/auth/refresh")) { refreshCalls++; return gate.promise; }
        productCalls++;
        return productCalls <= 2 ? errorResponse(401, { code: "invalid_session" }) : jsonResponse(200, { ok: true });
    });
    try {
        await loginOk();
        // Dispara el temporizador proactivo: queda un refresh en vuelo.
        clock.advance(14 * MINUTE + 1000);
        await tick(2);
        assertEqual(refreshCalls, 1, "el proactivo arrancó");

        const enVuelo = Promise.all([get("/api/products"), get("/api/products")]);
        await tick(4);
        assertEqual(refreshCalls, 1, "los dos 401 NO abrieron un segundo canje");

        gate.resolve(jsonResponse(200, pair({ refreshToken: "refresh-2" })));
        const [a, b] = await enVuelo;
        assertEqual(a.status, 200, "la primera se recupera");
        assertEqual(b.status, 200, "la segunda también");
        assertEqual(refreshCalls, 1, "sigue habiendo un solo /refresh");
    } finally { net.restore(); }
});

test("sesión 8: refresh() devuelve estrictamente la misma promesa durante una renovación", async () => {
    fresh();
    const gate = deferred();
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, pair());
        return gate.promise;
    });
    try {
        await loginOk();
        const primera = session.refresh();
        const segunda = session.refresh();
        assert(primera === segunda, "identidad estricta: debe ser el MISMO objeto promesa");
        gate.resolve(jsonResponse(200, pair({ refreshToken: "refresh-2" })));
        await primera;
        const tercera = session.refresh();
        assert(tercera !== primera, "terminada la renovación, una nueva es otra promesa");
        gate.resolve(jsonResponse(200, pair({ refreshToken: "refresh-3" })));
        await tercera.catch(() => {});
    } finally { net.restore(); }
});

test("sesión 9 y 10: cada petición se reintenta una sola vez y el reintento lleva retryAuth:false", async () => {
    fresh();
    let productCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, pair());
        if (url.includes("/api/auth/refresh")) return jsonResponse(200, pair({ refreshToken: "refresh-2" }));
        productCalls++;
        return errorResponse(401, { code: "invalid_session" });   // SIEMPRE 401
    });
    try {
        await loginOk();
        const failure = await assertRejects(get("/api/products"), "el segundo 401 debe propagarse");
        assertEqual(failure.error.httpStatus, 401, "propaga el 401");
        assertEqual(productCalls, 2, "original + UN reintento, no más");
        const refreshCalls = net.calls.filter((c) => c.url.includes("/api/auth/refresh")).length;
        assertEqual(refreshCalls, 1, "el reintento no volvió a refrescar: llevaba retryAuth:false");
    } finally { net.restore(); }
});

test("sesión 11: login, refresh y logout no llevan Authorization", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, pair({ refreshToken: "refresh-2" })));
    try {
        await loginOk();
        await session.refresh();
        await session.logout();
        for (const call of net.calls) {
            assertEqual(call.init.headers.Authorization, undefined,
                "sin Authorization en " + call.url);
        }
        assert(net.calls.length >= 3, "se hicieron las tres llamadas");
    } finally { net.restore(); }
});

test("sesión 12 y 13: un fallo del refresh no recurre, y una renovación posterior sí se ejecuta", async () => {
    fresh();
    let refreshCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, pair());
        if (url.includes("/api/auth/refresh")) {
            refreshCalls++;
            return refreshCalls === 1
                ? errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-503" })
                : jsonResponse(200, pair({ refreshToken: "refresh-2" }));
        }
        return jsonResponse(200, {});
    });
    try {
        await loginOk();
        await assertRejects(session.refresh(), "el primer refresh falla");
        assertEqual(refreshCalls, 1, "un 401/503 del propio refresh no dispara otro refresh: sin recursión");
        await session.refresh();
        assertEqual(refreshCalls, 2, "tras fallar, el estado en vuelo quedó limpio y se puede reintentar");
        assertEqual(session.getToken() !== null, true, "la segunda renovación sí guardó el par");
    } finally { net.restore(); }
});

/* ========================= Errores y eventos ============================ */

test("sesión 14: refresh con 401 limpia la sesión y emite session:expired", async () => {
    fresh();
    const net = installFetch((url) => url.includes("/api/auth/login")
        ? jsonResponse(200, pair())
        : errorResponse(401, { code: "invalid_session", requestId: "req-401" }));
    try {
        await loginOk();
        const bus = events();
        const failure = await assertRejects(session.refresh(), "debe rechazar");
        assert(failure instanceof HttpError, "rechaza con HttpError");
        assertEqual(failure.error.code, "invalid_session", "el mismo error");
        assertEqual(session.isAuthenticated(), false, "limpia la sesión");
        assertEqual(store.raw(KEY), null, "y también el almacenamiento");
        assertEqual(bus.types().join(), "session:expired", "emite session:expired");
        assertEqual(bus.received[0].requestId, "req-401", "con el requestId");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 15 y 16: refresh con 503 conserva estado, propaga el mismo error y no reprograma", async () => {
    fresh();
    const net = installFetch((url) => url.includes("/api/auth/login")
        ? jsonResponse(200, pair())
        : errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-503" }));
    try {
        await loginOk();
        const bus = events();
        const failure = await assertRejects(session.refresh(), "debe rechazar");
        assertEqual(failure.error.code, "data_unavailable", "el MISMO error del refresh, no un 401 inventado");
        assertEqual(failure.error.requestId, "req-503", "con su propio requestId");
        assertEqual(session.isAuthenticated(), true, "NO es una sesión expirada: el access token sigue vivo");
        assert(store.raw(KEY) !== null, "conserva el registro para un reintento manual");
        assertEqual(bus.types().join(), "system:degraded", "emite system:degraded, no session:expired");
        assertEqual(clock.pending(), 0, "no programa otro refresh automático");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 17: un 403 sin cuerpo emite session:forbidden, conserva la sesión y el requestId", async () => {
    fresh();
    const net = installFetch((url) => url.includes("/api/auth/login")
        ? jsonResponse(200, pair())
        : makeResponse({ status: 403, body: "", headers: { "X-Request-Id": "req-403" } }));
    try {
        await loginOk();
        const bus = events();
        const failure = await assertRejects(get("/api/products"), "el 403 debe propagarse");
        assertEqual(failure.error.category, CATEGORY.FORBIDDEN, "categoría forbidden");
        assertEqual(failure.error.code, null, "un 403 sin cuerpo no trae code, y no se inventa");
        assertEqual(bus.types().join(), "session:forbidden", "emite session:forbidden");
        assertEqual(bus.received[0].requestId, "req-403", "conserva el requestId de la cabecera");
        assertEqual(session.isAuthenticated(), true, "NO cierra la sesión");
        const refreshCalls = net.calls.filter((c) => c.url.includes("/api/auth/refresh")).length;
        assertEqual(refreshCalls, 0, "y NO refresca");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 18: suscripción y desuscripción funcionan", async () => {
    fresh();
    const recibidos = [];
    const off = session.subscribe((e) => recibidos.push(e.type));
    const net = installFetch((url) => url.includes("/api/auth/login")
        ? jsonResponse(200, pair())
        : errorResponse(401, { code: "invalid_session" }));
    try {
        await loginOk();
        await assertRejects(session.refresh(), "primer fallo");
        assertEqual(recibidos.length, 1, "el listener recibe");

        // La baja se comprueba SIN reiniciar el módulo: si se llamara a fresh()
        // en medio, la prueba pasaría por el reinicio y no por unsubscribe().
        off();
        await loginOk();
        await assertRejects(session.refresh(), "segundo fallo");
        assertEqual(recibidos.length, 1, "tras unsubscribe() ya no recibe");
    } finally { net.restore(); }
});

test("sesión 19: un listener que lanza no afecta a los demás ni a la operación", async () => {
    fresh();
    const vistos = [];
    session.subscribe(() => { throw new Error("listener roto"); });
    session.subscribe((e) => vistos.push(e.type));
    const net = installFetch((url) => url.includes("/api/auth/login")
        ? jsonResponse(200, pair())
        : errorResponse(401, { code: "invalid_session", requestId: "req-x" }));
    try {
        await loginOk();
        const failure = await assertRejects(session.refresh(), "la operación sigue su curso");
        assertEqual(failure.error.code, "invalid_session", "el resultado HTTP no cambia");
        assertEqual(vistos.join(), "session:expired", "el segundo listener sí recibió el evento");
    } finally { net.restore(); }
});

/* ============================ Restauración ============================== */

test("sesión 20: importar el módulo no produce efectos", async () => {
    fresh();
    const realSetTimeout = globalThis.setTimeout;
    const realFetch = globalThis.fetch;
    let timers = 0;
    let fetches = 0;
    globalThis.setTimeout = (...args) => { timers++; return realSetTimeout(...args); };
    globalThis.fetch = async (...args) => { fetches++; return realFetch ? realFetch(...args) : undefined; };
    try {
        // Instancia NUEVA del módulo: el navegador la evalúa desde cero.
        const fresco = await import("../src/platform/session.js?probe=" + Date.now());
        assertEqual(timers, 0, "importar no programa temporizadores");
        assertEqual(fetches, 0, "importar no hace peticiones");
        assertEqual(fresco.isAuthenticated(), false, "no hay sesión sin restaurar");

        const probeStore = memoryStorage();
        const probeClock = fakeClock();
        fresco.configureSession({ now: probeClock.now, setTimeout: probeClock.setTimeout,
                                   clearTimeout: probeClock.clearTimeout, storage: probeStore });
        assertEqual(probeStore.counts.getItem, 0, "configurar tampoco lee el almacenamiento");
        await fresco.restore();
        assertEqual(probeStore.counts.getItem, 1, "la lectura ocurre SOLO al llamar a restore()");
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.fetch = realFetch;
        configureAuthProvider(null);
    }
});

test("sesión 21: access token vigente restaura sin llamar a /refresh", async () => {
    fresh();
    store.data.set(KEY, JSON.stringify(record({ role: "ADMIN" })));
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        const result = await session.restore();
        assertEqual(result.authenticated, true, "resuelve autenticada");
        assertEqual(session.role(), "ADMIN", "rol desde el token restaurado");
        assertEqual(net.calls.length, 0, "no llama al backend");
        assertEqual(clock.pending(), 1, "programa la renovación proactiva");
    } finally { net.restore(); }
});

test("sesión 22 y 23: access vencido con refresh vigente renueva una vez y no autentica mientras tanto", async () => {
    fresh();
    store.data.set(KEY, JSON.stringify(record({ accessOffsetMs: -MINUTE, role: "ADMIN" })));
    const gate = deferred();
    let refreshCalls = 0;
    const net = installFetch(() => { refreshCalls++; return gate.promise; });
    try {
        const pendiente = session.restore();
        await tick(3);
        assertEqual(session.isAuthenticated(), false, "durante la renovación NO está autenticada");
        assertEqual(session.getToken(), null, "no entrega el access token vencido");
        assertEqual(session.role(), null, "ni su rol");
        gate.resolve(jsonResponse(200, pair({ role: "ADMIN", refreshToken: "refresh-2" })));
        const result = await pendiente;
        assertEqual(result.authenticated, true, "termina autenticada");
        assertEqual(refreshCalls, 1, "una sola llamada a /refresh");
        assertEqual(session.role(), "ADMIN", "rol del token nuevo");
    } finally { net.restore(); }
});

test("sesión 24: refresh token vencido limpia sin hacer ninguna petición", async () => {
    fresh();
    store.data.set(KEY, JSON.stringify(record({ accessOffsetMs: -MINUTE, refreshOffsetMs: -MINUTE })));
    const net = installFetch(() => jsonResponse(200, {}));
    try {
        const result = await session.restore();
        assertEqual(result.authenticated, false, "resuelve sin sesión");
        assertEqual(net.calls.length, 0, "sin llamadas al backend");
        assertEqual(store.raw(KEY), null, "limpia el registro");
        assertEqual(clock.pending(), 0, "sin temporizadores");
    } finally { net.restore(); }
});

test("sesión 25: registro ausente o corrupto limpia sin lanzar", async () => {
    for (const [caso, valor] of [
        ["ausente", null],
        ["JSON corrupto", "{no es json"],
        ["versión desconocida", JSON.stringify({ version: 99, accessToken: "a", refreshToken: "b" })],
        ["campos ausentes", JSON.stringify({ version: 1, accessToken: "a" })],
        ["fecha inválida", JSON.stringify({ version: 1, accessToken: "a", refreshToken: "b",
                                            username: "m", accessTokenExpiresAt: "no-es-fecha" })]
    ]) {
        fresh();
        if (valor !== null) store.data.set(KEY, valor);
        const net = installFetch(() => jsonResponse(200, {}));
        try {
            const result = await session.restore();
            assertEqual(result.authenticated, false, caso + ": resuelve sin sesión");
            assertEqual(net.calls.length, 0, caso + ": sin peticiones");
            assertEqual(store.raw(KEY), null, caso + ": deja el almacenamiento limpio");
        } finally { net.restore(); }
    }
});

test("sesión 26: dos restore() concurrentes comparten la misma promesa", async () => {
    fresh();
    store.data.set(KEY, JSON.stringify(record({ accessOffsetMs: -MINUTE })));
    const gate = deferred();
    let refreshCalls = 0;
    const net = installFetch(() => { refreshCalls++; return gate.promise; });
    try {
        const a = session.restore();
        const b = session.restore();
        assert(a === b, "la misma promesa, no dos restauraciones");
        gate.resolve(jsonResponse(200, pair({ refreshToken: "refresh-2" })));
        await a;
        assertEqual(refreshCalls, 1, "y un solo canje del refresh token");
    } finally { net.restore(); }
});

test("sesión 27: restore() con 503 rechaza con el mismo error, conserva registro y no deja temporizador", async () => {
    fresh();
    store.data.set(KEY, JSON.stringify(record({ accessOffsetMs: -MINUTE })));
    const net = installFetch(() => errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-503" }));
    try {
        const bus = events();
        const failure = await assertRejects(session.restore(), "restore() debe RECHAZAR, no resolver");
        assert(failure instanceof HttpError, "rechaza con HttpError");
        assertEqual(failure.error.code, "data_unavailable", "exactamente el error del refresh");
        assertEqual(failure.error.requestId, "req-503", "con su requestId");
        assert(store.raw(KEY) !== null, "conserva el registro para un reintento manual");
        assertEqual(session.isAuthenticated(), false, "permanece sin autenticar");
        assertEqual(bus.types().join(), "system:degraded", "emite degradación");
        assertEqual(clock.pending(), 0, "no deja temporizador");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 28: restore() con 401 rechaza con el mismo error, limpia y emite expiración", async () => {
    fresh();
    store.data.set(KEY, JSON.stringify(record({ accessOffsetMs: -MINUTE })));
    const net = installFetch(() => errorResponse(401, { code: "invalid_session", requestId: "req-401" }));
    try {
        const bus = events();
        const failure = await assertRejects(session.restore(), "restore() debe RECHAZAR");
        assertEqual(failure.error.code, "invalid_session", "el mismo error");
        assertEqual(store.raw(KEY), null, "limpia el registro");
        assertEqual(session.isAuthenticated(), false, "sin sesión");
        assertEqual(bus.types().join(), "session:expired", "emite session:expired");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 29: el par se sustituye mediante un único registro completo", async () => {
    fresh();
    let call = 0;
    const net = installFetch(() => jsonResponse(200, call++ === 0
        ? pair({ refreshToken: "refresh-1" })
        : pair({ refreshToken: "refresh-2", accessToken: fakeJwt({ sub: "1", role: "ADMIN" }) })));
    try {
        await loginOk();
        const escriturasTrasLogin = store.counts.setItem;
        await session.refresh();
        assertEqual(store.counts.setItem - escriturasTrasLogin, 1,
            "una sola escritura para sustituir el par completo");
        const guardado = store.parsed(KEY);
        assertEqual(guardado.refreshToken, "refresh-2", "refresh token nuevo");
        assertEqual(guardado.accessToken.split(".").length, 3, "access token nuevo");
        // Ninguna escritura intermedia pudo dejar un par mezclado.
        for (const raw of store.writes) {
            const registro = JSON.parse(raw);
            assert(Boolean(registro.accessToken) && Boolean(registro.refreshToken),
                "ninguna escritura deja el registro a medias");
        }
    } finally { net.restore(); }
});

/* ====================== Carreras y temporizadores ======================= */

test("sesión 30: logout limpia aunque el backend falle", async () => {
    fresh();
    let call = 0;
    const net = installFetch(() => {
        if (call++ === 0) return jsonResponse(200, pair());
        throw new TypeError("Failed to fetch");
    });
    try {
        await loginOk();
        await assertRejects(session.logout(), "el fallo remoto se propaga");
        assertEqual(session.isAuthenticated(), false, "pero el estado local se limpió igual");
        assertEqual(store.raw(KEY), null, "y el almacenamiento también");
        assertEqual(clock.pending(), 0, "sin temporizadores pendientes");
    } finally { net.restore(); }
});

test("sesión 31: un refresh tardío después de logout no restaura tokens", async () => {
    fresh();
    const gate = deferred();
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, pair());
        if (url.includes("/api/auth/refresh")) return gate.promise;
        return jsonResponse(200, { revoked: true, note: null });
    });
    try {
        await loginOk();
        const pendiente = session.refresh();
        await session.logout();
        assertEqual(session.isAuthenticated(), false, "logout limpió");
        gate.resolve(jsonResponse(200, pair({ refreshToken: "refresh-zombie" })));
        await pendiente;
        assertEqual(session.isAuthenticated(), false, "el refresh tardío NO resucita la sesión");
        assertEqual(store.raw(KEY), null, "ni reescribe el almacenamiento");
        assertEqual(clock.pending(), 0, "ni programa temporizadores");
    } finally { net.restore(); }
});

test("sesión 32, 33 y 34: un refresh viejo no pisa el login nuevo, ni su promesa, ni emite sobre ella", async () => {
    fresh();
    const viejo = deferred();
    const nuevoRefresh = deferred();
    const loginNuevo = pair({ refreshToken: "refresh-del-login-nuevo", role: "ADMIN" });
    let refreshCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) {
            return net.calls.filter((c) => c.url.includes("/api/auth/login")).length === 1
                ? jsonResponse(200, pair({ refreshToken: "refresh-viejo" }))
                : jsonResponse(200, loginNuevo);
        }
        refreshCalls++;
        return refreshCalls === 1 ? viejo.promise : nuevoRefresh.promise;
    });
    try {
        await loginOk();
        const bus = events();
        const refreshViejo = session.refresh();          // generación anterior, en vuelo

        await session.login("otra", "otraClaveSegura1"); // sesión nueva
        assertEqual(session.getToken(), loginNuevo.accessToken, "manda el login nuevo");

        const refreshNuevo = session.refresh();          // promesa de la sesión nueva
        assert(refreshNuevo !== refreshViejo, "son promesas distintas");

        // Ahora termina el VIEJO, después de todo lo demás, con un 401 real del
        // backend: es el fallo que SÍ cerraría la sesión si no se descartara por
        // pertenecer a una generación anterior.
        viejo.resolve(errorResponse(401, { code: "invalid_session", requestId: "req-viejo" }));
        await refreshViejo.catch(() => {});
        await tick(2);

        assertEqual(session.getToken(), loginNuevo.accessToken, "el par del login nuevo sigue intacto");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-del-login-nuevo", "y el persistido también");
        assertEqual(session.role(), "ADMIN", "el rol derivado no cambió");
        assertEqual(bus.types().length, 0, "un fallo viejo NO emite eventos sobre la sesión nueva");
        assert(session.refresh() === refreshNuevo, "el finally del viejo NO borró la promesa nueva");

        nuevoRefresh.resolve(jsonResponse(200, pair({ refreshToken: "refresh-3" })));
        await refreshNuevo;
        bus.off();
    } finally { net.restore(); }
});

test("sesión 35: no quedan temporizadores pendientes al limpiar o reemplazar la sesión", async () => {
    fresh();
    let call = 0;
    const net = installFetch(() => jsonResponse(200, call++ === 0
        ? pair({ refreshToken: "refresh-1" })
        : pair({ refreshToken: "refresh-2" })));
    try {
        await loginOk();
        assertEqual(clock.pending(), 1, "el login dejó exactamente un temporizador");
        await loginOk();
        assertEqual(clock.pending(), 1, "reemplazar la sesión no acumula temporizadores");
        session.clear();
        assertEqual(clock.pending(), 0, "clear() cancela el temporizador");
    } finally { net.restore(); }
});

/* ================= Carreras entre operaciones de sesión ================== */
/*
 * Estas pruebas ocurren DENTRO DE UNA MISMA INSTANCIA y sin fresh() entre los
 * pasos: una carrera que solo se sostiene reiniciando el módulo entre pasos no
 * demuestra nada sobre el módulo.
 */

test("sesión 36: dos login concurrentes — B responde primero y A después: gana B", async () => {
    fresh();
    const gateA = deferred();
    const gateB = deferred();
    const sesionB = pair({ username: "beto", refreshToken: "refresh-de-B", role: "ADMIN" });
    let loginCalls = 0;
    const net = installFetch(() => (loginCalls++ === 0 ? gateA.promise : gateB.promise));
    try {
        const loginA = session.login("ana", "claveDeAna123");
        const loginB = session.login("beto", "claveDeBeto123");

        // B responde primero y se establece.
        gateB.resolve(jsonResponse(200, sesionB));
        const resultadoB = await loginB;
        assertEqual(resultadoB.username, "beto", "B autenticó");
        const escriturasTrasB = store.counts.setItem;
        const temporizadoresTrasB = clock.pending();

        // A responde DESPUÉS: es el login viejo.
        gateA.resolve(jsonResponse(200, pair({ username: "ana", refreshToken: "refresh-de-A" })));
        const resultadoA = await loginA;

        assertEqual(resultadoA.stale, true, "el login viejo se declara obsoleto");
        assertEqual(resultadoA.applied, false, "y no aplicado");
        assertEqual(resultadoA.authenticated, false, "no finge haber autenticado");
        assertEqual(session.getToken(), sesionB.accessToken, "la sesión de B queda intacta");
        assertEqual(session.getUsername(), "beto", "el username no cambió");
        assertEqual(session.role(), "ADMIN", "el rol tampoco");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-de-B", "ni el almacenamiento");
        assertEqual(store.counts.setItem, escriturasTrasB, "el login viejo NO escribió tarde");
        assertEqual(clock.pending(), temporizadoresTrasB, "ni creó un segundo temporizador");
    } finally { net.restore(); }
});

test("sesión 37: un error tardío del login A no limpia ni altera la sesión de B", async () => {
    fresh();
    const gateA = deferred();
    const gateB = deferred();
    const sesionB = pair({ username: "beto", refreshToken: "refresh-de-B" });
    let loginCalls = 0;
    const net = installFetch(() => (loginCalls++ === 0 ? gateA.promise : gateB.promise));
    try {
        const bus = events();
        const loginA = session.login("ana", "claveDeAna123");
        const loginB = session.login("beto", "claveDeBeto123");

        gateB.resolve(jsonResponse(200, sesionB));
        await loginB;

        // A falla, y falla tarde.
        gateA.resolve(errorResponse(401, { code: "invalid_credentials", requestId: "req-A" }));
        const fallo = await assertRejects(loginA, "el login A propaga su error");
        assertEqual(fallo.error.code, "invalid_credentials", "el HttpError original se conserva");

        assertEqual(session.isAuthenticated(), true, "la sesión de B sigue viva");
        assertEqual(session.getToken(), sesionB.accessToken, "con su token");
        assert(store.raw(KEY) !== null, "y su registro persistido");
        assertEqual(bus.types().length, 0, "un fallo ajeno no emite eventos sobre la sesión de B");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 38: logout lento + login nuevo (200): la sesión nueva permanece completa", async () => {
    fresh();
    const gateLogout = deferred();
    const sesionNueva = pair({ username: "beto", refreshToken: "refresh-nuevo", role: "ADMIN" });
    const net = installFetch((url) => {
        if (url.includes("/api/auth/logout")) return gateLogout.promise;
        return jsonResponse(200, net.calls.filter((c) => c.url.includes("/api/auth/login")).length === 1
            ? pair({ username: "ana", refreshToken: "refresh-viejo" })
            : sesionNueva);
    });
    try {
        await session.login("ana", "claveDeAna123");
        const logoutLento = session.logout();
        await session.login("beto", "claveDeBeto123");
        assertEqual(session.getToken(), sesionNueva.accessToken, "la sesión nueva quedó establecida");

        gateLogout.resolve(jsonResponse(200, { revoked: true, note: null }));
        await logoutLento;

        assertEqual(session.isAuthenticated(), true, "el logout viejo NO borró la sesión nueva");
        assertEqual(session.getToken(), sesionNueva.accessToken, "el token sigue siendo el nuevo");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-nuevo", "y el registro también");
        assertEqual(session.role(), "ADMIN", "el rol se conserva");
    } finally { net.restore(); }
});

test("sesión 39: la misma carrera cuando el logout termina con error de red", async () => {
    fresh();
    const gateLogout = deferred();
    const sesionNueva = pair({ username: "beto", refreshToken: "refresh-nuevo" });
    const net = installFetch((url) => {
        if (url.includes("/api/auth/logout")) return gateLogout.promise;
        return jsonResponse(200, net.calls.filter((c) => c.url.includes("/api/auth/login")).length === 1
            ? pair({ username: "ana" })
            : sesionNueva);
    });
    try {
        await session.login("ana", "claveDeAna123");
        const logoutLento = session.logout();
        await session.login("beto", "claveDeBeto123");

        gateLogout.reject(new TypeError("Failed to fetch"));
        await assertRejects(logoutLento, "el fallo de red se propaga");

        assertEqual(session.isAuthenticated(), true, "pero la sesión nueva sobrevive");
        assertEqual(session.getToken(), sesionNueva.accessToken, "intacta");
        assert(store.raw(KEY) !== null, "y su registro sigue guardado");
    } finally { net.restore(); }
});

test("sesión 40: la misma carrera cuando el logout termina con 202", async () => {
    fresh();
    const gateLogout = deferred();
    const sesionNueva = pair({ username: "beto", refreshToken: "refresh-nuevo" });
    const net = installFetch((url) => {
        if (url.includes("/api/auth/logout")) return gateLogout.promise;
        return jsonResponse(200, net.calls.filter((c) => c.url.includes("/api/auth/login")).length === 1
            ? pair({ username: "ana" })
            : sesionNueva);
    });
    try {
        await session.login("ana", "claveDeAna123");
        const logoutLento = session.logout();
        await session.login("beto", "claveDeBeto123");

        // 202: éxito best-effort, el tier de datos no estaba disponible.
        gateLogout.resolve(jsonResponse(202, { revoked: false, note: "tier de datos no disponible" }));
        const resultado = await logoutLento;

        assertEqual(resultado.status, 202, "el 202 es éxito, no error");
        assertEqual(resultado.revoked, false, "y lo dice");
        assertEqual(session.isAuthenticated(), true, "la sesión nueva no se ve afectada");
        assertEqual(session.getToken(), sesionNueva.accessToken, "sigue completa");
    } finally { net.restore(); }
});

test("sesión 41: el estado antiguo se elimina ANTES de que termine la llamada remota", async () => {
    fresh();
    const gateLogout = deferred();
    const net = installFetch((url) => url.includes("/api/auth/logout")
        ? gateLogout.promise
        : jsonResponse(200, pair()));
    try {
        await session.login("ana", "claveDeAna123");
        assertEqual(session.isAuthenticated(), true, "sesión establecida");

        const logoutLento = session.logout();
        await tick(2);

        assertEqual(session.isAuthenticated(), false, "limpia SIN esperar al backend");
        assertEqual(session.getToken(), null, "sin token");
        assertEqual(store.raw(KEY), null, "sin registro persistido");
        assertEqual(clock.pending(), 0, "sin temporizadores");

        gateLogout.resolve(jsonResponse(200, { revoked: true, note: null }));
        await logoutLento;
        assertEqual(session.isAuthenticated(), false, "y sigue cerrada al terminar");
    } finally { net.restore(); }
});

test("sesión 42: login pendiente + logout: la sesión sigue cerrada cuando el login responde", async () => {
    fresh();
    const gateLogin = deferred();
    let call = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/logout")) return jsonResponse(200, { revoked: true, note: null });
        return call++ === 0 ? jsonResponse(200, pair({ username: "ana" })) : gateLogin.promise;
    });
    try {
        await session.login("ana", "claveDeAna123");
        const loginPendiente = session.login("beto", "claveDeBeto123");
        await session.logout();
        assertEqual(session.isAuthenticated(), false, "logout cerró");

        gateLogin.resolve(jsonResponse(200, pair({ username: "beto", refreshToken: "refresh-zombie" })));
        const resultado = await loginPendiente;

        assertEqual(resultado.stale, true, "el login pendiente quedó obsoleto");
        assertEqual(session.isAuthenticated(), false, "y NO resucita la sesión");
        assertEqual(store.raw(KEY), null, "ni reescribe el almacenamiento");
        assertEqual(clock.pending(), 0, "ni programa temporizadores");
    } finally { net.restore(); }
});

test("sesión 43: login pendiente + clear(): no resucita", async () => {
    fresh();
    const gateLogin = deferred();
    const net = installFetch(() => gateLogin.promise);
    try {
        const loginPendiente = session.login("ana", "claveDeAna123");
        session.clear();

        gateLogin.resolve(jsonResponse(200, pair({ username: "ana" })));
        const resultado = await loginPendiente;

        assertEqual(resultado.stale, true, "clear() invalidó el login pendiente");
        assertEqual(session.isAuthenticated(), false, "sin sesión");
        assertEqual(store.raw(KEY), null, "sin registro");
        assertEqual(clock.pending(), 0, "sin temporizadores");
    } finally { net.restore(); }
});

test("sesión 44: login pendiente + login nuevo: gana el nuevo aunque el viejo responda después", async () => {
    fresh();
    const gateViejo = deferred();
    const sesionNueva = pair({ username: "beto", refreshToken: "refresh-nuevo" });
    let call = 0;
    const net = installFetch(() => (call++ === 0 ? gateViejo.promise : jsonResponse(200, sesionNueva)));
    try {
        const loginViejo = session.login("ana", "claveDeAna123");
        const resultadoNuevo = await session.login("beto", "claveDeBeto123");
        assertEqual(resultadoNuevo.username, "beto", "el nuevo se estableció");

        gateViejo.resolve(jsonResponse(200, pair({ username: "ana", refreshToken: "refresh-viejo" })));
        const resultadoViejo = await loginViejo;

        assertEqual(resultadoViejo.stale, true, "el viejo se descarta");
        assertEqual(session.getUsername(), "beto", "gana el nuevo");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-nuevo", "también en el almacenamiento");
    } finally { net.restore(); }
});

/* ================= Validación estructural de TokenResponse =============== */

test("sesión 45: un 200 con TokenResponse inválido no establece sesión", async () => {
    const base = () => ({
        accessToken: fakeJwt({ sub: "1", role: "USER" }),
        refreshToken: "refresh-1",
        username: "maria123",
        accessTokenExpiresAt: new Date(clock.now() + 15 * MINUTE).toISOString(),
        refreshTokenExpiresAt: new Date(clock.now() + 7 * 24 * 60 * MINUTE).toISOString()
    });

    const casos = [
        ["sin access token", (b) => { delete b.accessToken; }],
        ["sin refresh token", (b) => { delete b.refreshToken; }],
        ["sin username", (b) => { delete b.username; }],
        ["username vacío", (b) => { b.username = "   "; }],
        ["sin accessTokenExpiresAt", (b) => { delete b.accessTokenExpiresAt; }],
        ["fecha de access inválida", (b) => { b.accessTokenExpiresAt = "no-es-una-fecha"; }],
        ["access ya vencido", (b) => { b.accessTokenExpiresAt = new Date(clock.now() - 1000).toISOString(); }],
        ["fecha de refresh inválida", (b) => { b.refreshTokenExpiresAt = "tampoco"; }],
        ["refresh ya vencido", (b) => { b.refreshTokenExpiresAt = new Date(clock.now() - 1000).toISOString(); }]
    ];

    for (const [caso, romper] of casos) {
        fresh();
        const cuerpo = base();
        romper(cuerpo);
        const net = installFetch(() => jsonResponse(200, cuerpo));
        try {
            const fallo = await assertRejects(session.login("maria123", "unaClaveSegura1"),
                caso + ": debe rechazar");
            assert(fallo instanceof HttpError, caso + ": es HttpError");
            assertEqual(fallo.error.category, CATEGORY.CLIENT, caso + ": categoría client");
            assertEqual(fallo.error.retryable, false, caso + ": no reintentable");
            assertEqual(fallo.error.httpStatus, "000", caso + ": no hubo respuesta HTTP fallida");
            assertEqual(session.isAuthenticated(), false, caso + ": no autentica");
            assertEqual(store.counts.setItem, 0, caso + ": NO guarda una sesión parcial");
            assertEqual(clock.pending(), 0, caso + ": no programa temporizador");
            assertEqual(metrics.getSamples().length, 1, caso + ": una sola muestra, la del 200 real");
            assert(fallo.error.detail.indexOf(cuerpo.accessToken || "x") === -1,
                caso + ": el detalle no filtra tokens");
        } finally { net.restore(); }
    }
});

test("sesión 46: un refresh con cuerpo inválido conserva el par anterior completo", async () => {
    fresh();
    const inicial = pair({ refreshToken: "refresh-1", role: "ADMIN" });
    let call = 0;
    const net = installFetch(() => (call++ === 0
        ? jsonResponse(200, inicial)
        // 200, pero sin refreshToken: aparentaría éxito y dejaría el registro roto.
        : jsonResponse(200, { accessToken: fakeJwt({ sub: "1", role: "USER" }), username: "maria123",
                              accessTokenExpiresAt: new Date(clock.now() + 15 * MINUTE).toISOString(),
                              refreshTokenExpiresAt: new Date(clock.now() + MINUTE).toISOString() })));
    try {
        await loginOk();
        const escriturasTrasLogin = store.counts.setItem;
        const bus = events();

        const fallo = await assertRejects(session.refresh(), "el refresh debe rechazar");
        assertEqual(fallo.error.category, CATEGORY.CLIENT, "fallo local, no de red ni del backend");
        assertEqual(fallo.error.retryable, false, "no reintentable");

        assertEqual(session.getToken(), inicial.accessToken, "conserva el access token anterior");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-1", "y el refresh token anterior");
        assertEqual(session.role(), "ADMIN", "y el rol anterior");
        assertEqual(store.counts.setItem, escriturasTrasLogin, "sin escrituras parciales");
        assertEqual(bus.types().length, 0, "no es una expiración ni una degradación");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 47: un refresh inválido no hace que http.js reintente sin token nuevo", async () => {
    fresh();
    let productCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) return jsonResponse(200, pair());
        if (url.includes("/api/auth/refresh")) return jsonResponse(200, { accessToken: "solo-esto" });
        productCalls++;
        return errorResponse(401, { code: "invalid_session" });
    });
    try {
        await loginOk();
        const fallo = await assertRejects(get("/api/products"), "propaga el fallo de la renovación");
        assertEqual(fallo.error.category, CATEGORY.CLIENT, "el error real es el del cuerpo inválido");
        assertEqual(productCalls, 1, "la petición original NO se reintentó sin token nuevo");
    } finally { net.restore(); }
});

/* ============ Validación del registro persistido (esquema 1) ============= */

test("sesión 48: un registro persistido incompleto se elimina de forma segura", async () => {
    const completo = () => ({
        version: 1,
        accessToken: fakeJwt({ sub: "1", role: "USER" }),
        refreshToken: "refresh-guardado",
        username: "maria123",
        accessTokenExpiresAt: new Date(clock.now() + 15 * MINUTE).toISOString(),
        refreshTokenExpiresAt: new Date(clock.now() + 7 * 24 * 60 * MINUTE).toISOString()
    });

    const casos = [
        ["sin username", (r) => { delete r.username; }],
        ["username vacío", (r) => { r.username = ""; }],
        ["sin refreshTokenExpiresAt", (r) => { delete r.refreshTokenExpiresAt; }],
        ["refreshTokenExpiresAt inválido", (r) => { r.refreshTokenExpiresAt = "no-es-fecha"; }],
        ["sin accessToken", (r) => { delete r.accessToken; }]
    ];

    for (const [caso, romper] of casos) {
        fresh();
        const registro = completo();
        romper(registro);
        store.data.set(KEY, JSON.stringify(registro));
        const net = installFetch(() => jsonResponse(200, {}));
        try {
            const resultado = await session.restore();
            assertEqual(resultado.authenticated, false, caso + ": no restaura");
            assertEqual(net.calls.length, 0, caso + ": sin peticiones");
            assertEqual(store.raw(KEY), null, caso + ": elimina el registro incompleto");
            assertEqual(clock.pending(), 0, caso + ": sin temporizadores");
        } finally { net.restore(); }
    }
});

/* ============ Refresh de la sesión anterior iniciado DURANTE un login ===== */
/*
 * La carrera más sutil de todas: mientras un login viaja, el estado sigue siendo
 * el de la sesión anterior y su renovación puede arrancar —por temporizador o
 * por un 401—. Ese refresh captura la generación que el login reclamó al
 * empezar; si el login confirmara con esa misma generación, el refresh viejo
 * tendría la MISMA identidad y, al responder después, devolvería la sesión
 * anterior encima de la nueva.
 *
 * Todas ocurren dentro de una misma instancia, sin fresh() entre los pasos.
 */

test("sesión 49: un refresh PROACTIVO iniciado durante el login no pisa la sesión nueva", async () => {
    fresh();
    const sesionA = pair({ username: "ana", refreshToken: "refresh-de-A", role: "USER" });
    const sesionB = pair({ username: "beto", refreshToken: "refresh-de-B", role: "ADMIN" });
    const gateLoginB = deferred();
    const gateRefreshA = deferred();
    let loginCalls = 0;
    const cuerposRefresh = [];

    const net = installFetch((url, init) => {
        if (url.includes("/api/auth/login")) {
            return loginCalls++ === 0 ? jsonResponse(200, sesionA) : gateLoginB.promise;
        }
        cuerposRefresh.push(JSON.parse(init.body));
        return gateRefreshA.promise;
    });
    try {
        // 1. Sesión A activa, con su temporizador programado.
        await session.login("ana", "claveDeAna123");
        assertEqual(clock.pending(), 1, "A dejó su temporizador");
        const bus = events();

        // 2. Empieza login B y queda pendiente.
        const loginB = session.login("beto", "claveDeBeto123");
        await tick(2);

        // 3. Vence el temporizador de A DESPUÉS de haber iniciado B.
        clock.advance(14 * MINUTE + 1000);
        await tick(3);
        assertEqual(cuerposRefresh.length, 1, "arrancó un refresh de la sesión A");
        assertEqual(cuerposRefresh[0].refreshToken, "refresh-de-A", "y usó el refresh token de A");

        // 4. Login B responde PRIMERO y se aplica.
        gateLoginB.resolve(jsonResponse(200, sesionB));
        const resultadoB = await loginB;
        assertEqual(resultadoB.username, "beto", "B quedó establecida");

        // 5. El refresh de A responde DESPUÉS, con un par válido de A.
        gateRefreshA.resolve(jsonResponse(200, pair({ username: "ana", refreshToken: "refresh-de-A-2" })));
        await tick(4);

        // 6. Todo debe seguir siendo de B.
        assertEqual(session.getToken(), sesionB.accessToken, "el access token es el de B");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-de-B", "el refresh token es el de B");
        assertEqual(session.getUsername(), "beto", "el username es el de B");
        assertEqual(session.role(), "ADMIN", "el rol es el de B");
        assertEqual(store.parsed(KEY).accessTokenExpiresAt, sesionB.accessTokenExpiresAt, "y la expiración");
        assertEqual(clock.pending(), 1, "un solo temporizador, el de B");
        assertEqual(bus.types().length, 0, "el refresh viejo no emitió eventos sobre B");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 50: el refresh viejo se descarta como obsoleto, no se aplica a medias", async () => {
    fresh();
    const sesionA = pair({ username: "ana", refreshToken: "refresh-de-A" });
    const sesionB = pair({ username: "beto", refreshToken: "refresh-de-B" });
    const gateLoginB = deferred();
    const gateRefreshA = deferred();
    let loginCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) {
            return loginCalls++ === 0 ? jsonResponse(200, sesionA) : gateLoginB.promise;
        }
        return gateRefreshA.promise;
    });
    try {
        await session.login("ana", "claveDeAna123");
        const loginB = session.login("beto", "claveDeBeto123");
        await tick(2);
        const refreshA = session.refresh();          // renovación explícita de A
        await tick(2);

        gateLoginB.resolve(jsonResponse(200, sesionB));
        await loginB;

        gateRefreshA.resolve(jsonResponse(200, pair({ username: "ana", refreshToken: "refresh-de-A-2" })));
        const resultado = await refreshA;

        assertEqual(resultado.stale, true, "el refresh de A se declara obsoleto");
        assertEqual(session.getToken(), sesionB.accessToken, "y no tocó la sesión de B");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-de-B", "ni su registro");
    } finally { net.restore(); }
});

test("sesión 51: un refresh REACTIVO (401) durante el login tampoco revierte a la sesión anterior", async () => {
    fresh();
    const sesionA = pair({ username: "ana", refreshToken: "refresh-de-A" });
    const sesionB = pair({ username: "beto", refreshToken: "refresh-de-B", role: "ADMIN" });
    const gateLoginB = deferred();
    const gateRefreshA = deferred();
    let loginCalls = 0;
    let productCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) {
            return loginCalls++ === 0 ? jsonResponse(200, sesionA) : gateLoginB.promise;
        }
        if (url.includes("/api/auth/refresh")) return gateRefreshA.promise;
        productCalls++;
        return productCalls === 1 ? errorResponse(401, { code: "invalid_session" }) : jsonResponse(200, { ok: true });
    });
    try {
        await session.login("ana", "claveDeAna123");
        const bus = events();

        // Login B pendiente...
        const loginB = session.login("beto", "claveDeBeto123");
        await tick(2);

        // ...y una petición protegida recibe 401: eso arranca el refresh de A.
        const peticion = get("/api/products");
        await tick(4);

        // Login B termina primero.
        gateLoginB.resolve(jsonResponse(200, sesionB));
        await loginB;
        assertEqual(session.getToken(), sesionB.accessToken, "B establecida");

        // El refresh de A termina después.
        gateRefreshA.resolve(jsonResponse(200, pair({ username: "ana", refreshToken: "refresh-de-A-2" })));
        const respuesta = await peticion;

        assertEqual(respuesta.status, 200, "la petición protegida se recuperó con el reintento");
        assertEqual(session.getToken(), sesionB.accessToken, "la sesión B permanece intacta");
        assertEqual(session.getUsername(), "beto", "sin volver a A");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-de-B", "ni en el almacenamiento");
        assertEqual(session.role(), "ADMIN", "el rol sigue siendo el de B");
        assertEqual(bus.types().length, 0, "sin eventos sobre B");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 52: refresh durante login + TokenResponse inválido: sobrevive la sesión anterior", async () => {
    fresh();
    const sesionA = pair({ username: "ana", refreshToken: "refresh-de-A", role: "USER" });
    const renovadoA = pair({ username: "ana", refreshToken: "refresh-de-A-2", role: "USER" });
    const gateLoginB = deferred();
    const gateRefreshA = deferred();
    let loginCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) {
            return loginCalls++ === 0 ? jsonResponse(200, sesionA) : gateLoginB.promise;
        }
        return gateRefreshA.promise;
    });
    try {
        await session.login("ana", "claveDeAna123");
        const bus = events();

        const loginB = session.login("beto", "claveDeBeto123");
        await tick(2);
        const refreshA = session.refresh();
        await tick(2);

        // B responde 200 pero con el cuerpo incompleto: no puede destruir a A.
        gateLoginB.resolve(jsonResponse(200, { accessToken: "solo-esto", username: "beto" }));
        const fallo = await assertRejects(loginB, "el login inválido rechaza");
        assertEqual(fallo.error.category, CATEGORY.CLIENT, "categoría client, no red ni backend");
        assertEqual(session.getUsername(), "ana", "LA SESIÓN QUE PERMANECE ES A");
        assertEqual(session.getToken(), sesionA.accessToken, "con su token intacto");

        // Y como el login nunca confirmó, el refresh de A sigue siendo válido.
        gateRefreshA.resolve(jsonResponse(200, renovadoA));
        const resultadoRefresh = await refreshA;
        assertEqual(resultadoRefresh.stale, false, "el refresh de A sí se aplica");
        assertEqual(session.getToken(), renovadoA.accessToken, "A queda renovada");
        assertEqual(session.getUsername(), "ana", "sin estado mezclado");
        assertEqual(store.parsed(KEY).refreshToken, "refresh-de-A-2", "registro coherente");
        assertEqual(clock.pending(), 1, "un solo temporizador, sin huérfanos");
        assertEqual(bus.types().length, 0, "sin eventos espurios");
        bus.off();
    } finally { net.restore(); }
});

test("sesión 53: login fallido mientras vence el temporizador anterior: A conserva su renovación", async () => {
    fresh();
    const sesionA = pair({ username: "ana", refreshToken: "refresh-de-A" });
    const renovadoA = pair({ username: "ana", refreshToken: "refresh-de-A-2" });
    const gateLoginB = deferred();
    const gateRefreshA = deferred();
    let loginCalls = 0;
    let refreshCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) {
            return loginCalls++ === 0 ? jsonResponse(200, sesionA) : gateLoginB.promise;
        }
        refreshCalls++;
        return gateRefreshA.promise;
    });
    try {
        await session.login("ana", "claveDeAna123");
        const loginB = session.login("beto", "claveIncorrecta1");
        await tick(2);

        // Vence el temporizador de A durante el login fallido.
        clock.advance(14 * MINUTE + 1000);
        await tick(3);
        assertEqual(refreshCalls, 1, "un solo canje del refresh token de A");

        gateLoginB.resolve(errorResponse(401, { code: "invalid_credentials" }));
        const fallo = await assertRejects(loginB, "el login falla");
        assertEqual(fallo.error.code, "invalid_credentials", "propaga el HttpError original");

        gateRefreshA.resolve(jsonResponse(200, renovadoA));
        await tick(4);

        assertEqual(session.getToken(), renovadoA.accessToken, "A se renovó pese al login fallido");
        assertEqual(session.isAuthenticated(), true, "y sigue autenticada");
        assertEqual(clock.pending(), 1, "con un temporizador nuevo: no queda sin renovación silenciosa");
        assertEqual(refreshCalls, 1, "y nunca hubo dos canjes simultáneos del mismo token");
    } finally { net.restore(); }
});

test("sesión 54: el finally del refresh viejo no borra la renovación de la sesión confirmada", async () => {
    fresh();
    const sesionA = pair({ username: "ana", refreshToken: "refresh-de-A" });
    const sesionB = pair({ username: "beto", refreshToken: "refresh-de-B" });
    const gateLoginB = deferred();
    const gateRefreshA = deferred();
    const gateRefreshB = deferred();
    let loginCalls = 0;
    let refreshCalls = 0;
    const net = installFetch((url) => {
        if (url.includes("/api/auth/login")) {
            return loginCalls++ === 0 ? jsonResponse(200, sesionA) : gateLoginB.promise;
        }
        return refreshCalls++ === 0 ? gateRefreshA.promise : gateRefreshB.promise;
    });
    try {
        await session.login("ana", "claveDeAna123");
        const loginB = session.login("beto", "claveDeBeto123");
        await tick(2);

        const refreshA = session.refresh();          // promesa de la sesión vieja
        await tick(2);

        gateLoginB.resolve(jsonResponse(200, sesionB));
        await loginB;

        const refreshB = session.refresh();          // promesa de la sesión confirmada
        assert(refreshB !== refreshA, "son promesas distintas");
        await tick(2);

        // Termina el VIEJO: su finally no debe tocar la referencia del nuevo.
        gateRefreshA.resolve(jsonResponse(200, pair({ username: "ana", refreshToken: "refresh-de-A-2" })));
        await refreshA;
        await tick(2);

        assert(session.refresh() === refreshB, "la promesa compartida de B sigue en pie");
        assertEqual(session.getToken(), sesionB.accessToken, "y la sesión de B intacta");

        gateRefreshB.resolve(jsonResponse(200, pair({ username: "beto", refreshToken: "refresh-de-B-2" })));
        await refreshB;
        assertEqual(store.parsed(KEY).refreshToken, "refresh-de-B-2", "B se renovó con su propio token");
    } finally { net.restore(); }
});
