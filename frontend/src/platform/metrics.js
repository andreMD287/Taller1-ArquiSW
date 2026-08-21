/**
 * frontend/src/platform/metrics.js — Modelo de métricas del tier de presentación.
 *
 * TÁCTICA APLICADA
 * ----------------
 * "Monitor Resources / Metering" (Cap. 6): no se puede afirmar nada sobre
 * disponibilidad ni latencia percibidas por el cliente sin medirlas donde el
 * cliente está. El backend mide lo que él ve; este módulo mide lo que ve el
 * navegador, que incluye la red, el timeout del cliente y los rechazos que
 * nunca llegan a un controlador (el 403 vacío de la cadena de seguridad).
 *
 * Guarda UNA muestra por cada intento HTTP real. No agrega, no promedia y no
 * descarta nada al registrar: agregar es responsabilidad de report().
 *
 * REGLA ÚNICA DE DISPONIBILIDAD (isAvailable)
 * -------------------------------------------
 *   cualquier HTTP 2xx              -> available = 1
 *   respuesta con kind == EXPECTED  -> available = 1
 *   cualquier otro resultado        -> available = 0
 *
 * Consecuencias, todas deliberadas:
 *   - 204 No Content es DISPONIBLE (es 2xx: el borrado funcionó).
 *   - 422 con kind EXPECTED es DISPONIBLE: el sistema respondió según su
 *     especificación; una regla de negocio incumplida no es una caída (Cap. 4,
 *     y ADR-007 del backend, que la clasifica como EXPECTED precisamente para
 *     que no cuente contra la disponibilidad).
 *   - 403 vacío es NO DISPONIBLE: no trae kind, y desde el cliente es una
 *     operación que no se pudo completar.
 *   - timeout y error de red son NO DISPONIBLES (httpStatus "000").
 *
 * RELACIÓN CON backend/scripts/probe.sh — LEER ANTES DE CONCATENAR RESULTADOS
 * --------------------------------------------------------------------------
 * probe.sh usa una regla más estrecha: trata explícitamente "200" y "201" como
 * disponibles y, para cualquier otro status, consulta kind == EXPECTED. Esta
 * regla la AMPLÍA a todo 2xx, porque el frontend sí ejerce operaciones que
 * responden 204 (DELETE) y que probe.sh no ejercita.
 *
 * Los dos esquemas comparten las columnas
 *     timestamp,operation,available,kind,http_status,latency_ms
 * y ambos usan "000" para "sin respuesta", así que son concatenables en forma.
 * Lo que NO coincide es qué significa cada fila:
 *
 *   - Punto de ejecución. Los dos son sondas de CLIENTE, no mediciones tomadas
 *     dentro del servidor: probe.sh mide con curl desde el entorno donde se
 *     ejecuta el script, y este módulo mide desde el navegador del usuario.
 *     Ambos incluyen el transporte desde su respectivo punto de ejecución.
 *   - Lo que rodea a cada uno. No tienen necesariamente la misma ruta de red,
 *     ni la misma carga, ni el mismo caché, ni el mismo comportamiento de
 *     cliente (un navegador reutiliza conexiones, aplica CORS y compite con el
 *     resto de la pestaña; curl arranca limpio en cada invocación).
 *   - Semántica de available. Difiere para las respuestas 2xx distintas de
 *     200/201: aquí un 204 cuenta como disponible y en probe.sh caería a la
 *     rama de kind, donde un cuerpo vacío no es interpretable.
 *
 * Por eso NO se deben concatenar ni promediar corridas de los dos sin
 * normalizar antes la semántica y sin registrar el origen de cada fila; unirlas
 * sin más produciría una disponibilidad que no significa nada. Queda registrado
 * aquí, no resuelto: no se toca probe.sh, que es de Rol 4.
 */

/** Columnas del CSV que exportará el commit de instrumentación (exportCsv()). */
export const CSV_COLUMNS = Object.freeze([
    "timestamp",
    "operation",
    "available",
    "kind",
    "http_status",
    "latency_ms"
]);

/** Kind del backend que cuenta como disponible (taxonomía del Cap. 4). */
const EXPECTED = "EXPECTED";

let samples = [];

/**
 * Único punto donde se decide si un intento cuenta como disponible.
 * Acepta el status como número o como cadena ("000" para intentos sin
 * respuesta), para no obligar a quien llama a normalizarlo antes.
 */
