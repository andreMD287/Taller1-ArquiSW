/**
 * frontend/config.js — Configuración externa del tier de presentación.
 *
 * TÁCTICAS APLICADAS
 * ------------------
 * - "Configure Behavior" (Cap. 7, Integrabilidad): el comportamiento que depende
 *   del entorno —a qué backend se habla, cuánto se espera— se declara como
 *   configuración y no se codifica dentro de los módulos que lo consumen.
 * - "Defer Binding / Resource files" (Cap. 8, Modificabilidad): el enlace entre
 *   la aplicación y su entorno se difiere hasta el despliegue. Este archivo es el
 *   único punto de enlace, y se sustituye sin tocar nada de src/.
 *
 * POR QUÉ VIVE FUERA DE src/ (ADR-F01)
 * ------------------------------------
 * src/ es el artefacto; este archivo es la configuración. Está en la raíz de
 * frontend/ precisamente para poder generarlo o reemplazarlo al desplegar
 * (montarlo como volumen, escribirlo desde una plantilla, servirlo distinto por
 * entorno). Cambiar apiBaseUrl NO debe exigir recompilar ni reconstruir el
 * frontend, ni editar código de la aplicación: es la misma propiedad de
 * artefacto único que ADR-06 (Taller 1) exige del tier de lógica.
 *
 * Precedencia: window.__APP_CONFIG__ (inyectado en tiempo de ejecución por el
 * entorno, típicamente con una etiqueta script previa) por encima del valor por
 * defecto de desarrollo. El acceso a window está guardado porque este módulo
 * debe poder importarse fuera del navegador (pruebas), donde window no existe.
 *
 * POR QUÉ requestTimeoutMs Y latencyBudgetMs SON DISTINTOS, A PROPÓSITO
 * --------------------------------------------------------------------
 * No miden lo mismo y no deben igualarse:
 *
 *   latencyBudgetMs (2000) — PRESUPUESTO. Es el umbral a partir del cual una
 *       respuesta se considera un incumplimiento del objetivo de latencia. No
 *       aborta nada: solo se contabiliza. Sirve para MEDIR.
 *
 *   requestTimeoutMs (5000) — TIMEOUT. Es el punto en el que seguir esperando ya
 *       no es seguro y la operación se aborta ("Timeout / Unsafe State
 *       Detection"). Sirve para NO QUEDARSE COLGADO.
 *
 * Igualarlos censuraría la medición: toda petición que excediera el presupuesto
 * sería abortada antes de poder registrarse como excedida, y el contador de
 * incumplimientos quedaría permanentemente en cero mientras la experiencia real
 * empeora. La ventana 2000-5000 ms es justamente la que hay que poder observar.
 *
 * Este archivo es el ÚNICO lugar del frontend donde vive la dirección del
 * backend. Ningún módulo de src/ debe declararla ni reconstruirla.
 */

/**
 * Valor por defecto deliberado, para desarrollo local sin configuración previa:
 * es el puerto que expone el backend según backend/GUIA-DE-USO.md. Es un
 * fallback documentado, no una suposición: si window.__APP_CONFIG__ trae un
 * valor válido, ese gana siempre.
 */
const DEFAULT_API_BASE_URL = "http://localhost:8080";

/** Absoluta con esquema web. Se escribe así para no incrustar una URL literal. */
const ABSOLUTE_URL = /^https?:\/\/[^/]+/i;

/** Prefijo de ruta del mismo origen, p. ej. "/gateway". */
const ORIGIN_RELATIVE_PATH = /^\/[^/]/;

/**
 * Normaliza la base para que concatenar rutas nunca produzca barras duplicadas
 * ni barras ausentes:
 *   - recorta espacios,
 *   - elimina TODAS las barras finales,
 *   - acepta una base absoluta, una base relativa al origen, o cadena vacía
 *     (mismo origen exacto),
 *   - ante cualquier otra cosa devuelve null, para que quien llame decida.
 */
export function normalizeBaseUrl(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
        // Cadena vacía = mismo origen. Es válido y distinto de "no configurado".
        return "";
    }
    const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
    if (withoutTrailingSlashes === "") {
        // Era solo barras ("/", "///"): mismo origen.
        return "";
    }
    if (ABSOLUTE_URL.test(withoutTrailingSlashes) || ORIGIN_RELATIVE_PATH.test(withoutTrailingSlashes)) {
        return withoutTrailingSlashes;
    }
    return null;
}

/** Lee la configuración inyectada en tiempo de ejecución, si hay navegador. */
function readRuntimeConfig() {
    // globalThis existe en navegador y fuera de él; window solo en el navegador.
    const runtime = typeof globalThis !== "undefined" ? globalThis.window : undefined;
    const injected = runtime && runtime.__APP_CONFIG__;
    return injected && typeof injected === "object" ? injected : {};
}

function resolveApiBaseUrl() {
    const configured = normalizeBaseUrl(readRuntimeConfig().apiBaseUrl);
    return configured === null ? normalizeBaseUrl(DEFAULT_API_BASE_URL) : configured;
}

export const config = Object.freeze({
    apiBaseUrl: resolveApiBaseUrl(),
    requestTimeoutMs: 5000,
    latencyBudgetMs: 2000,
    pageSize: 20
});

/**
 * Construye una URL absoluta a partir de una ruta de la API.
 *
 * Vive aquí, junto a la base, y no en el cliente HTTP, para que ningún otro
 * módulo tenga que conocer —ni volver a normalizar— la dirección del backend.
 * Garantiza exactamente una barra de separación, venga la ruta con barra
 * inicial o sin ella.
 */
export function resolveUrl(path) {
    const suffix = typeof path === "string" ? path.trim() : "";
    if (suffix === "") {
        return config.apiBaseUrl;
    }
    const withLeadingSlash = suffix.startsWith("/") ? suffix : "/" + suffix;
    return config.apiBaseUrl + withLeadingSlash.replace(/^\/+/, "/");
}

export default config;
