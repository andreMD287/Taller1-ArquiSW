/**
 * frontend/tests/run.js — Punto de entrada de las pruebas por línea de comandos.
 *
 * La forma de referencia para ejecutarlas es el NAVEGADOR: sirviendo el
 * repositorio por HTTP (por ejemplo `python3 -m http.server 8123`) y abriendo
 * /frontend/tests/index.html. Ver la cabecera de harness.js.
 *
 * Este archivo sirve para ejecutarlas desde consola:
 *
 *   node frontend/tests/run.js     (Node 18+, solo si está instalado)
 *
 * Opcionalmente, si se dispone del binario `jsc` de JavaScriptCore —que NO
 * viene garantizado con macOS y no fue el mecanismo de verificación final—
 * también acepta `jsc -m frontend/tests/run.js`.
 */

import { run } from "./harness.js";
import "./platform.test.js";
import "./session.test.js";
import "./crud.test.js";

// Algunos motores mínimos exponen print() y no console.log; navegador y Node,
// al revés. Se elige el que exista.
const log = typeof console !== "undefined" && console.log
    ? (line) => console.log(line)
    : (line) => print(line);

const result = await run({ log });

if (typeof process !== "undefined" && process.exit) {
    process.exit(result.failed === 0 ? 0 : 1);
}