export function isAvailable({ httpStatus, kind } = {}) {
    const status = Number(httpStatus);
    if (Number.isFinite(status) && status >= 200 && status <= 299) {
        return 1;
    }
    return kind === EXPECTED ? 1 : 0;
}

/**
 * Registra una muestra. Devuelve la muestra normalizada y congelada, para que
 * quien llama pueda inspeccionarla sin poder mutar lo almacenado.
 *
 * available se recalcula aquí siempre: que exista una sola regla no sirve de
 * nada si cada llamador puede pasar el valor que quiera.
 */
export function record({
    timestamp,
    operation,
    kind = null,
    httpStatus,
    latencyMs,
    bytes = 0,
    timeout = false,
    budgetExceeded = false,
    cacheHit = false
} = {}) {
    const sample = Object.freeze({
        timestamp: typeof timestamp === "string" ? timestamp : new Date().toISOString(),
        operation: typeof operation === "string" ? operation : "unknown",
        available: isAvailable({ httpStatus, kind }),
        kind: kind === undefined ? null : kind,
        httpStatus,
        latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0,
        bytes: Number.isFinite(bytes) ? bytes : 0,
        timeout: timeout === true,
        budgetExceeded: budgetExceeded === true,
        cacheHit: cacheHit === true
    });
    samples.push(sample);
    return sample;
}

/** Copia superficial: el arreglo es nuevo, las muestras están congeladas. */
export function getSamples() {
    return samples.slice();
}

/**
 * Muestras que ejecutaron una petición de red de verdad.
 *
 * En este commit son todas (cacheHit siempre es false, porque el caché aún no
 * existe). Se expresa como filtro desde ya para que los percentiles de red no
 * se contaminen el día que existan aciertos de caché, que no midieron red.
 */
export function getNetworkSamples() {
    return samples.filter((sample) => sample.cacheHit === false);
}

/** Vacía el estado. Existe para que cada prueba parta de cero. */
export function reset() {
    samples = [];
}

/**
 * Percentil por rango más cercano (nearest-rank), sin interpolación: para p y n
 * dados, devuelve el elemento en la posición ceil(p/100 * n) del arreglo
 * ordenado ascendentemente. Es determinista y no inventa valores intermedios
 * que nunca se observaron.
 *
 * SIN MUESTRAS DEVUELVE null, nunca 0: cero es un valor de latencia legítimo y
 * confundir "no medido" con "instantáneo" es exactamente el error que hace que
 * un panel de métricas mienta.
 */
export function percentile(values, p) {
    const finite = values.filter((value) => Number.isFinite(value));
    if (finite.length === 0) {
        return null;
    }
    const sorted = finite.slice().sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
    return sorted[index];
}

/**
 * p50, p95 y max de la latencia observada.
 *
 * Los timeouts SÍ entran, con la latencia real medida hasta el aborto. Omitirlos
 * mejoraría el percentil justo cuando el sistema está peor: una corrida donde
 * la mitad de las peticiones expiran mostraría un p95 excelente calculado sobre
 * la mitad que sí respondió. Los timeouts se cuentan además por separado
 * (report().timeouts) para poder leer las dos cosas.
 */
export function latencyStats(sampleList = getNetworkSamples()) {
    const latencies = sampleList.map((sample) => sample.latencyMs);
    return {
        count: latencies.length,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: latencies.length === 0 ? null : Math.max(...latencies)
    };
}

/**
 * Resumen agregado. Contadores separados a propósito:
 *   - timeouts: intentos abortados por requestTimeoutMs.
 *   - budgetExceeded: intentos que superaron latencyBudgetMs, HAYAN o no
 *     expirado. Un timeout normalmente también excede el presupuesto; son dos
 *     preguntas distintas y se responden por separado.
 */
export function report() {
    const all = getSamples();
    const network = getNetworkSamples();
    const available = all.filter((sample) => sample.available === 1).length;
    return {
        total: all.length,
        networkAttempts: network.length,
        available,
        unavailable: all.length - available,
        availabilityRatio: all.length === 0 ? null : available / all.length,
        timeouts: all.filter((sample) => sample.timeout).length,
        budgetExceeded: all.filter((sample) => sample.budgetExceeded).length,
        cacheHits: all.filter((sample) => sample.cacheHit).length,
        latencyMs: latencyStats(network)
    };
}
