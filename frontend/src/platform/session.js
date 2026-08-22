/**
 * frontend/src/platform/session.js — Sesión del tier de presentación.
 *
 * RESPONSABILIDAD
 * ---------------
 * Poseer el ciclo de vida de la sesión: login, renovación silenciosa, logout,
 * restauración desde almacenamiento y el rol para la presentación. Es el único
 * módulo que conoce los tokens.
 *
 * TÁCTICAS APLICADAS
 * ------------------
 * - "Encapsulate" (Cap. 7): quien consume la aplicación llama a login() y a
 *   isAuthenticated(); no toca tokens, ni localStorage, ni cabeceras. Si el
 *   contrato de autenticación cambia, cambia este archivo.
 * - "Defer Binding" (Cap. 8): el reloj, los temporizadores y el almacenamiento
 *   entran por configureSession(), así que el mismo módulo corre en el navegador
 *   y en el arnés de pruebas sin ramificar por entorno.
 * - "Maintain Redundancy / Active Redundancy" no aplica aquí, pero sí su primo
 *   pobre: la renovación proactiva mantiene la sesión viva ANTES de que el
 *   usuario tropiece con un 401.
 *
 * DIRECCIÓN DE DEPENDENCIAS (ADR-F01)
 * -----------------------------------
 * session.js -> http.js. NUNCA al revés. http.js no importa este módulo: recibe
 * las capacidades que necesita ({ getToken, refresh, notify }) por inyección, a
 * través de configureAuthProvider(). Ese es el corte que rompe el ciclo entre
 * "la sesión necesita hablar HTTP" y "el transporte necesita un token".
 *
 * QUÉ NO HACE ESTE COMMIT
 * -----------------------
 * No hay CRUD, ni caché, ni debounce, ni pantallas. Tampoco hay reintentos
 * manuales: la UI futura podrá ofrecer como máximo dos, y este módulo se limita
 * a no impedirlo (conserva lo necesario y no monta bucles automáticos).
 */

import { post, configureAuthProvider, HttpError } from "./http.js";
import { fromClientFailure } from "./errors.js";

/* ------------------------------------------------------------------ *
 * Constantes
 * ------------------------------------------------------------------ */

/** Clave propia del frontend. Un solo registro, nunca una clave por token. */
const STORAGE_KEY = "taller1.session";

/** Versión del registro persistido. Un valor distinto se descarta, no se migra. */
const SCHEMA_VERSION = 1;

/** Margen de la renovación proactiva: renovar 60 s antes de que expire. */
const PROACTIVE_MARGIN_MS = 60_000;

const ROLES = ["ADMIN", "USER"];

/* ------------------------------------------------------------------ *
 * Seam de entorno (reloj, temporizadores, almacenamiento)
 * ------------------------------------------------------------------ */

/**
 * Nada de esto se resuelve al importar: se resuelve al usarlo. Leer
 * globalThis.localStorage en tiempo de import sería un efecto secundario, y este
 * módulo promete no tener ninguno (ver restore()).
 */
const DEFAULT_ENV = Object.freeze({
    now: null,
    setTimeout: null,
    clearTimeout: null,
    storage: null
});

let env = { ...DEFAULT_ENV };

/**
 * Inyecta reloj, temporizadores y almacenamiento. Sin argumentos, cada uno cae
 * a su valor real (Date.now, globalThis.setTimeout, globalThis.clearTimeout,
 * globalThis.localStorage). Las pruebas lo usan para no esperar tiempo real ni
 * tocar el almacenamiento del navegador de quien las ejecuta.
 */
export function configureSession({ now, setTimeout, clearTimeout, storage } = {}) {
    ensureAuthProviderInstalled();
    if (typeof now === "function") env.now = now;
    if (typeof setTimeout === "function") env.setTimeout = setTimeout;
    if (typeof clearTimeout === "function") env.clearTimeout = clearTimeout;
    if (storage) env.storage = storage;
}

/**
 * Devuelve el módulo a su estado de arranque: entorno real, sin listeners y con
 * el proveedor pendiente de reinstalar.
 *
 * Reiniciar el proveedor es imprescindible y no es un detalle de pruebas: si el
 * indicador de "ya instalado" sobreviviera a un configureAuthProvider(null),
 * http.js se quedaría SIN proveedor de forma permanente —sin token, sin
 * renovación tras un 401 y sin notificación del 403— y ninguna llamada posterior
 * volvería a registrarlo. La instalación es idempotente, así que reinstalar es
 * barato y siempre correcto.
 */
