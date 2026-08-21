/**
 * frontend/src/platform/http.js — Cliente HTTP único del tier de presentación.
 *
 * ES EL ÚNICO ARCHIVO DE frontend/src/** QUE LLAMA A fetch(). Esa es la
 * invariante que sostiene todo lo demás: si hubiera una segunda llamada suelta,
 * habría peticiones sin timeout, sin correlación y sin medir, y las métricas
 * dejarían de describir el sistema.
 *
 * TÁCTICAS APLICADAS
 * ------------------
 * - "Encapsulate" (Cap. 7): el transporte —URL, cabeceras, serialización,
 *   parseo, traducción de errores— queda detrás de get/post/put/del. crud/ y
 *   resources/ no conocen fetch, ni el formato del cuerpo de error, ni tokens.
 * - "Timeout / Unsafe State Detection" (Cap. 10, Safety): toda petición tiene un
 *   límite duro (config.requestTimeoutMs). Esperar indefinidamente por una
 *   respuesta que no va a llegar es el estado inseguro que esta táctica detecta
 *   y corta.
 * - "Monitor Resources / Metering" (Cap. 6): cada intento deja exactamente una
 *   muestra en metrics.js, incluidos los que fallan. Medir solo los éxitos
 *   produce un panel que mejora cuando el sistema empeora.
 *
 * Dos capítulos distintos actúan sobre el mismo timeout y conviene no
 * confundirlos: el Cap. 10 justifica ABORTAR (seguir esperando es un estado
 * inseguro), y el Cap. 4 gobierna cómo se CLASIFICA el resultado —el intento
 * abortado cuenta como no disponible, y la taxonomía EXPECTED/FAULT/FAILURE
 * que decide eso es del Cap. 4, no de este módulo (ver metrics.js).
 *
 * QUÉ NO HACE ESTE COMMIT
 * -----------------------
 * No hay reintentos automáticos, ni manejo de 401, ni refresh silencioso, ni
 * caché, ni cola de concurrencia. Llegan con session.js y con el commit de
 * caché. Aquí solo está el transporte.
 */

import { config, resolveUrl } from "../../config.js";
import * as metrics from "./metrics.js";
import { CATEGORY, NO_HTTP_STATUS, fromClientFailure, fromResponse, fromTransportFailure } from "./errors.js";

/* ------------------------------------------------------------------ *
 * Proveedor de autenticación (inyección, para no depender de sesión)
 * ------------------------------------------------------------------ */

/**
 * El token NO se importa: se inyecta.
 *
 * Este módulo no importa el módulo de sesión y no debe hacerlo nunca: la sesión
 * necesita hablar HTTP (login, refresh) y el transporte necesita un token, así
 * que importarse mutuamente sería un ciclo. Se rompe invirtiendo la dependencia:
 * aquí solo se declara la FORMA del proveedor ({ getToken() }), y quien tenga el
 * token se registra a sí mismo llamando a configureAuthProvider().
 *
 * En un commit posterior, el módulo de sesión será quien haga ese registro
 * durante el arranque de la aplicación. Esta mención es documental: no hay
 * import, y este archivo compila y se prueba sin que ese módulo exista.
 *
 * crud/ y resources/ nunca reciben ni pasan tokens: no saben que existen.
 */
let authProvider = null;

export function configureAuthProvider(provider) {
    authProvider = provider || null;
}

async function resolveAuthToken(auth) {
    if (auth === false || !authProvider || typeof authProvider.getToken !== "function") {
        return null;
    }
    // Se acepta que getToken() sea síncrono o asíncrono.
    const token = await authProvider.getToken();
    return typeof token === "string" && token !== "" ? token : null;
}

/* ------------------------------------------------------------------ *
 * Ajustes con origen en config.js
 * ------------------------------------------------------------------ */

let overrides = { timeoutMs: null, latencyBudgetMs: null };

/**
 * Seam de configuración para pruebas y ajuste por entorno.
 *
 * Los valores POR DEFECTO son siempre los de config.js; esto solo los
 * sobrescribe en memoria. Existe para que las pruebas puedan ejercitar timeout y
 * presupuesto en decenas de milisegundos en vez de esperar 5 segundos reales,
 * sin bajar los valores de producción dentro de config.js.
 *
 * Deliberadamente NO permite sobrescribir apiBaseUrl: la dirección del backend
 * tiene un solo origen (config.js) y esa invariante no se negocia por comodidad
 * de pruebas.
 */
