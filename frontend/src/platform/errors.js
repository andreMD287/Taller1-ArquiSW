/**
 * frontend/src/platform/errors.js — Traducción uniforme de fallos a un modelo
 * interno único.
 *
 * TÁCTICA APLICADA
 * ----------------
 * "Encapsulate" (Cap. 7): la forma en que el backend reporta un fallo —el
 * ErrorResponse de ADR-007, un cuerpo vacío de la cadena de seguridad, un
 * rechazo de fetch— queda contenida aquí. El resto del frontend consume un
 * único modelo y no vuelve a mirar un status HTTP crudo ni a parsear un cuerpo.
 * Si el contrato de transporte cambia, cambia este archivo.
 *
 * QUÉ NO HACE ESTE MÓDULO, A PROPÓSITO
 * ------------------------------------
 * - No interpreta `rule`. El identificador de una regla de negocio es contrato
 *   estructurado del backend, para diagnóstico y trazabilidad; aquí se conserva
 *   tal cual y no se ramifica sobre él.
 * - No reescribe ni completa `message`. Si el backend no envió mensaje, el
 *   modelo lleva null y la decisión de qué texto mostrar es de la capa de UI.
 * - No implementa reglas de negocio. Ese es el motor del backend (ADR-003 /
 *   ADR-004), y replicarlo aquí crearía una segunda fuente de verdad capaz de
 *   rechazar operaciones que el servidor acepta (ver frontend/CONTRATO.md §4.1).
 *
 * SOBRE `category`
 * ----------------
 * `category` es un campo del MODELO INTERNO DE UI, no un código entregado por el
 * backend. Existe para que la UI decida su reacción (reintentar, volver al
 * login, resaltar campos) sin ramificar sobre números HTTP repartidos por toda
 * la aplicación. El cliente NUNCA debe inventar un ErrorResponse.code: cuando el
 * backend no lo produce —el 403 vacío es el caso real— `code` queda en null y
 * lo que se usa es `category`. Son dos espacios de nombres distintos y no deben
 * mezclarse.
 *
 * SOBRE `X-Request-Id`
 * --------------------
 * Se toma del cuerpo (`requestId`) cuando el backend lo incluye, y de la
 * cabecera `X-Request-Id` cuando no hay cuerpo interpretable. El filtro
 * RequestIdFilter corre con HIGHEST_PRECEDENCE, antes de la cadena de
 * seguridad, así que la cabecera llega incluso en el 403 vacío: es el único
 * hilo que permite correlacionar ese rechazo con los logs del backend.
 *
 * LECTURA DEL CUERPO
 * ------------------
 * Este módulo NO lee la respuesta: recibe el cuerpo ya leído por http.js (texto
 * crudo y, si era JSON válido, el objeto). Un Response solo se puede consumir
 * una vez, y así se garantiza que se lea exactamente una.
 */

/** Categorías del modelo interno de UI. No son códigos del backend. */
export const CATEGORY = Object.freeze({
    VALIDATION: "validation",
    UNAUTHORIZED: "unauthorized",
    FORBIDDEN: "forbidden",
    NOT_FOUND: "not_found",
    CONFLICT: "conflict",
    LOCKED: "locked",
    BUSINESS_RULE: "business_rule",
    UNAVAILABLE: "unavailable",
    SERVER: "server",
    CLIENT: "client",
    NETWORK: "network",
    TIMEOUT: "timeout",
    ABORTED: "aborted",
    UNKNOWN: "unknown"
});

/** Status convencional para intentos que nunca obtuvieron respuesta HTTP. */
export const NO_HTTP_STATUS = "000";

/**
 * Clasificación por forma de la respuesta HTTP, no por regla de negocio.
 * 422 se separa de los demás 4xx porque es el único que trae violaciones por
 * campo y la UI lo trata distinto (resaltar inputs, no avisar de un fallo).
 */
export function categoryForStatus(status) {
    switch (status) {
        case 400: return CATEGORY.VALIDATION;
        case 401: return CATEGORY.UNAUTHORIZED;
        case 403: return CATEGORY.FORBIDDEN;
        case 404: return CATEGORY.NOT_FOUND;
        case 409: return CATEGORY.CONFLICT;
        case 422: return CATEGORY.BUSINESS_RULE;
        case 423: return CATEGORY.LOCKED;
        case 503: return CATEGORY.UNAVAILABLE;
        default:
            if (status >= 500) return CATEGORY.SERVER;
            if (status >= 400) return CATEGORY.CLIENT;
            return CATEGORY.UNKNOWN;
    }
}

/**
 * Indexa las violaciones por campo para que el formulario pueda localizar el
 * input correspondiente.
 *
 * - Un mismo campo puede acumular varias violaciones: el valor es un arreglo.
 * - Las violaciones SIN `field` no se descartan ni se inventan un campo: van a
 *   `generalViolations`, para que la UI pueda mostrarlas junto al formulario en
 *   vez de perderlas en silencio.
 */
export function indexViolations(violations) {
    const byField = {};
    const general = [];
    for (const violation of violations) {
        const field = violation && typeof violation.field === "string" ? violation.field.trim() : "";
        if (field === "") {
            general.push(violation);
            continue;
        }
        if (!byField[field]) {
            byField[field] = [];
        }
        byField[field].push(violation);
    }
    return { violationsByField: byField, generalViolations: general };
}