export function resetSessionConfig() {
    // El temporizador se cancela ANTES de soltar el entorno: cancelarlo después
    // usaría el clearTimeout nuevo sobre un id creado por el anterior, y el
    // temporizador viejo quedaría vivo apuntando a un módulo ya reconfigurado.
    cancelTimer();

    // Invalida cualquier operación asíncrona anterior. Sin esto, una respuesta en
    // vuelo podría escribir sobre el estado ya reconfigurado.
    claimGeneration();
    refreshPromise = null;
    restorePromise = null;
    state = emptyState();
    listeners = [];

    // NO se toca el almacenamiento: reiniciar la configuración no es borrar la
    // sesión persistida, y leer o escribir aquí sería justo el efecto que
    // restore() existe para evitar.
    env = { ...DEFAULT_ENV };

    // El proveedor queda pendiente de reinstalar: la próxima operación real lo
    // registra de nuevo. Si el indicador sobreviviera a un
    // configureAuthProvider(null), http.js se quedaría permanentemente sin token,
    // sin renovación tras un 401 y sin notificación del 403.
    authProviderInstalled = false;
}

const now = () => (env.now ? env.now() : Date.now());
const schedule = (fn, ms) => (env.setTimeout ? env.setTimeout(fn, ms) : globalThis.setTimeout(fn, ms));
const unschedule = (id) => (env.clearTimeout ? env.clearTimeout(id) : globalThis.clearTimeout(id));
const storage = () => env.storage || globalThis.localStorage || null;

/* ------------------------------------------------------------------ *
 * Estado
 * ------------------------------------------------------------------ */

function emptyState() {
    return {
        accessToken: null,
        refreshToken: null,
        username: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        accessTokenExpiresAtMs: NaN,
        refreshTokenExpiresAtMs: NaN
    };
}

let state = emptyState();

/**
 * Generación de sesión: identidad de "quién manda ahora".
 *
 * Toda operación que ESTABLECE o DESTRUYE una sesión —login(), logout(),
 * restore(), clear()— reclama una generación nueva AL EMPEZAR, antes de enviar
 * ninguna petición. Toda operación asíncrona guarda la suya y, al terminar,
 * comprueba si sigue siendo la vigente: si no lo es, se descarta SIN escribir
 * memoria, SIN escribir almacenamiento, SIN programar temporizadores y SIN
 * emitir eventos.
 *
 * Reclamar ANTES de la petición y no después es lo que ordena dos login
 * concurrentes. Si la generación se reclamara al recibir la respuesta, este
 * intercalado corrompería la sesión: A arranca, B arranca, B responde y guarda
 * su par, A responde después y —al reclamar en ese momento— se declararía el
 * más nuevo y pisaría a B. Con la identidad tomada al empezar, A ya nació más
 * viejo que B y su respuesta tardía no puede aplicarse.
 *
 * refresh() NO reclama: renueva la sesión vigente, no establece otra. Solo
 * captura la generación actual para poder descartarse si mientras tanto llega un
 * login, un logout o un clear.
 */
let generation = 0;

/** Reclama la siguiente generación e invalida todo lo anterior en vuelo. */
function claimGeneration() {
    generation += 1;
    return generation;
}

let refreshPromise = null;
let restorePromise = null;
let timerId = null;
let listeners = [];
let authProviderInstalled = false;

/* ------------------------------------------------------------------ *
 * Eventos
 * ------------------------------------------------------------------ */

/**
 * Suscribe un listener y devuelve su función de baja.
 *
 * Deliberadamente independiente del DOM: sin window, sin document y sin
 * CustomEvent, para que el mismo módulo funcione en el arnés de pruebas.
 */
export function subscribe(listener) {
    ensureAuthProviderInstalled();
    if (typeof listener !== "function") {
        return () => {};
    }
    listeners.push(listener);
    return function unsubscribe() {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
    };
}

/**
 * Entrega el evento a todos los listeners.
 *
 * Cada invocación va aislada: un listener que lance no impide que los demás
 * reciban el evento, y su excepción NO cambia el resultado de la operación HTTP
 * en curso. Un error al pintar un aviso no puede convertirse en un fallo de red.
 */
function emit(event) {
    const payload = {
        type: event.type,
        requestId: event.requestId ?? null,
        error: event.error ?? null
    };
    for (const listener of listeners.slice()) {
        try {
            listener(payload);
        } catch (_ignored) {
            // Aislado a propósito.
        }
    }
}

/* ------------------------------------------------------------------ *
 * Proveedor inyectado en http.js
 * ------------------------------------------------------------------ */

/**
 * Registra las capacidades en http.js. NO se hace al importar —eso sería un
 * efecto secundario de import— sino en la primera operación real de sesión.
 * Es idempotente.
 */
function ensureAuthProviderInstalled() {
    if (authProviderInstalled) return;
    authProviderInstalled = true;
    configureAuthProvider({
        getToken: () => getToken(),
        refresh: () => refresh(),
        notify: (event) => emit(event)
    });
}