export function configureHttp({ timeoutMs, latencyBudgetMs } = {}) {
    if (Number.isFinite(timeoutMs)) overrides.timeoutMs = timeoutMs;
    if (Number.isFinite(latencyBudgetMs)) overrides.latencyBudgetMs = latencyBudgetMs;
}

export function resetHttpConfig() {
    overrides = { timeoutMs: null, latencyBudgetMs: null };
}

const timeoutMs = () => overrides.timeoutMs ?? config.requestTimeoutMs;
const latencyBudgetMs = () => overrides.latencyBudgetMs ?? config.latencyBudgetMs;

/* ------------------------------------------------------------------ *
 * Error público del cliente
 * ------------------------------------------------------------------ */

/**
 * Se lanza ante cualquier resultado no exitoso. Lleva el modelo interno de
 * errors.js en `.error`; quien la captura ramifica por `error.category` (modelo
 * de UI) o por `error.code` (contrato del backend), nunca por el status crudo.
 */
export class HttpError extends Error {
    constructor(error) {
        super(error.message || error.code || error.category || "http_error");
        this.name = "HttpError";
        this.error = error;
    }
}

/* ------------------------------------------------------------------ *
 * Utilidades internas
 * ------------------------------------------------------------------ */

const INTERNAL_HEADERS = ["content-type", "accept", "x-request-id", "authorization"];

/**
 * Identificador de correlación. crypto.randomUUID() cuando existe (navegador y
 * runtimes modernos); si no, un identificador con forma de UUID v4 derivado de
 * Math.random(). El fallback NO es criptográficamente fuerte y no hace falta que
 * lo sea: solo sirve para cruzar una petición con una línea de log, y existe
 * para que este módulo se pueda ejecutar en entornos de prueba sin WebCrypto.
 */
function newRequestId() {
    const webcrypto = globalThis.crypto;
    if (webcrypto && typeof webcrypto.randomUUID === "function") {
        return webcrypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const random = (Math.random() * 16) | 0;
        const value = char === "x" ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

/**
 * Serialización determinista de query params: claves ordenadas
 * alfabéticamente, para que la misma consulta produzca siempre la misma URL
 * (comparable en logs y cacheable por clave en el commit siguiente).
 *
 * Valores repetidos: un arreglo se serializa REPITIENDO la clave
 * (?sort=name,asc&sort=id,desc), que es la forma que Spring vincula sin
 * ambigüedad a una lista y la que usa Pageable para `sort`. No se usa la
 * convención "clave[]" porque el backend no la interpreta.
 *
 * undefined y null se omiten (no son "el valor vacío", son "sin valor"); la
 * cadena vacía sí se envía, porque es un valor.
 */
function buildQuery(query) {
    if (!query || typeof query !== "object") {
        return "";
    }
    const parts = [];
    for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined || value === null) {
            continue;
        }
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
            if (item === undefined || item === null) {
                continue;
            }
            parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(item)));
        }
    }
    return parts.length === 0 ? "" : "?" + parts.join("&");
}

/**
 * Etiqueta estable para métricas: método + ruta con los identificadores
 * sustituidos por ":id". Sin query string.
 *
 * Dos razones: evita que cada id genere una operación distinta (haría inútil
 * cualquier percentil por operación), y evita registrar datos del usuario —el
 * término buscado en ?name= es entrada de una persona y no tiene por qué
 * quedar en una muestra de métricas.
 */
function operationLabel(method, path) {
    const withoutQuery = String(path).split("?")[0];
    const stable = withoutQuery.replace(/\/\d+(?=\/|$)/g, "/:id");
    return method + " " + stable;
}

/**
 * Tamaño del cuerpo leído, en bytes.
 *
 * Preferencia: bytes reales vía TextEncoder. Si no existe (entornos de prueba
 * sin TextEncoder), se usa Content-Length cuando el servidor lo envía y, como
 * último recurso, la longitud de la cadena, que solo coincide con los bytes en
 * ASCII y subestima cualquier carácter multibyte. Se documenta porque el
 * fallback es aproximado y no debe leerse como una medición exacta.
 */