function baseModel(overrides) {
    return Object.freeze({
        code: null,
        message: null,
        kind: null,
        retryable: false,
        requestId: null,
        detail: null,
        violations: [],
        violationsByField: {},
        generalViolations: [],
        httpStatus: null,
        category: CATEGORY.UNKNOWN,
        ...overrides
    });
}

/**
 * Traduce una respuesta HTTP fallida.
 *
 * @param {object}      input
 * @param {number}      input.status      status HTTP real.
 * @param {string|null} input.requestId   X-Request-Id de la cabecera, si vino.
 * @param {string}      input.bodyText    cuerpo crudo ya leído (puede ser "").
 * @param {object|null} input.bodyJson    cuerpo parseado, o null si no era JSON.
 *
 * Tolera las cuatro formas que el backend puede producir: ErrorResponse JSON,
 * cuerpo de texto plano, cuerpo vacío y 204 sin cuerpo.
 */
export function fromResponse({ status, requestId = null, bodyText = "", bodyJson = null }) {
    const category = categoryForStatus(status);

    // Sin JSON interpretable: el caso real es el 403 vacío de Spring Security,
    // que llega sin Content-Type, sin cuerpo y sin code. No se fabrica un code.
    if (bodyJson === null || typeof bodyJson !== "object") {
        const text = typeof bodyText === "string" ? bodyText.trim() : "";
        return baseModel({
            httpStatus: status,
            category,
            requestId,
            // El texto crudo del servidor va a `detail` (diagnóstico), nunca a
            // `message`: no es texto preparado para el usuario final.
            detail: text === "" ? null : text
        });
    }

    // ErrorResponse de ADR-007. `detail` y `violations` pueden venir AUSENTES
    // (@JsonInclude(NON_NULL) en la clase), no como null ni como []: por eso se
    // comprueba la existencia y se normaliza a un arreglo vacío en el modelo
    // interno, que sí garantiza la forma a quien lo consume.
    const violations = Array.isArray(bodyJson.violations) ? bodyJson.violations : [];
    const { violationsByField, generalViolations } = indexViolations(violations);

    return baseModel({
        code: typeof bodyJson.code === "string" ? bodyJson.code : null,
        message: typeof bodyJson.message === "string" ? bodyJson.message : null,
        kind: typeof bodyJson.kind === "string" ? bodyJson.kind : null,
        retryable: bodyJson.retryable === true,
        requestId: typeof bodyJson.requestId === "string" ? bodyJson.requestId : requestId,
        detail: typeof bodyJson.detail === "string" ? bodyJson.detail : null,
        violations,
        violationsByField,
        generalViolations,
        httpStatus: status,
        category
    });
}

/**
 * Recorta la causa a un diagnóstico seguro: tipo de error y primera línea del
 * mensaje, truncada.
 *
 * Nunca se incluye el cuerpo de la petición. Los mensajes de los motores para
 * una estructura circular describen el CAMINO de propiedades que cierra el
 * ciclo, y aunque eso es esquema y no valores, tampoco hace falta: para saber
 * qué hacer basta con "no se pudo serializar y de qué tipo fue el fallo".
 */
function safeDetail(cause) {
    if (!cause) {
        return null;
    }
    const name = typeof cause.name === "string" && cause.name !== "" ? cause.name : "Error";
    const message = typeof cause.message === "string" ? cause.message.split("\n")[0].trim() : "";
    const detail = message === "" ? name : name + ": " + message;
    return detail.length > 200 ? detail.slice(0, 197) + "..." : detail;
}

/**
 * Traduce un fallo LOCAL del cliente: la petición nunca llegó a intentarse.
 *
 * El caso real es un cuerpo que no se puede serializar a JSON (una estructura
 * circular, un BigInt). No es un fallo de transporte y no debe disfrazarse de
 * uno: no hubo red, no hubo servidor, y reintentarlo daría exactamente el mismo
 * resultado —por eso retryable es false—. Clasificarlo como `network` haría que
 * un defecto del propio frontend apareciera como indisponibilidad del backend.
 *
 * httpStatus es "000" porque no hubo respuesta HTTP, igual que en un fallo de
 * transporte; lo que los distingue es `category`, no el status.
 */
export function fromClientFailure({ requestId = null, cause = null, detail = null }) {
    return baseModel({
        httpStatus: NO_HTTP_STATUS,
        category: CATEGORY.CLIENT,
        requestId,
        retryable: false,
        detail: detail !== null ? detail : safeDetail(cause)
    });
}

/**
 * Traduce un fallo de transporte: la petición SÍ se intentó y no obtuvo
 * respuesta HTTP.
 *
 * Las tres causas se distinguen porque exigen reacciones distintas de la UI:
 *   TIMEOUT  - el cliente dejó de esperar (requestTimeoutMs). Ofrecer reintento.
 *   ABORTED  - lo canceló la propia aplicación. NO es un fallo: no se avisa.
 *   NETWORK  - no hubo forma de hablar con el backend. Ofrecer reintento.
 *
 * httpStatus es "000", la misma convención que backend/scripts/probe.sh usa
 * para "sin respuesta", para que las dos mediciones sean comparables en forma.
 */
export function fromTransportFailure({ category, requestId = null, cause = null }) {
    return baseModel({
        httpStatus: NO_HTTP_STATUS,
        category,
        requestId,
        retryable: category !== CATEGORY.ABORTED,
        detail: cause && typeof cause.message === "string" ? cause.message : null
    });
}