/* ------------------------------------------------------------------ *
 * Persistencia
 * ------------------------------------------------------------------ */

function readRecord() {
    const store = storage();
    if (!store) return null;
    try {
        const raw = store.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_ignored) {
        // JSON corrupto o almacenamiento inaccesible: se trata como "sin
        // registro". Un registro roto no puede impedir que la aplicación cargue.
        return null;
    }
}

/**
 * Escribe el registro COMPLETO con un único setItem.
 *
 * Es la propiedad que hace atómica la sustitución del par: si el access token y
 * el refresh token se guardaran en claves distintas, una interrupción entre las
 * dos escrituras dejaría un access token nuevo junto a un refresh token viejo, y
 * la siguiente renovación fallaría con 401 sobre una sesión que era válida.
 */
function writeRecord(record) {
    const store = storage();
    if (!store) return;
    try {
        store.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch (_ignored) {
        // Cuota llena o modo privado: la sesión sigue viva en memoria. Se tolera
        // en vez de romper el arranque.
    }
}

function removeRecord() {
    const store = storage();
    if (!store) return;
    try {
        store.removeItem(STORAGE_KEY);
    } catch (_ignored) {
        // Igual que arriba: no se puede hacer nada mejor que continuar.
    }
}

/** Valida la forma del registro. Cualquier defecto lo descarta entero. */
function validateRecord(record) {
    if (!record || record.version !== SCHEMA_VERSION) return null;
    if (!nonEmptyString(record.accessToken)) return null;
    if (!nonEmptyString(record.refreshToken)) return null;
    // username es obligatorio en el esquema 1: sin él la UI no puede saludar a
    // nadie y el registro estaría a medias.
    if (!nonEmptyString(record.username)) return null;
    const accessMs = Date.parse(record.accessTokenExpiresAt);
    if (!Number.isFinite(accessMs)) return null;
    // refreshTokenExpiresAt también es obligatorio: el contrato lo entrega
    // siempre (CONTRATO §3.2) y sin él no se puede decidir si vale la pena
    // intentar una renovación o hay que limpiar sin gastar una petición.
    const refreshMs = Date.parse(record.refreshTokenExpiresAt);
    if (!Number.isFinite(refreshMs)) return null;
    return { record, accessMs, refreshMs };
}

/* ------------------------------------------------------------------ *
 * Validación de TokenResponse
 * ------------------------------------------------------------------ */

function nonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}

/**
 * Valida el cuerpo de /login y /refresh ANTES de tocar nada.
 *
 * Un 200 con el cuerpo incompleto no es un éxito: persistir un registro a medias
 * haría que un refresh "correcto" dejara getToken() devolviendo null, y el
 * defecto aparecería mucho después y muy lejos de su causa. Por eso se valida
 * entero primero y solo entonces se escribe.
 *
 * El fallo es LOCAL del cliente, no de la red ni una indisponibilidad del
 * backend: se lanza como HttpError de categoría `client` y retryable:false
 * —reintentar daría exactamente el mismo cuerpo—. Y NO genera una muestra
 * adicional en metrics.js: la respuesta HTTP ya fue medida por http.js, y este
 * defecto se detecta después de recibirla; contarla dos veces falsearía la
 * disponibilidad.
 *
 * `detail` enumera NOMBRES de campo, nunca sus valores: un mensaje de
 * diagnóstico no puede filtrar tokens.
 */
function validateTokenResponse(data) {
    const missing = [];

    if (!data || typeof data !== "object") {
        missing.push("cuerpo");
    } else {
        if (!nonEmptyString(data.accessToken)) missing.push("accessToken");
        if (!nonEmptyString(data.refreshToken)) missing.push("refreshToken");
        if (!nonEmptyString(data.username)) missing.push("username");
    }

    const accessMs = data ? Date.parse(data.accessTokenExpiresAt) : NaN;
    const refreshMs = data ? Date.parse(data.refreshTokenExpiresAt) : NaN;
    const currentMs = now();

    if (!Number.isFinite(accessMs)) missing.push("accessTokenExpiresAt");
    else if (accessMs <= currentMs) missing.push("accessTokenExpiresAt ya vencido");

    if (!Number.isFinite(refreshMs)) missing.push("refreshTokenExpiresAt");
    else if (refreshMs <= currentMs) missing.push("refreshTokenExpiresAt ya vencido");

    if (missing.length > 0) {
        throw new HttpError(fromClientFailure({
            detail: "TokenResponse invalido: " + missing.join(", ")
        }));
    }

    return {
        record: {
            version: SCHEMA_VERSION,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            username: data.username,
            accessTokenExpiresAt: data.accessTokenExpiresAt,
            refreshTokenExpiresAt: data.refreshTokenExpiresAt
        },
        accessMs,
        refreshMs
    };
}