function measureBytes(text, contentLength) {
    if (typeof text === "string" && text !== "" && typeof TextEncoder === "function") {
        return new TextEncoder().encode(text).length;
    }
    // Ojo: Number(null) es 0. Sin este guardo, una respuesta SIN Content-Length
    // se reportaria como "0 bytes" en vez de caer al ultimo recurso.
    if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared >= 0) {
            return declared;
        }
    }
    return typeof text === "string" ? text.length : 0;
}

function headerValue(response, name) {
    const headers = response && response.headers;
    return headers && typeof headers.get === "function" ? headers.get(name) : null;
}

/**
 * Lee el cuerpo UNA SOLA VEZ.
 *
 * Siempre con .text(), nunca con .json(): un Response solo se puede consumir una
 * vez, y .json() sobre un cuerpo vacío o no-JSON lanza. Leyendo texto y
 * parseando aparte, el mismo camino sirve para JSON, texto plano, cuerpo vacío
 * y 204, y errors.js recibe las dos formas sin volver a tocar la respuesta.
 */
async function readBody(response) {
    // 204 No Content y 205 Reset Content no tienen cuerpo por especificación:
    // ni siquiera se intenta parsear.
    if (response.status === 204 || response.status === 205) {
        return { bodyText: "", bodyJson: null };
    }
    const bodyText = await response.text();
    if (!bodyText) {
        return { bodyText: "", bodyJson: null };
    }
    try {
        return { bodyText, bodyJson: JSON.parse(bodyText) };
    } catch (_error) {
        return { bodyText, bodyJson: null };
    }
}

async function buildHeaders({ extraHeaders, hasJsonBody, requestId, auth }) {
    const headers = {};
    // Primero las adicionales, después las internas: las internas ganan siempre,
    // para que un encabezado suelto no pueda desactivar la correlación ni
    // suplantar la autorización por accidente.
    if (extraHeaders && typeof extraHeaders === "object") {
        for (const [name, value] of Object.entries(extraHeaders)) {
            if (!INTERNAL_HEADERS.includes(name.toLowerCase())) {
                headers[name] = value;
            }
        }
    }
    headers["Accept"] = "application/json";
    headers["X-Request-Id"] = requestId;
    if (hasJsonBody) {
        headers["Content-Type"] = "application/json";
    }
    const token = await resolveAuthToken(auth);
    if (token) {
        headers["Authorization"] = "Bearer " + token;
    }
    return headers;
}

/* ------------------------------------------------------------------ *
 * Petición
 * ------------------------------------------------------------------ */

/**
 * @returns {Promise<{data: any, status: number, requestId: string|null,
 *                    latencyMs: number, bytes: number}>}
 *
 * Se devuelve un sobre y no el cuerpo pelado, de forma consistente para todas
 * las operaciones: `data` es el cuerpo ya parseado (null en 204), y los
 * metadatos los necesitan los módulos siguientes —`status` para distinguir el
 * 202 best-effort de logout del 200 (CONTRATO §3.5), `requestId` para mostrarlo
 * en un aviso de error, `latencyMs` para la UI de lentitud—. Ante cualquier
 * resultado no exitoso se lanza HttpError; no se devuelven errores como valor.
 */