/* ------------------------------------------------------------------ *
 * Temporizador de renovación proactiva
 * ------------------------------------------------------------------ */

function cancelTimer() {
    if (timerId !== null) {
        unschedule(timerId);
        timerId = null;
    }
}

/**
 * Programa la renovación 60 s antes de accessTokenExpiresAt.
 *
 * Usa EXCLUSIVAMENTE el accessTokenExpiresAt de /login o /refresh, nunca el
 * expiresAt de /validate: aquel conserva la precisión del reloj del servidor y
 * este viene del claim exp del JWT, que es NumericDate en segundos enteros
 * (CONTRATO §3.3). Mezclar las dos fuentes compararía valores que no son
 * idénticos para el mismo token.
 *
 * Como máximo un temporizador vivo. Un access token YA VENCIDO no se programa
 * aquí: ese caso lo resuelve restore().
 */
function scheduleProactiveRefresh() {
    cancelTimer();
    const expiresAtMs = state.accessTokenExpiresAtMs;
    if (!Number.isFinite(expiresAtMs)) return;

    const remaining = expiresAtMs - now();
    if (remaining <= 0) return;

    // Si quedan menos de 60 s el retardo sale negativo: se renueva de inmediato
    // (en el siguiente turno del bucle de eventos), no con un retardo negativo.
    const delay = Math.max(remaining - PROACTIVE_MARGIN_MS, 0);
    // La guardia es el TOKEN para el que se programó, no la generación. Un login
    // que arranca reclama generación aunque todavía no haya respondido; si la
    // guardia mirara la generación, un login en curso —o fallido— dejaría a la
    // sesión vigente sin renovación silenciosa. El token, en cambio, identifica
    // exactamente el par que este temporizador debe renovar.
    const scheduledFor = state.accessToken;

    timerId = schedule(() => {
        timerId = null;
        if (state.accessToken !== scheduledFor) return;
        // El fallo ya se trata dentro de refresh(); aquí solo se evita una
        // promesa rechazada sin manejar. NO se reprograma nada: un backend caído
        // no debe recibir un bucle de reintentos desde cada cliente.
        refresh().catch(() => {});
    }, delay);
}

/* ------------------------------------------------------------------ *
 * Aplicación de un par de tokens
 * ------------------------------------------------------------------ */

/**
 * Guarda el par recibido de /login o /refresh y reprograma la renovación.
 * Devuelve false si la generación capturada ya no es la vigente: en ese caso no
 * escribe absolutamente nada.
 */
function applyTokenResponse(data, capturedGeneration) {
    // Obsoleta: se descarta en silencio, SIN validar y sin lanzar. Una respuesta
    // que ya no representa a nadie no debe producir un error visible.
    if (capturedGeneration !== generation) return false;

    // Validación COMPLETA antes de escribir un solo campo. Si algo falla, lanza
    // y el estado anterior queda intacto: ni memoria a medias, ni registro
    // parcial, ni temporizador basado en una fecha inválida.
    return applyValidatedTokens(validateTokenResponse(data), capturedGeneration);
}

/**
 * Sustitución atómica del estado a partir de un cuerpo YA validado.
 *
 * Existe separada de applyTokenResponse() porque login() necesita validar y
 * aplicar en dos momentos distintos, con una reclamación de generación entre
 * medias (ver login()). Una sola escritura de registro y un solo temporizador.
 */
function applyValidatedTokens({ record, accessMs, refreshMs }, capturedGeneration) {
    if (capturedGeneration !== generation) return false;

    cancelTimer();
    state = {
        ...record,
        accessTokenExpiresAtMs: accessMs,
        refreshTokenExpiresAtMs: refreshMs
    };
    writeRecord(record);
    scheduleProactiveRefresh();
    return true;
}

/* ------------------------------------------------------------------ *
 * Token, autenticación y rol
 * ------------------------------------------------------------------ */

/** El access token solo si SIGUE VIGENTE. Vencido devuelve null: no se envía. */
export function getToken() {
    if (!state.accessToken || !Number.isFinite(state.accessTokenExpiresAtMs)) {
        return null;
    }
    return now() < state.accessTokenExpiresAtMs ? state.accessToken : null;
}

export function isAuthenticated() {
    return getToken() !== null;
}

export function getUsername() {
    return state.username;
}

/** Decodificador base64 propio: no depende de atob, que no existe en todos los motores. */
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(input) {
    const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
    const bytes = [];
    for (let i = 0; i < clean.length; i += 4) {
        const chunk = [0, 1, 2, 3].map((offset) => B64_ALPHABET.indexOf(clean[i + offset] ?? "A"));
        if (chunk[0] < 0 || chunk[1] < 0) return null;
        bytes.push((chunk[0] << 2) | (chunk[1] >> 4));
        if (chunk[2] >= 0 && i + 2 < clean.length) bytes.push(((chunk[1] & 15) << 4) | (chunk[2] >> 2));
        if (chunk[3] >= 0 && i + 3 < clean.length) bytes.push(((chunk[2] & 3) << 6) | chunk[3]);
    }
    return bytes;
}

function base64UrlToString(segment) {
    const bytes = base64ToBytes(segment.replace(/-/g, "+").replace(/_/g, "/"));
    if (bytes === null) return null;
    if (typeof TextDecoder === "function") {
        return new TextDecoder().decode(Uint8Array.from(bytes));
    }
    return bytes.map((byte) => String.fromCharCode(byte)).join("");
}

/**
 * Rol del usuario, PARA LA PRESENTACIÓN.
 *
 * Decodifica el payload base64url del MISMO token que devolvería getToken(): si
 * no hay token vigente —porque no hay sesión, porque venció, o porque restore()
 * está renovando uno vencido— devuelve null, igual que isAuthenticated()
 * devuelve false. Un token muerto no puede pintar controles de administrador.
 *
 * DECODIFICAR NO ES VALIDAR. No se comprueba la firma y esto no concede ningún
 * permiso: cualquiera puede fabricar un JSON con "role":"ADMIN" y el backend lo
 * rechazaría igual. La autorización real es exclusiva del backend (ADR-011);
 * esto solo decide qué se muestra. El claim existe y va firmado (CONTRATO §3.2),
 * pero quien lo verifica es el servidor.
 *
 * Solo se aceptan los valores exactos ADMIN y USER. Token mal formado, claim
 * ausente o cualquier otro valor: null, y la UI elige lo más restrictivo.
 */