async function request(method, path, options = {}) {
    const { query, body, signal: externalSignal, headers: extraHeaders, auth = true } = options;

    const url = resolveUrl(path) + buildQuery(query);
    const operation = operationLabel(method, path);
    const requestId = newRequestId();
    const hasJsonBody = body !== undefined && body !== null;
    const budget = latencyBudgetMs();

    // La serialización va PRIMERO, antes del cronómetro, del temporizador de
    // timeout y del propio fetch. Si se hiciera dentro del try que envuelve a
    // fetch, un cuerpo no serializable (estructura circular, BigInt) caería en
    // el catch de transporte y se reportaría como error de RED: un defecto
    // local del frontend contaminaría la disponibilidad medida del backend.
    // Aquí no hay red que pueda fallar todavía, así que el fallo se clasifica
    // por lo que es —local del cliente— y no deja muestra en metrics.js, porque
    // no hubo ningún intento HTTP que medir.
    let serializedBody;
    if (hasJsonBody) {
        try {
            serializedBody = JSON.stringify(body);
        } catch (cause) {
            throw new HttpError(fromClientFailure({ requestId, cause }));
        }
        if (serializedBody === undefined) {
            // JSON.stringify devuelve undefined sin lanzar para valores que no
            // tienen representación JSON (una función, un símbolo). Enviar la
            // petición sin cuerpo pero con Content-Type: application/json sería
            // una petición mal formada silenciosa.
            throw new HttpError(fromClientFailure({
                requestId,
                detail: "TypeError: el cuerpo no tiene representacion JSON"
            }));
        }
    }

    // El token se resuelve ANTES de arrancar el cronómetro: el proveedor podría
    // ser asíncrono y su latencia no es latencia de red.
    const headers = await buildHeaders({ extraHeaders, hasJsonBody, requestId, auth });

    // Un AbortController nuevo por petición, nunca reutilizado: abortar es
    // irreversible, y un controlador compartido cancelaría peticiones ajenas.
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;

    const onExternalAbort = () => {
        externallyAborted = true;
        controller.abort();
    };
    if (externalSignal) {
        if (externalSignal.aborted) {
            externallyAborted = true;
            controller.abort();
        } else if (typeof externalSignal.addEventListener === "function") {
            externalSignal.addEventListener("abort", onExternalAbort);
        }
    }

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs());

    const startedAt = performance.now();
    let outcome;

    try {
        const response = await fetch(url, {
            method,
            headers,
            body: serializedBody,
            signal: controller.signal
        });

        const { bodyText, bodyJson } = await readBody(response);
        // Se mide hasta después de leer y parsear: el cuerpo forma parte de lo
        // que el usuario espera, no solo las cabeceras.
        const latencyMs = performance.now() - startedAt;
        const responseRequestId = headerValue(response, "X-Request-Id") || requestId;
        const bytes = measureBytes(bodyText, headerValue(response, "Content-Length"));
        const kind = bodyJson && typeof bodyJson.kind === "string" ? bodyJson.kind : null;

        metrics.record({
            timestamp: new Date().toISOString(),
            operation,
            kind,
            httpStatus: response.status,
            latencyMs,
            bytes,
            timeout: false,
            budgetExceeded: latencyMs > budget,
            cacheHit: false
        });

        if (response.ok) {
            outcome = {
                ok: true,
                value: {
                    data: bodyJson !== null ? bodyJson : (bodyText === "" ? null : bodyText),
                    status: response.status,
                    requestId: responseRequestId,
                    latencyMs,
                    bytes
                }
            };
        } else {
            outcome = {
                ok: false,
                error: fromResponse({
                    status: response.status,
                    requestId: responseRequestId,
                    bodyText,
                    bodyJson
                })
            };
        }
    } catch (cause) {
        // Aquí solo llegan fallos de TRANSPORTE: los errores HTTP no se lanzan
        // dentro del try (se acumulan en `outcome` y se lanzan al final), y los
        // fallos locales del cliente ya se lanzaron antes de entrar aquí.
        const latencyMs = performance.now() - startedAt;

        // El orden importa: un timeout aborta el controlador, así que sin el
        // flag `timedOut` un vencimiento sería indistinguible de una
        // cancelación externa, y ambos de un error de red.
        let category = CATEGORY.NETWORK;
        if (timedOut) {
            category = CATEGORY.TIMEOUT;
        } else if (externallyAborted || (externalSignal && externalSignal.aborted)) {
            category = CATEGORY.ABORTED;
        }

        metrics.record({
            timestamp: new Date().toISOString(),
            operation,
            kind: null,
            httpStatus: NO_HTTP_STATUS,
            // Latencia REALMENTE observada hasta el aborto, no el valor nominal
            // del timeout: es lo que el usuario esperó.
            latencyMs,
            bytes: 0,
            timeout: category === CATEGORY.TIMEOUT,
            budgetExceeded: latencyMs > budget,
            cacheHit: false
        });

        outcome = { ok: false, error: fromTransportFailure({ category, requestId, cause }) };
    } finally {
        clearTimeout(timer);
        if (externalSignal && typeof externalSignal.removeEventListener === "function") {
            externalSignal.removeEventListener("abort", onExternalAbort);
        }
    }

    if (!outcome.ok) {
        throw new HttpError(outcome.error);
    }
    return outcome.value;
}

/* ------------------------------------------------------------------ *
 * API pública
 * ------------------------------------------------------------------ */

export const get = (path, options) => request("GET", path, options);
export const post = (path, options) => request("POST", path, options);
export const put = (path, options) => request("PUT", path, options);
export const del = (path, options) => request("DELETE", path, options);