export function role() {
    const token = getToken();
    if (typeof token !== "string") return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    try {
        const json = base64UrlToString(parts[1]);
        if (json === null) return null;
        const payload = JSON.parse(json);
        const claimed = payload && payload.role;
        return ROLES.includes(claimed) ? claimed : null;
    } catch (_ignored) {
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * clear()
 * ------------------------------------------------------------------ */

/**
 * Borra memoria, almacenamiento, temporizador y promesa en vuelo, e invalida la
 * generación.
 *
 * Lo que NO puede hacer es cancelar una petición que ya viaja por la red: este
 * módulo no le pasa un AbortController a http.js. Lo honesto es descartar su
 * resultado —de eso se encarga la generación— y no fingir que no ocurrió.
 */
export function clear() {
    claimGeneration();
    resetLocalState();
    removeRecord();
}

/**
 * Limpieza local sin reclamar generación. La usan clear() y logout(), que ya
 * reclamaron la suya, para no incrementar el contador dos veces por operación.
 */
function resetLocalState() {
    cancelTimer();
    refreshPromise = null;
    state = emptyState();
}

/* ------------------------------------------------------------------ *
 * login()
 * ------------------------------------------------------------------ */

/**
 * POST /api/auth/login con { auth:false, retryAuth:false }.
 *
 * auth:false porque el login no lleva Authorization —el backend recibe las
 * credenciales en el cuerpo—, y retryAuth:false porque un 401 aquí significa
 * "credenciales inválidas", no "sesión vencida": refrescar sería absurdo.
 *
 * La promesa resuelve SOLO después de haber guardado el par completo, así que
 * quien la espera ya puede leer getToken(), role() e isAuthenticated().
 *
 * DOS GENERACIONES, NO UNA
 * ------------------------
 * login() reclama una generación al EMPEZAR (myGeneration) y otra al CONFIRMAR.
 * No es redundancia: cada una resuelve una carrera distinta.
 *
 *   - La de inicio ordena dos login concurrentes. Sin ella, el login que arranca
 *     primero pero responde último se declararía el más nuevo y pisaría al otro.
 *
 *   - La de confirmación expulsa a los refresh de la sesión ANTERIOR que
 *     empezaron mientras este login esperaba. Mientras el login viaja, el estado
 *     sigue siendo el de la sesión vieja y su temporizador puede dispararse —o
 *     un 401 puede provocar una renovación reactiva—. Ese refresh captura la
 *     generación vigente, que es justamente myGeneration. Si el login aplicara
 *     con myGeneration, los dos tendrían la MISMA identidad y el refresh viejo,
 *     al responder después, sobrescribiría la sesión recién establecida con el
 *     par de la anterior. Reclamar una generación nueva justo antes de aplicar
 *     deja a ese refresh con una identidad ya caducada.
 *
 * POLÍTICA ANTE UN LOGIN FALLIDO
 * ------------------------------
 * Si el backend rechaza el login se propaga su HttpError y NO se toca la sesión
 * anterior: sigue vigente, con sus tokens y su registro. Y sigue siendo
 * renovable, que es la parte fácil de romper: el temporizador proactivo está
 * protegido por la IDENTIDAD DEL ACCESS TOKEN, no por la generación, así que la
 * generación que este login reclamó y luego abandonó no lo deja huérfano. Si el
 * temporizador llegó a dispararse durante el login, su renovación se aplica con
 * normalidad —la generación no cambió, porque el login nunca confirmó— y
 * reprograma el siguiente. No queda una sesión vigente sin refresh silencioso ni
 * un temporizador apuntando a un par que ya nadie usa.
 */
export async function login(username, password) {
    ensureAuthProviderInstalled();

    // IDENTIDAD ANTES DE LA PETICIÓN. Este login queda marcado como el vigente
    // desde ya, así que cualquier login, logout, clear o restore posterior lo
    // invalida aunque su respuesta llegue después.
    const myGeneration = claimGeneration();

    const response = await post("/api/auth/login", {
        body: { username, password },
        auth: false,
        retryAuth: false
    });

    if (myGeneration !== generation) {
        // Otro login (o un logout, o un clear) ganó mientras esta respuesta
        // viajaba. No se escribe memoria, ni almacenamiento, ni username, ni rol,
        // ni se programa temporizador, y NO se invalida la sesión más nueva.
        //
        // Qué devuelve: un resultado explícitamente obsoleto. No finge haber
        // autenticado —los campos describen ESTA operación, no el módulo, que
        // puede estar perfectamente autenticado con la sesión ganadora— y
        // tampoco inventa un error del backend, porque el backend no falló.
        return { stale: true, applied: false, authenticated: false, username: null, role: null };
    }

    // Se valida ANTES de reclamar la generación de confirmación y antes de tocar
    // nada. Si el cuerpo es inválido, esto lanza y la sesión anterior sobrevive
    // intacta: un 200 con el cuerpo incompleto no puede destruir una sesión que
    // funcionaba solo por haber llegado con ese código.
    const validated = validateTokenResponse(response.data);

    // GENERACIÓN DE CONFIRMACIÓN. A partir de aquí, cualquier refresh que
    // arrancara durante la espera —y que capturó myGeneration— queda caducado y
    // no podrá escribir sobre esta sesión.
    const confirmGeneration = claimGeneration();

    // Se suelta la referencia a la promesa compartida de la sesión anterior. NO
    // se finge que se canceló: esa petición sigue viajando por la red y
    // terminará; simplemente deja de ofrecerse a quien pida refresh(), porque
    // canjea un refresh token que ya no pertenece a esta sesión. Su propio
    // finally comprueba identidad, así que tampoco borrará una promesa nueva.
    refreshPromise = null;
    applyValidatedTokens(validated, confirmGeneration);

    return {
        stale: false,
        applied: true,
        username: state.username,
        role: role(),
        authenticated: isAuthenticated()
    };
}

/* ------------------------------------------------------------------ *
 * refresh(): la ÚNICA promesa en vuelo
 * ------------------------------------------------------------------ */

/**
 * Renovación silenciosa. Devuelve SIEMPRE la misma promesa mientras hay una
 * renovación en curso:
 *
 *     session.refresh() === session.refresh()   // true
 *
 * No es una función async a propósito: una función async envuelve su resultado
 * en una promesa NUEVA en cada invocación, así que la identidad se rompería
 * aunque el POST siguiera siendo uno solo. El trabajo async vive en runRefresh()
 * y este envoltorio se limita a devolver la referencia guardada.
 *
 * Esa promesa única coordina las cuatro fuentes de renovación: el temporizador
 * proactivo, la que pide http.js tras un 401, restore() y cualquier renovación
 * manual futura. El motivo es concreto: el refresh token es de UN SOLO USO y
 * rota al canjearse (CONTRATO §3.4). Dos canjes simultáneos del mismo token
 * harían que el segundo recibiera 401 y cerrara una sesión válida.
 */
export function refresh() {
    ensureAuthProviderInstalled();
    if (refreshPromise) {
        return refreshPromise;
    }

    const capturedGeneration = generation;
    let promise;

    // Solo limpia la referencia si SIGUE SIENDO la suya. Un finally tardío no
    // puede borrar la promesa de una renovación más nueva: si lo hiciera, esa
    // renovación dejaría de ser compartida y aparecería un segundo canje.
    const settle = () => {
        if (refreshPromise === promise) {
            refreshPromise = null;
        }
    };

    promise = runRefresh(capturedGeneration).then(
        (value) => { settle(); return value; },
        (error) => { settle(); throw error; }
    );

    refreshPromise = promise;
    return promise;
}

async function runRefresh(capturedGeneration) {
    const refreshToken = state.refreshToken;
    if (!refreshToken) {
        throw new HttpError(fromClientFailure({
            detail: "no hay refresh token en la sesion"
        }));
    }

    let response;
    try {
        response = await post("/api/auth/refresh", {
            body: { refreshToken },
            auth: false,
            retryAuth: false
        });
    } catch (error) {
        handleRefreshFailure(error, capturedGeneration);
        // Se relanza EXACTAMENTE el mismo objeto: ni envuelto, ni sustituido, ni
        // duplicado. Quien depure el incidente necesita su requestId real.
        throw error;
    }

    if (capturedGeneration !== generation) {
        // La sesión fue reemplazada mientras la respuesta viajaba: no se escribe
        // nada, no se programa nada, no se emite nada.
        return { authenticated: isAuthenticated(), stale: true };
    }

    applyTokenResponse(response.data, capturedGeneration);
    return { authenticated: isAuthenticated(), stale: false };
}

/**
 * Reacción a un refresh fallido. Distingue tres situaciones que exigen respuestas
 * distintas; tratarlas igual sería el defecto clásico del frontend.
 */
function handleRefreshFailure(error, capturedGeneration) {
    if (capturedGeneration !== generation) {
        // Fallo de una generación anterior: no toca la sesión nueva y NO emite
        // eventos sobre ella.
        return;
    }

    const model = error && error.error ? error.error : null;
    const requestId = model ? model.requestId : null;

    if (model && model.httpStatus === 401 && model.code === "invalid_session") {
        // Refresh token inexistente, expirado, ya usado, o usuario desactivado
        // (CONTRATO §3.4): el backend responde lo mismo en todos los casos y el
        // frontend NO inventa un código propio como user_inactive.
        clear();
        emit({ type: "session:expired", requestId, error: model });
        return;
    }

    if (model && model.code === "data_unavailable") {
        // El tier de datos está caído. NO es una sesión expirada: convertirlo en
        // un cierre de sesión sería un fallo del frontend, no del backend. Se
        // conserva el registro para un reintento posterior manual, y NO se
        // programa otro refresh: nada de bucles contra un backend caído.
        cancelTimer();
        emit({ type: "system:degraded", requestId, error: model });
        return;
    }

    // Timeout, red u otro fallo: se conserva el estado y no se presenta como
    // sesión expirada. Tampoco se reprograma nada.
    cancelTimer();
}

/* ------------------------------------------------------------------ *
 * restore()
 * ------------------------------------------------------------------ */

/**
 * Restauración EXPLÍCITA desde el almacenamiento.
 *
 * Importar este módulo no lee el almacenamiento, no crea temporizadores, no hace
 * peticiones y no registra nada en http.js. Todo empieza aquí. Esto no es
 * pulcritud: permite inyectar almacenamiento, reloj y temporizadores con
 * configureSession() ANTES de restaurar, que es justo lo que las pruebas
 * necesitan y lo que un import con efectos impediría.
 *
 * Comparte una única promesa mientras la restauración está en curso.
 *
 * RESUELVE o RECHAZA, nunca las dos cosas:
 *   - resuelve, indicando el estado resultante, cuando no hubo error HTTP;
 *   - rechaza con EXACTAMENTE el HttpError cuando falló el refresh que ella
 *     misma inició. "Permanece sin autenticar" describe el estado interno tras
 *     el fallo, no el resultado de la promesa.
 */
export function restore() {
    ensureAuthProviderInstalled();
    if (restorePromise) {
        return restorePromise;
    }

    let promise;
    const settle = () => {
        if (restorePromise === promise) {
            restorePromise = null;
        }
    };

    promise = runRestore().then(
        (value) => { settle(); return value; },
        (error) => { settle(); throw error; }
    );

    restorePromise = promise;
    return promise;
}

async function runRestore() {
    // Restaurar establece una sesión: reclama generación e invalida cualquier
    // login, refresh o restore anterior que siguiera en vuelo.
    claimGeneration();
    // La promesa de una renovación anterior ya no representa a esta sesión.
    refreshPromise = null;
    cancelTimer();

    const validated = validateRecord(readRecord());
    if (!validated) {
        // Ausente, corrupto, versión desconocida, campos ausentes o fechas
        // inválidas: se limpia el residuo y se resuelve sin sesión. Nunca lanza.
        state = emptyState();
        removeRecord();
        return { authenticated: false, restored: false };
    }

    const { record, accessMs, refreshMs } = validated;
    const currentMs = now();

    if (accessMs > currentMs) {
        // Access token vigente: se restaura tal cual y se programa la renovación.
        // No se llama a /api/auth/refresh, y tampoco a /api/auth/validate: la
        // información persistida ya dice cuándo expira.
        state = {
            ...record,
            accessTokenExpiresAtMs: accessMs,
            refreshTokenExpiresAtMs: refreshMs
        };
        scheduleProactiveRefresh();
        return { authenticated: true, restored: true };
    }

    if (Number.isFinite(refreshMs) && refreshMs <= currentMs) {
        // Refresh token también vencido: no tiene sentido gastar una petición que
        // el backend rechazará con 401. Se limpia sin tocar la red.
        state = emptyState();
        removeRecord();
        return { authenticated: false, restored: false };
    }

    // Access token vencido pero refresh utilizable: se restaura SOLO lo necesario
    // para renovar. El access token vencido NO entra en el estado, así que
    // getToken() devuelve null, isAuthenticated() devuelve false y role()
    // devuelve null mientras dura la renovación.
    state = {
        ...emptyState(),
        refreshToken: record.refreshToken,
        username: record.username ?? null,
        refreshTokenExpiresAt: record.refreshTokenExpiresAt ?? null,
        refreshTokenExpiresAtMs: refreshMs
    };

    // Misma función compartida: si algo más pidió un refresh a la vez, hay un
    // solo canje.
    await refresh();
    return { authenticated: isAuthenticated(), restored: true };
}

/* ------------------------------------------------------------------ *
 * logout()
 * ------------------------------------------------------------------ */

/**
 * POST /api/auth/logout con { auth:false, retryAuth:false }.
 *
 * El refresh token se captura ANTES de limpiar nada, porque la limpieza borra el
 * estado y ya no estaría disponible para enviarlo.
 *
 * El estado local se limpia INMEDIATAMENTE, antes de esperar al backend, no en
 * el finally. Así queda borrado pase lo que pase con la llamada remota: 200, el
 * 202 best-effort (CONTRATO §3.5), un error HTTP, un timeout o un fallo de red.
 * Dejar tokens locales tras un logout fallido es peor que no haber llamado.
 *
 * El finally NO vuelve a limpiar incondicionalmente: es una reafirmación
 * CONDICIONADA a la generación que inició este logout. Si mientras la llamada
 * viajaba llegó un login nuevo, un restore o un clear, el estado actual ya no es
 * el de esta sesión y no se toca. Un finally incondicional aquí borraría la
 * sesión recién abierta por el usuario.
 *
 * El error remoto SÍ se propaga —no se traga— porque el llamador puede querer
 * avisar de que la revocación no se completó. Lo que nunca depende de él es la
 * limpieza local, que ya ocurrió antes del await.
 */
export async function logout() {
    ensureAuthProviderInstalled();

    // 1. Capturar el refresh token ANTES de limpiar: después ya no existe.
    const refreshToken = state.refreshToken;

    // 2. Reclamar generación e invalidar de inmediato: un login o un refresh en
    //    vuelo de esta sesión ya no podrán escribir nada.
    const myGeneration = claimGeneration();

    // 3. Limpiar YA, sin esperar al backend. Esta es la corrección central: si la
    //    limpieza viviera en un finally incondicional después de await, un logout
    //    lento borraría la sesión de un login posterior —el usuario cierra
    //    sesión, vuelve a entrar, y la respuesta tardía del logout lo expulsa—.
    //    Limpiando aquí, el estado de esta sesión queda borrado pase lo que pase
    //    con la llamada remota: 200, 202, error HTTP, timeout o red.
    resetLocalState();
    removeRecord();

    try {
        if (!refreshToken) {
            return { revoked: false, status: null, note: null };
        }
        const response = await post("/api/auth/logout", {
            body: { refreshToken },
            auth: false,
            retryAuth: false
        });
        // 200 y 202 son ÉXITO. El 202 significa que el tier de datos no estaba
        // disponible y el refresh token sigue vivo, pero el access token expira
        // solo: no es un error y no se presenta como tal.
        return {
            revoked: response.data ? response.data.revoked === true : false,
            status: response.status,
            note: response.data ? response.data.note ?? null : null
        };
    } finally {
        // Red de seguridad CONDICIONADA a la identidad. Si esta sigue siendo la
        // generación vigente, se reafirma la limpieza (es idempotente: ya se hizo
        // en el paso 3). Si NO lo es, significa que mientras tanto llegó un login
        // nuevo, un restore o un clear: entonces no se toca absolutamente nada,
        // porque el estado que hay ya no es el de esta sesión. Un finally
        // incondicional aquí es exactamente el defecto que se está corrigiendo.
        if (myGeneration === generation) {
            resetLocalState();
            removeRecord();
        }
    }
}
