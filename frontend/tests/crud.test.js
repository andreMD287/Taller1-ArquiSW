/**
 * frontend/tests/crud.test.js — Pruebas del motor CRUD genérico.
 *
 * El descriptor usado aquí es NEUTRAL a propósito: "records" / "/api/records".
 * No es un recurso real del sistema, y esa es justamente la prueba de que el
 * motor no sabe nada de productos ni de usuarios.
 *
 * El transporte no se sustituye: se sustituye `globalThis.fetch`, así que las
 * peticiones recorren de verdad `platform/http.js`. Si el motor intentara hablar
 * con la red por otro camino, estas pruebas no lo verían — por eso además hay
 * comprobaciones estáticas de que `crud/**` no importa recursos ni llama a
 * `fetch()`.
 */

import { test, assert, assertEqual, assertRejects, installFetch, jsonResponse,
         makeResponse, errorResponse, deferred, tick } from "./harness.js";
import * as metrics from "../src/platform/metrics.js";
import { CATEGORY } from "../src/platform/errors.js";
import { configureAuthProvider, configureHttp, resetHttpConfig } from "../src/platform/http.js";
import { mount, validateDescriptor, CrudError, DEFAULT_PAGE_SIZE } from "../src/crud/engine.js";

const HAS_DOM = typeof document !== "undefined" && typeof document.createElement === "function";

/* --------------------------- descriptor neutral -------------------------- */

function descriptor(overrides = {}) {
    return {
        key: "records",
        label: "Registros",
        singularLabel: "Registro",
        path: "/api/records",
        idField: "id",
        search: { field: "title", queryParam: "name", placeholder: "Buscar" },
        defaultSort: { field: "title", direction: "asc" },
        permits: { read: "AUTHENTICATED", write: "ADMIN" },
        danger: { delete: "confirm" },
        fields: [
            { name: "id", label: "ID", type: "integer", readOnly: true, inList: false, align: "right" },
            { name: "title", label: "Título", type: "text", required: true, maxLength: 100,
              inList: true, sortable: true, align: "left" },
            { name: "amount", label: "Importe", type: "decimal", required: true,
              inList: true, sortable: false, align: "right" },
            { name: "count", label: "Cantidad", type: "integer", required: true,
              inList: true, align: "right" },
            { name: "enabled", label: "Activo", type: "boolean", inList: true, align: "center" },
            { name: "createdAt", label: "Creado", type: "datetime", readOnly: true,
              inList: true, sortable: true, align: "right" }
        ],
        ...overrides
    };
}

function record(id, overrides = {}) {
    return {
        id,
        title: "Elemento " + id,
        amount: 19.5,
        count: 3,
        enabled: true,
        createdAt: "2026-08-21T10:00:00Z",
        ...overrides
    };
}

function page(content, overrides = {}) {
    return {
        content,
        page: 0,
        size: 20,
        totalElements: content.length,
        totalPages: content.length === 0 ? 0 : 1,
        last: true,
        ...overrides
    };
}

let host = null;

function fresh() {
    metrics.reset();
    configureAuthProvider(null);
    resetHttpConfig();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = document.createElement("div");
    document.body.appendChild(host);
    return host;
}

/** Extrae los parámetros de la última URL pedida. */
function queryOf(call) {
    const at = call.url.indexOf("?");
    if (at < 0) return {};
    const result = {};
    for (const pair of call.url.slice(at + 1).split("&")) {
        const [key, value] = pair.split("=");
        result[decodeURIComponent(key)] = decodeURIComponent(value || "");
    }
    return result;
}

if (!HAS_DOM) {
    test("crud: suite omitida (este entorno no tiene DOM; ejecútala en navegador)", () => {
        assert(true, "el arnés de referencia es el navegador");
    });
}

if (HAS_DOM) {

/* ==================== Descriptor y separación de capas =================== */

test("crud 1: un descriptor válido monta sin conocer recursos reales", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        assertEqual(engine.descriptor.key, "records", "el motor solo conoce lo que le pasaron");
        assertEqual(engine.getState().content.length, 1, "cargó la primera página");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 2: un descriptor inválido falla antes de tocar la red", () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([])));
    try {
        for (const [caso, roto] of [
            ["sin descriptor", null],
            ["sin key", descriptor({ key: "" })],
            ["sin label", descriptor({ label: "" })],
            ["sin singularLabel", descriptor({ singularLabel: "" })],
            ["sin path", descriptor({ path: "" })],
            ["path absoluto", descriptor({ path: "api/records" })],
            ["fields vacío", descriptor({ fields: [] })],
            ["idField inexistente", descriptor({ idField: "noExiste" })]
        ]) {
            let lanzo = false;
            try { mount(host, roto); } catch (error) {
                lanzo = error instanceof CrudError;
            }
            assert(lanzo, caso + ": debe lanzar CrudError");
        }
        assertEqual(net.calls.length, 0, "ninguna petición: el fallo es local y previo");
        assertEqual(metrics.getSamples().length, 0, "y no genera métricas de red");
    } finally { net.restore(); }
});

test("crud 3: los campos duplicados se rechazan", () => {
    const dup = descriptor();
    dup.fields = dup.fields.concat([{ name: "title", label: "Otro", type: "text" }]);
    let mensaje = "";
    try { validateDescriptor(dup); } catch (error) { mensaje = error.message; }
    assert(mensaje.indexOf("duplicado") >= 0, "menciona la duplicación: " + mensaje);
});

test("crud 4: un tipo no soportado se rechaza", () => {
    const malo = descriptor();
    malo.fields = malo.fields.concat([{ name: "raro", label: "Raro", type: "json" }]);
    let mensaje = "";
    try { validateDescriptor(malo); } catch (error) { mensaje = error.message; }
    assert(mensaje.indexOf("Tipo no soportado") >= 0 || mensaje.indexOf("tipo no soportado") >= 0,
        "menciona el tipo: " + mensaje);
});

test("crud 5: solo se puede ordenar por campos sortable:true", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        let lanzo = false;
        try { engine.setSort("amount"); } catch (error) { lanzo = error instanceof CrudError; }
        assert(lanzo, "amount no es sortable: debe rechazarse");
        lanzo = false;
        try { engine.setSort("campoInventado"); } catch (error) { lanzo = error instanceof CrudError; }
        assert(lanzo, "un valor arbitrario de UI nunca llega al parámetro sort");

        await engine.setSort("title");
        const q = queryOf(net.calls[net.calls.length - 1]);
        assertEqual(q.sort, "title,desc", "sí ordena por un campo declarado");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 6 y 7: crud/** no importa resources/** ni llama a fetch()", async () => {
    const fuentes = ["engine.js", "table.js", "form.js", "pager.js"];
    for (const archivo of fuentes) {
        const texto = await (await fetch("../src/crud/" + archivo)).text();
        const imports = texto.split("\n").filter((line) => line.trim().startsWith("import "));
        for (const linea of imports) {
            assert(linea.indexOf("resources/") === -1, archivo + " importa recursos: " + linea);
            assert(linea.indexOf("session.js") === -1, archivo + " importa sesión: " + linea);
            assert(linea.indexOf("config.js") === -1, archivo + " importa configuración: " + linea);
        }
        // `fetch(` solo puede aparecer si NO es una llamada real; en crud/ no hay ninguna.
        const sinComentarios = texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        assert(sinComentarios.indexOf("fetch(") === -1, archivo + " llama a fetch() directamente");
    }
});

/* ================================ Listado =============================== */

test("crud 8 y 9: consume PageResponse y construye el query genérico", async () => {
    fresh();
    // Página INTERMEDIA: con size 5 y 12 elementos, la página 1 va llena. Un
    // fixture con menos describiría una respuesta que el backend no puede emitir.
    const net = installFetch(() => jsonResponse(200, {
        content: [record(1), record(2), record(3), record(4), record(5)],
        page: 1, size: 5, totalElements: 12, totalPages: 3, last: false
    }));
    try {
        const engine = mount(host, descriptor(), { pageSize: 5 });
        await engine.ready;
        await engine.setSearch("hola");
        await engine.load(1);

        const q = queryOf(net.calls[net.calls.length - 1]);
        assertEqual(q.page, "1", "página");
        assertEqual(q.size, "5", "tamaño");
        assertEqual(q.sort, "title,asc", "orden por defecto");
        assertEqual(q.name, "hola", "búsqueda bajo el queryParam del descriptor");

        const estado = engine.getState();
        assertEqual(estado.totalElements, 12, "totalElements del contrato");
        assertEqual(estado.totalPages, 3, "totalPages del contrato");
        assertEqual(estado.last, false, "last del contrato");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 10: una búsqueda vacía no se envía", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        await engine.setSearch("   ");
        const q = queryOf(net.calls[net.calls.length - 1]);
        assertEqual(q.name, undefined, "sin filtro no es lo mismo que filtrar por vacío");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 11: una página estructuralmente inválida produce error local", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, { contenido: "otra forma", page: "x" }));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const estado = engine.getState();
        assertEqual(estado.error.category, CATEGORY.CLIENT, "error local, no de red");
        assertEqual(estado.content.length, 0, "no inventa contenido");
        assertEqual(estado.totalElements, 0, "ni totales");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 12 a 15: estados vacío, página única, intermedia y última", async () => {
    fresh();
    let respuesta = page([]);
    const net = installFetch(() => jsonResponse(200, respuesta));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        assert(host.textContent.indexOf("No hay elementos") >= 0, "estado vacío visible");
        assert(host.textContent.indexOf("Sin elementos") >= 0, "paginador sin elementos");

        respuesta = page([record(1)]);
        await engine.reload();
        assert(host.textContent.indexOf("Página 1 de 1") >= 0, "página única");
        const anterior = host.querySelector(".crud-pager__previous");
        const siguiente = host.querySelector(".crud-pager__next");
        assertEqual(anterior.disabled, true, "anterior deshabilitado en la primera");
        assertEqual(siguiente.disabled, true, "siguiente deshabilitado si es la última");

        respuesta = { content: [record(2)], page: 1, size: 1, totalElements: 3, totalPages: 3, last: false };
        await engine.load(1);
        assertEqual(host.querySelector(".crud-pager__previous").disabled, false, "intermedia: anterior activo");
        assertEqual(host.querySelector(".crud-pager__next").disabled, false, "intermedia: siguiente activo");

        respuesta = { content: [record(3)], page: 2, size: 1, totalElements: 3, totalPages: 3, last: true };
        await engine.load(2);
        assertEqual(host.querySelector(".crud-pager__next").disabled, true, "última: siguiente deshabilitado");
        engine.destroy();
    } finally { net.restore(); }
});

/* ======================= Respuestas fuera de orden ====================== */

test("crud 16: una búsqueda vieja que responde después no pisa la nueva", async () => {
    fresh();
    const vieja = deferred();
    const nueva = deferred();
    let llamada = 0;
    const net = installFetch(() => {
        llamada += 1;
        if (llamada === 1) return jsonResponse(200, page([record(0)]));
        return llamada === 2 ? vieja.promise : nueva.promise;
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;

        const busquedaVieja = engine.setSearch("vieja");
        const busquedaNueva = engine.setSearch("nueva");
        await tick(2);

        nueva.resolve(jsonResponse(200, page([record(99, { title: "resultado NUEVO" })])));
        await busquedaNueva;
        vieja.resolve(jsonResponse(200, page([record(11), record(12), record(13)])));
        await busquedaVieja;
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.content.length, 1, "la respuesta vieja no reemplazó el contenido");
        assertEqual(estado.content[0].title, "resultado NUEVO", "gana la búsqueda más reciente");
        assert(host.textContent.indexOf("resultado NUEVO") >= 0, "y tampoco pintó la vieja");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 17: un error viejo no pisa un resultado nuevo", async () => {
    fresh();
    const vieja = deferred();
    const nueva = deferred();
    let llamada = 0;
    const net = installFetch(() => {
        llamada += 1;
        if (llamada === 1) return jsonResponse(200, page([record(0)]));
        return llamada === 2 ? vieja.promise : nueva.promise;
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const primera = engine.setSearch("a");
        const segunda = engine.setSearch("b");
        await tick(2);

        nueva.resolve(jsonResponse(200, page([record(7)])));
        await segunda;
        vieja.resolve(errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-viejo" }));
        await primera;
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.error, null, "el error viejo no se aplica");
        assertEqual(estado.content[0].id, 7, "el resultado nuevo sobrevive");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 18: una respuesta posterior a destroy() no pinta ni cambia estado", async () => {
    fresh();
    const pendiente = deferred();
    let llamada = 0;
    const net = installFetch(() => (llamada++ === 0 ? jsonResponse(200, page([record(1)])) : pendiente.promise));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const carga = engine.reload();
        await tick(2);
        engine.destroy();

        pendiente.resolve(jsonResponse(200, page([record(42, { title: "tardío" })])));
        await carga;
        await tick(3);

        assertEqual(engine.getState().content.some((r) => r.title === "tardío"), false,
            "el estado no se tocó");
        assertEqual(host.textContent.indexOf("tardío"), -1, "y no pintó nada");
        assertEqual(host.querySelector(".crud"), null, "el contenedor quedó limpio");
    } finally { net.restore(); }
});

/* ================================= Tabla ================================ */

test("crud 19 a 21: solo campos inList, cinco tipos formateados y alineación", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([
        record(1, { title: "Uno", amount: 1234.5, count: 7, enabled: false,
                    createdAt: "2026-08-21T10:00:00Z" })
    ])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;

        const cabeceras = [...host.querySelectorAll(".crud-table__header")].map((th) => th.textContent);
        assertEqual(cabeceras.indexOf("ID"), -1, "el campo inList:false no se muestra");
        assert(cabeceras.indexOf("Título") >= 0, "los inList:true sí");

        const celdas = [...host.querySelectorAll(".crud-table__row .crud-table__cell")];
        assertEqual(celdas[0].textContent, "Uno", "text");
        assert(celdas[1].textContent.indexOf("1") === 0, "decimal formateado: " + celdas[1].textContent);
        assert(celdas[1].textContent.length >= 4, "decimal con separadores/decimales");
        assertEqual(celdas[2].textContent, "7", "integer");
        assertEqual(celdas[3].textContent, "No", "boolean");
        assert(celdas[4].textContent.length > 0 && celdas[4].textContent !== "—", "datetime formateado");

        assert(celdas[1].className.indexOf("crud-cell--right") >= 0, "alineación derecha declarada");
        assert(celdas[3].className.indexOf("crud-cell--center") >= 0, "alineación centro declarada");
        assert(celdas[0].className.indexOf("crud-cell--left") >= 0, "alineación izquierda declarada");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 22: el contenido del backend nunca se interpreta como HTML", async () => {
    fresh();
    const veneno = '<img src=x onerror="window.__crudXss = true">';
    const net = installFetch(() => jsonResponse(200, page([record(1, { title: veneno })])));
    try {
        delete globalThis.__crudXss;
        const engine = mount(host, descriptor());
        await engine.ready;
        const celda = host.querySelector(".crud-table__row .crud-table__cell");
        assertEqual(celda.textContent, veneno, "se muestra como texto literal");
        assertEqual(celda.querySelector("img"), null, "no se creó ningún elemento");
        assertEqual(globalThis.__crudXss, undefined, "y no se ejecutó nada");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 23: solo las columnas declaradas ofrecen ordenamiento", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const ordenables = [...host.querySelectorAll(".crud-table__sort")].map((b) => b.dataset.field);
        assertEqual(ordenables.join(","), "title,createdAt", "solo los sortable:true");
        assertEqual(ordenables.indexOf("amount"), -1, "amount no ofrece orden");
        engine.destroy();
    } finally { net.restore(); }
});

/* =============================== Formulario ============================= */

test("crud 24 y 25: omite readOnly y crea un input por tipo", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        engine.openForm(null);

        assertEqual(host.querySelector('[name="id"]'), null, "id es readOnly: no se edita");
        assertEqual(host.querySelector('[name="createdAt"]'), null, "createdAt es readOnly");
        assertEqual(host.querySelector('[name="title"]').type, "text", "text");
        assertEqual(host.querySelector('[name="amount"]').type, "number", "decimal -> number");
        assertEqual(host.querySelector('[name="amount"]').step, "any", "decimal admite fracciones");
        assertEqual(host.querySelector('[name="count"]').step, "1", "integer entero");
        assertEqual(host.querySelector('[name="enabled"]').type, "checkbox", "boolean");
        const etiqueta = host.querySelector('label[for="' + host.querySelector('[name="title"]').id + '"]');
        assert(etiqueta !== null, "cada label está asociada a su input");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 26 y 27: valida solo required, maxLength y tipo; nunca reglas de negocio", async () => {
    fresh();
    let enviados = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") { enviados += 1; return jsonResponse(201, record(9)); }
        return jsonResponse(200, page([]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        engine.openForm(null);

        // required: título vacío
        host.querySelector('[name="amount"]').value = "5";
        host.querySelector('[name="count"]').value = "1";
        await engine.submitForm();
        assertEqual(enviados, 0, "no envía con un obligatorio vacío");
        assert(host.textContent.indexOf("obligatorio") >= 0, "lo dice");

        // tipo: número no interpretable
        host.querySelector('[name="title"]').value = "ok";
        host.querySelector('[name="amount"]').value = "no-es-numero";
        await engine.submitForm();
        assertEqual(enviados, 0, "no envía con un número inválido");

        // maxLength estructural
        host.querySelector('[name="amount"]').value = "5";
        host.querySelector('[name="title"]').value = "x".repeat(101);
        await engine.submitForm();
        assertEqual(enviados, 0, "no envía si excede maxLength");

        // REGLAS DE NEGOCIO: -5 y 0 son números válidos. El cliente NO los juzga.
        host.querySelector('[name="title"]').value = "ok";
        host.querySelector('[name="amount"]').value = "-5";
        host.querySelector('[name="count"]').value = "0";
        await engine.submitForm();
        assertEqual(enviados, 1, "un negativo es estructuralmente válido: se envía y decide el backend");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 28 a 31: muestra todas las violaciones, las generales, sin ramificar por rule, y limpia", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (init.method === "POST") {
            return jsonResponse(422, {
                code: "business_rule_violation", kind: "EXPECTED",
                message: "La operacion incumple una o mas reglas de negocio",
                retryable: false, requestId: "req-422",
                violations: [
                    { rule: "amount.rule-one", field: "amount", message: "Primer motivo" },
                    { rule: "amount.rule-two", field: "amount", message: "Segundo motivo" },
                    { rule: "global.rule", field: null, message: "Motivo general" }
                ]
            }, { "X-Request-Id": "req-422" });
        }
        return jsonResponse(200, page([]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        engine.openForm(null);
        host.querySelector('[name="title"]').value = "ok";
        host.querySelector('[name="amount"]').value = "1";
        host.querySelector('[name="count"]').value = "1";
        await engine.submitForm();
        await tick(2);

        const errores = [...host.querySelectorAll(".crud-form__error")].map((li) => li.textContent);
        assertEqual(errores.length, 2, "las DOS violaciones del campo, no solo la primera");
        assertEqual(errores.join("|"), "Primer motivo|Segundo motivo", "con el mensaje del backend");

        const generales = [...host.querySelectorAll(".crud-form__general-error")].map((p) => p.textContent);
        assertEqual(generales.join("|"), "Motivo general", "las violaciones sin campo no se pierden");

        const input = host.querySelector('[name="amount"]');
        assertEqual(input.getAttribute("aria-invalid"), "true", "el input se marca inválido");
        assert(input.getAttribute("aria-describedby") !== null, "y se conecta con sus mensajes");

        // `rule` se conserva como dato, no como rama de decisión.
        const conRegla = host.querySelector('.crud-form__error[data-rule="amount.rule-one"]');
        assert(conRegla !== null, "rule queda disponible para diagnóstico");
        assertEqual(host.querySelector(".crud-form__general-errors").dataset.requestId, "req-422",
            "el requestId queda disponible");

        // Limpieza antes de una nueva presentación.
        engine.closeForm();
        assertEqual(host.querySelectorAll(".crud-form__error").length, 0, "limpia los errores anteriores");
        assertEqual(host.querySelector('[name="amount"]').getAttribute("aria-invalid"), null, "y el marcado");
        engine.destroy();
    } finally { net.restore(); }
});

/* =============================== Mutaciones ============================= */

test("crud 32: el POST integra el cuerpo del 201 sin pedir la lista otra vez", async () => {
    fresh();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(50, { title: "Creado" }));
        gets += 1;
        return jsonResponse(200, page([record(1)]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        assertEqual(gets, 1, "solo la carga inicial");

        const creado = await engine.create({ title: "Creado", amount: 1, count: 1, enabled: true });
        assertEqual(creado.id, 50, "devuelve el recurso del 201");
        assertEqual(gets, 1, "NO vuelve a pedir la lista");
        const estado = engine.getState();
        assertEqual(estado.content.length, 2, "se integró en la lista");
        assertEqual(estado.content[1].title, "Creado", "usando el cuerpo de la respuesta");
        assertEqual(estado.totalElements, 2, "y los contadores son coherentes");

        // No duplica si ya estaba presente.
        await engine.create({ title: "Creado" });
        assertEqual(engine.getState().content.length, 2, "no duplica un elemento ya presente");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 33: el PUT sustituye con el cuerpo completo de la respuesta", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (init.method === "PUT") {
            return jsonResponse(200, record(1, { title: "Renombrado", amount: 99, count: 9 }));
        }
        return jsonResponse(200, page([record(1), record(2)]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        await engine.update(1, { title: "Renombrado" });
        const estado = engine.getState();
        assertEqual(estado.content[0].title, "Renombrado", "sustituido");
        assertEqual(estado.content[0].amount, 99, "con la representación FINAL del backend");
        assertEqual(estado.content[0].id, 1, "mismo id");
        assertEqual(estado.content[1].id, 2, "y se conserva el orden");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 34 y 36: DELETE 204 retira localmente sin parsear, con el id codificado", async () => {
    fresh();
    let leyoCuerpo = 0;
    const net = installFetch((url, init) => {
        if (init.method === "DELETE") {
            const respuesta = makeResponse({ status: 204, body: "" });
            const original = respuesta.text;
            respuesta.text = async () => { leyoCuerpo += 1; return original(); };
            return respuesta;
        }
        return jsonResponse(200, page([record("a/b c"), record(2)]));
    });
    try {
        const engine = mount(host, descriptor(), { confirm: () => true });
        await engine.ready;
        await engine.remove("a/b c");

        const borrado = net.calls.find((c) => c.init.method === "DELETE");
        assert(borrado.url.indexOf("/api/records/a%2Fb%20c") >= 0,
            "el id se codifica en la ruta: " + borrado.url);
        assertEqual(leyoCuerpo, 0, "un 204 no se parsea");
        const estado = engine.getState();
        assertEqual(estado.content.length, 1, "retirado localmente");
        assertEqual(estado.totalElements, 1, "totalElements actualizado");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 35: eliminar el último elemento de una página posterior carga la anterior", async () => {
    fresh();
    const paginas = {
        0: { content: [record(1), record(2)], page: 0, size: 2, totalElements: 3, totalPages: 2, last: false },
        1: { content: [record(3)], page: 1, size: 2, totalElements: 3, totalPages: 2, last: true }
    };
    const net = installFetch((url, init) => {
        if (init.method === "DELETE") return makeResponse({ status: 204, body: "" });
        const q = queryOf({ url });
        return jsonResponse(200, paginas[q.page] || paginas[0]);
    });
    try {
        const engine = mount(host, descriptor(), { pageSize: 2, confirm: () => true });
        await engine.ready;
        await engine.load(1);
        assertEqual(engine.getState().page, 1, "estamos en la segunda página");

        await engine.remove(3);
        await tick(3);
        assertEqual(engine.getState().page, 0, "al vaciarse, retrocede a la anterior");
        assertEqual(engine.getState().content.length, 2, "y trae su contenido");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 37 y 38: una mutación fallida conserva el estado, y el doble submit se bloquea", async () => {
    fresh();
    const puerta = deferred();
    let posts = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") { posts += 1; return puerta.promise; }
        return jsonResponse(200, page([record(1)]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const antes = engine.getState();

        engine.openForm(null);
        host.querySelector('[name="title"]').value = "ok";
        host.querySelector('[name="amount"]').value = "1";
        host.querySelector('[name="count"]').value = "1";

        const primero = engine.submitForm();
        await tick(2);
        const segundo = engine.submitForm();      // doble submit
        await tick(2);
        assertEqual(posts, 1, "el segundo envío queda bloqueado mientras el primero está en vuelo");
        assertEqual(host.querySelector(".crud-form__submit").disabled, true, "y el botón se deshabilita");

        puerta.resolve(errorResponse(409, { code: "conflict", requestId: "req-409" }));
        await primero; await segundo;
        await tick(2);

        const despues = engine.getState();
        assertEqual(despues.content.length, antes.content.length, "el listado no se alteró");
        assertEqual(despues.error.category, CATEGORY.CONFLICT, "pero el error se registra");
        assertEqual(host.querySelector(".crud-form__submit").disabled, false, "y el formulario se libera");
        engine.destroy();
    } finally { net.restore(); }
});

/* =========================== Permisos y errores ========================== */

test("crud 39: sin permiso de lectura no se hace la petición", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor(), { can: () => false });
        await engine.ready;
        assertEqual(net.calls.length, 0, "ninguna petición");
        assertEqual(engine.getState().error.category, CATEGORY.FORBIDDEN, "estado restringido");
        assert(host.textContent.indexOf("permiso") >= 0, "y se explica");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 40: sin permiso de escritura no se ofrecen mutaciones", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        // Capacidades declarativas: el motor no sabe qué es "ADMIN", solo pregunta.
        const engine = mount(host, descriptor(), { can: (cap) => cap === "AUTHENTICATED" });
        await engine.ready;
        assertEqual(host.querySelector(".crud__create").hidden, true, "sin botón de crear");
        assertEqual(host.querySelector(".crud-table__action--edit"), null, "sin editar");
        assertEqual(host.querySelector(".crud-table__action--delete"), null, "sin eliminar");
        assertEqual(await engine.create({ title: "x" }), null, "y la mutación no se ejecuta");
        assertEqual(net.calls.length, 1, "solo la carga inicial");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 41: un 403 del backend sigue siendo manejable aunque la UI oculte la acción", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (init.method === "POST") {
            return makeResponse({ status: 403, body: "", headers: { "X-Request-Id": "req-403" } });
        }
        return jsonResponse(200, page([record(1)]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        await engine.create({ title: "x", amount: 1, count: 1 });
        const estado = engine.getState();
        assertEqual(estado.error.category, CATEGORY.FORBIDDEN, "se maneja el 403");
        assertEqual(estado.error.requestId, "req-403", "con su requestId de cabecera");
        assertEqual(estado.content.length, 1, "sin pantalla en blanco");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 42 a 44: 503, timeout y red conservan estado, ofrecen reintento y muestran requestId", async () => {
    fresh();
    let modo = "ok";
    const net = installFetch(() => {
        if (modo === "ok") return jsonResponse(200, page([record(1)]));
        if (modo === "503") return errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-503" });
        throw new TypeError("Failed to fetch");
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;

        modo = "503";
        await engine.reload();
        let estado = engine.getState();
        assertEqual(estado.error.category, CATEGORY.UNAVAILABLE, "503 clasificado");
        assertEqual(estado.content.length, 1, "conserva el último contenido utilizable");
        assertEqual(host.querySelector(".crud__retry").hidden, false, "ofrece reintento MANUAL");
        assertEqual(host.querySelector(".crud__status").dataset.requestId, "req-503", "muestra el requestId");

        modo = "red";
        await engine.reload();
        estado = engine.getState();
        assertEqual(estado.error.category, CATEGORY.NETWORK, "red clasificada");
        assertEqual(estado.content.length, 1, "sin pantalla en blanco");

        modo = "ok";
        host.querySelector(".crud__retry").click();
        await tick(4);
        assertEqual(engine.getState().error, null, "el reintento manual recupera");
        engine.destroy();
    } finally { net.restore(); }
});

/* =============================== Ciclo de vida ========================== */

test("crud 45: dos motores montados mantienen estados independientes", async () => {
    fresh();
    const otro = document.createElement("div");
    document.body.appendChild(otro);
    const net = installFetch((url) => {
        const q = queryOf({ url });
        return jsonResponse(200, page([record(q.name === "solo-b" ? 2 : 1)]));
    });
    try {
        const a = mount(host, descriptor());
        const b = mount(otro, descriptor());
        await a.ready;
        await b.ready;
        await b.setSearch("solo-b");

        assertEqual(a.getState().search, "", "la instancia A no se enteró");
        assertEqual(b.getState().search, "solo-b", "la B sí");
        assertEqual(a.getState().content[0].id, 1, "contenidos independientes");
        assertEqual(b.getState().content[0].id, 2, "sin estado global compartido");
        a.destroy(); b.destroy();
        otro.remove();
    } finally { net.restore(); }
});

test("crud 46 y 47: destroy() retira listeners y no deja actualizaciones tardías", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const crear = host.querySelector(".crud__create");
        engine.destroy();

        const antes = net.calls.length;
        crear.click();               // el nodo ya no está en el documento
        await tick(3);
        assertEqual(net.calls.length, antes, "ningún listener sigue provocando peticiones");
        assertEqual(host.querySelector(".crud"), null, "el contenedor quedó limpio");
        assertEqual(engine.getState().destroyed, true, "la instancia se marca destruida");
    } finally { net.restore(); }
});

test("crud 48: getState() no permite mutar el estado interno", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const estado = engine.getState();
        estado.content.push(record(999));
        estado.content[0].title = "MUTADO";
        estado.page = 42;
        if (estado.sort) estado.sort.field = "inventado";

        const real = engine.getState();
        assertEqual(real.content.length, 1, "el arreglo interno no cambió");
        assertEqual(real.content[0].title, "Elemento 1", "ni los elementos");
        assertEqual(real.page, 0, "ni los escalares");
        assertEqual(real.sort.field, "title", "ni el orden");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud extra: el tamaño de página entra por opción, con defecto documentado", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([])));
    try {
        const porDefecto = mount(host, descriptor());
        await porDefecto.ready;
        assertEqual(queryOf(net.calls[0]).size, String(DEFAULT_PAGE_SIZE), "defecto documentado");
        porDefecto.destroy();

        const otro = document.createElement("div");
        document.body.appendChild(otro);
        const inyectado = mount(otro, descriptor(), { pageSize: 7 });
        await inyectado.ready;
        assertEqual(queryOf(net.calls[net.calls.length - 1]).size, "7", "la composición lo entrega");
        inyectado.destroy();
        otro.remove();
    } finally { net.restore(); }
});

/* ==================== Validación completa del descriptor ================ */

test("crud 49: search, permisos, maxLength y columnas visibles se validan", () => {
    fresh();
    const casos = [
        ["search.field inexistente", descriptor({ search: { field: "noExiste", queryParam: "name" } })],
        ["search sin field", descriptor({ search: { queryParam: "name" } })],
        ["search sin queryParam", descriptor({ search: { field: "title" } })],
        ["placeholder no string", descriptor({ search: { field: "title", queryParam: "name", placeholder: 7 } })],
        ["permits.read vacío", descriptor({ permits: { read: "", write: "ADMIN" } })],
        ["permits.write vacío", descriptor({ permits: { read: "A", write: "   " } })],
        ["permits no objeto", descriptor({ permits: "ADMIN" })],
        ["danger.delete desconocido", descriptor({ danger: { delete: "quizá" } })]
    ];
    for (const [caso, roto] of casos) {
        let lanzo = false;
        try { validateDescriptor(roto); } catch (error) { lanzo = error instanceof CrudError; }
        assert(lanzo, caso + ": debe lanzar CrudError");
    }
});

test("crud 50: maxLength inválido o mal aplicado se rechaza", () => {
    const conMaxLengthCero = descriptor();
    conMaxLengthCero.fields = conMaxLengthCero.fields.map((f) =>
        f.name === "title" ? { ...f, maxLength: 0 } : f);
    const conMaxLengthDecimal = descriptor();
    conMaxLengthDecimal.fields = conMaxLengthDecimal.fields.map((f) =>
        f.name === "title" ? { ...f, maxLength: 10.5 } : f);
    const maxLengthEnNumero = descriptor();
    maxLengthEnNumero.fields = maxLengthEnNumero.fields.map((f) =>
        f.name === "amount" ? { ...f, maxLength: 5 } : f);
    const banderaNoBooleana = descriptor();
    banderaNoBooleana.fields = banderaNoBooleana.fields.map((f) =>
        f.name === "title" ? { ...f, required: "sí" } : f);

    for (const [caso, roto] of [
        ["maxLength cero", conMaxLengthCero],
        ["maxLength decimal", conMaxLengthDecimal],
        ["maxLength en un número", maxLengthEnNumero],
        ["required no booleano", banderaNoBooleana]
    ]) {
        let lanzo = false;
        try { validateDescriptor(roto); } catch (error) { lanzo = error instanceof CrudError; }
        assert(lanzo, caso + ": debe lanzar CrudError");
    }
});

test("crud 51: un descriptor sin columnas visibles se rechaza", () => {
    const sinColumnas = descriptor();
    sinColumnas.fields = sinColumnas.fields.map((f) => ({ ...f, inList: false }));
    let mensaje = "";
    try { validateDescriptor(sinColumnas); } catch (error) { mensaje = error.message; }
    assert(mensaje.indexOf("inList") >= 0, "lo explica: " + mensaje);

    // El idField SÍ puede ser readOnly: eso es lo normal y debe seguir valiendo.
    assert(validateDescriptor(descriptor()) !== null, "idField readOnly es válido");
});

/* ================== Coherencia de PageResponse ========================== */

test("crud 52: una página incoherente se rechaza y conserva lo último utilizable", async () => {
    fresh();
    let respuesta = page([record(1)]);
    const net = installFetch(() => jsonResponse(200, respuesta));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        assertEqual(engine.getState().content.length, 1, "hay contenido utilizable");

        const incoherentes = [
            ["página decimal", { content: [], page: 1.5, size: 20, totalElements: 0, totalPages: 0, last: true }],
            ["size cero", { content: [], page: 0, size: 0, totalElements: 0, totalPages: 0, last: true }],
            ["last ausente", { content: [record(2)], page: 0, size: 20, totalElements: 1, totalPages: 1 }],
            ["last contradictorio", { content: [record(2)], page: 0, size: 20, totalElements: 3, totalPages: 3, last: true }],
            ["página fuera de rango", { content: [record(2)], page: 5, size: 20, totalElements: 3, totalPages: 3, last: false }],
            ["content mayor que size", { content: [record(2), record(3)], page: 0, size: 1, totalElements: 2, totalPages: 2, last: false }],
            ["cero páginas con contenido", { content: [record(2)], page: 0, size: 20, totalElements: 0, totalPages: 0, last: true }],
            ["totalElements negativo", { content: [], page: 0, size: 20, totalElements: -1, totalPages: 0, last: true }]
        ];
        for (const [caso, cuerpo] of incoherentes) {
            respuesta = cuerpo;
            await engine.reload();
            const estado = engine.getState();
            assertEqual(estado.error.category, CATEGORY.CLIENT, caso + ": error local");
            assertEqual(estado.content.length, 1, caso + ": conserva el contenido anterior");
            assertEqual(estado.content[0].id, 1, caso + ": el mismo de antes, sin corregir nada");
        }
        engine.destroy();
    } finally { net.restore(); }
});

/* ============ El modelo de error recibido no se muta jamás ============== */

test("crud 53: showViolations no muta el modelo y no duplica en dos presentaciones", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        engine.openForm(null);
        const formulario = host.querySelector(".crud-form");

        // Modelo CONGELADO EN PROFUNDIDAD: cualquier intento de mutarlo lanzaría
        // en modo estricto, y los módulos ES siempre son estrictos.
        const modelo = {
            violationsByField: {
                amount: [{ rule: "r.uno", field: "amount", message: "Motivo A" }],
                campoInvisible: [{ rule: "r.dos", field: "campoInvisible", message: "Motivo oculto" }]
            },
            generalViolations: [{ rule: "r.tres", field: null, message: "Motivo general" }],
            requestId: "req-frozen"
        };
        Object.freeze(modelo);
        Object.freeze(modelo.violationsByField);
        Object.freeze(modelo.generalViolations);
        for (const lista of Object.values(modelo.violationsByField)) {
            Object.freeze(lista);
            lista.forEach(Object.freeze);
        }
        modelo.generalViolations.forEach(Object.freeze);
        const copia = JSON.stringify(modelo);

        // Se presenta dos veces el MISMO modelo.
        engine.showFormViolations(modelo);
        const primera = [...formulario.querySelectorAll(".crud-form__general-error")].map((p) => p.textContent);
        engine.showFormViolations(modelo);
        const segunda = [...formulario.querySelectorAll(".crud-form__general-error")].map((p) => p.textContent);

        assertEqual(JSON.stringify(modelo), copia, "el modelo quedó intacto");
        assertEqual(modelo.generalViolations.length, 1, "no se le acumularon violaciones");
        assertEqual(primera.join("|"), segunda.join("|"), "misma presentación, sin duplicados");
        assertEqual(segunda.length, 2, "la general + la del campo no visible, una sola vez");
        engine.destroy();
    } finally { net.restore(); }
});

/* ============ destroy() retira de verdad todas las interacciones ======== */

test("crud 54: tras destroy(), ningún botón guardado dispara callbacks", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor(), { confirm: () => true });
        await engine.ready;
        engine.openForm(null);

        // Referencias guardadas ANTES de destruir.
        const ordenar = host.querySelector(".crud-table__sort");
        const editar = host.querySelector(".crud-table__action--edit");
        const eliminar = host.querySelector(".crud-table__action--delete");
        const anterior = host.querySelector(".crud-pager__previous");
        const siguiente = host.querySelector(".crud-pager__next");
        const enviar = host.querySelector(".crud-form__submit");
        const cancelar = host.querySelector(".crud-form__cancel");

        engine.destroy();
        engine.destroy();                    // idempotente: no debe lanzar
        const llamadasAntes = net.calls.length;
        const estadoAntes = JSON.stringify(engine.getState());

        for (const boton of [ordenar, editar, eliminar, anterior, siguiente, enviar, cancelar]) {
            assert(boton !== null, "la referencia existía antes de destruir");
            boton.click();
        }
        await tick(4);

        assertEqual(net.calls.length, llamadasAntes, "ningún callback llegó a la red");
        assertEqual(JSON.stringify(engine.getState()), estadoAntes, "ni tocó el estado");
        assertEqual(engine.getState().loading, false, "loading queda en false al destruir");
    } finally { net.restore(); }
});

/* ========== Respuesta realmente pendiente en el momento de destruir ===== */

test("crud 55: una respuesta que llega después de destroy() no repinta ni cambia estado", async () => {
    fresh();
    const pendiente = deferred();
    const net = installFetch(() => pendiente.promise);
    try {
        const engine = mount(host, descriptor());   // el GET queda EN VUELO
        await tick(2);
        const nodosAntes = host.querySelectorAll("*").length;

        engine.destroy();                            // se destruye ANTES de resolver
        const estadoAntes = JSON.stringify(engine.getState());

        pendiente.resolve(jsonResponse(200, page([record(77, { title: "tardío" })])));
        await engine.ready;
        await tick(4);

        assertEqual(JSON.stringify(engine.getState()), estadoAntes, "el estado no cambió");
        assertEqual(engine.getState().content.length, 0, "sin contenido tardío");
        assertEqual(engine.getState().destroyed, true, "sigue destruido");
        assertEqual(engine.getState().loading, false, "y no quedó una carga eternamente activa");
        assertEqual(engine.getState().error, null, "sin errores tardíos");
        assertEqual(host.textContent.indexOf("tardío"), -1, "no repintó");
        assert(host.querySelectorAll("*").length <= nodosAntes, "no reinsertó nodos");
    } finally { net.restore(); }
});

test("crud 56: un rechazo tardío tras destroy() tampoco modifica el estado", async () => {
    fresh();
    const pendiente = deferred();
    const net = installFetch(() => pendiente.promise);
    try {
        const engine = mount(host, descriptor());
        await tick(2);
        engine.destroy();
        const estadoAntes = JSON.stringify(engine.getState());

        pendiente.resolve(errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-tardio" }));
        await engine.ready;
        await tick(4);

        assertEqual(JSON.stringify(engine.getState()), estadoAntes, "estado intacto");
        assertEqual(engine.getState().error, null, "el error tardío no se aplica");
        assertEqual(engine.getState().loading, false, "loading en false");
    } finally { net.restore(); }
});

/* ============================ Timeout REAL ============================== */

test("crud 57: un timeout real recorre AbortController y no deja pantalla en blanco", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (net.calls.length === 1) return jsonResponse(200, page([record(1)]));
        // No resuelve nunca: solo termina cuando el AbortController del cliente
        // aborta. Es el camino real de transporte, no un error fabricado.
        return new Promise((_resolve, reject) => {
            const signal = init && init.signal;
            if (!signal) return;
            signal.addEventListener("abort", () => {
                const error = new Error("The operation was aborted.");
                error.name = "AbortError";
                reject(error);
            });
        });
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        assertEqual(engine.getState().content.length, 1, "hay contenido previo");

        metrics.reset();
        configureHttp({ timeoutMs: 40 });          // seam existente de http.js
        await engine.reload();

        const estado = engine.getState();
        assertEqual(estado.error.category, CATEGORY.TIMEOUT, "categoría timeout REAL");
        assertEqual(estado.content.length, 1, "conserva el contenido anterior");
        assert(host.textContent.indexOf("Elemento 1") >= 0, "sin pantalla en blanco");
        assertEqual(host.querySelector(".crud__retry").hidden, false, "ofrece reintento manual");

        const muestras = metrics.getSamples();
        assertEqual(muestras.length, 1, "un solo intento: sin reintento automático");
        assertEqual(muestras[0].timeout, true, "la métrica lo registra como timeout");
        assertEqual(muestras[0].httpStatus, "000", "sin respuesta HTTP");
        engine.destroy();
    } finally {
        resetHttpConfig();
        net.restore();
    }
});

/* ============= Orden entre cargas y mutaciones (revisión) =============== */

test("crud 58: un GET anterior no borra el elemento creado por un POST posterior", async () => {
    fresh();
    const getPendiente = deferred();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(50, { title: "Creado" }));
        gets += 1;
        return gets === 1 ? jsonResponse(200, page([record(1)])) : getPendiente.promise;
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;

        const cargaVieja = engine.reload();          // GET en vuelo
        await tick(2);
        await engine.create({ title: "Creado", amount: 1, count: 1 });
        assertEqual(engine.getState().content.length, 2, "el 201 se integró");

        // El GET viejo responde AHORA, con una página que no incluye el creado.
        getPendiente.resolve(jsonResponse(200, page([record(1)])));
        await cargaVieja;
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.content.length, 2, "el elemento creado NO desapareció");
        assert(estado.content.some((r) => r.id === 50), "sigue presente");
        assertEqual(gets, 2, "no hubo un tercer GET oculto tras el POST");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 59: un GET anterior no revierte un PUT ni resucita un DELETE", async () => {
    fresh();
    const getPendiente = deferred();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "PUT") return jsonResponse(200, record(1, { title: "Renombrado" }));
        if (init.method === "DELETE") return makeResponse({ status: 204, body: "" });
        gets += 1;
        return gets === 1
            ? jsonResponse(200, page([record(1), record(2)]))
            : getPendiente.promise;
    });
    try {
        const engine = mount(host, descriptor(), { confirm: () => true });
        await engine.ready;

        const cargaVieja = engine.reload();
        await tick(2);
        await engine.update(1, { title: "Renombrado" });
        await engine.remove(2);

        // El GET viejo trae la representación ANTIGUA y el elemento eliminado.
        getPendiente.resolve(jsonResponse(200, page([record(1, { title: "Antiguo" }), record(2)])));
        await cargaVieja;
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.content.length, 1, "el eliminado no reaparece");
        assertEqual(estado.content[0].title, "Renombrado", "y el PUT no se revierte");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 60: una carga iniciada DESPUÉS de la mutación sí se aplica", async () => {
    fresh();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(50, { title: "Creado" }));
        gets += 1;
        return jsonResponse(200, page([record(9, { title: "Desde el servidor" })]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        await engine.create({ title: "Creado", amount: 1, count: 1 });
        assertEqual(engine.getState().content.length, 2, "integrado localmente");

        await engine.reload();                       // carga POSTERIOR a la mutación
        const estado = engine.getState();
        assertEqual(estado.content.length, 1, "esta sí se convierte en el nuevo estado");
        assertEqual(estado.content[0].title, "Desde el servidor", "manda el servidor");
        assertEqual(estado.needsReload, false, "y la lista vuelve a estar sincronizada");
        engine.destroy();
    } finally { net.restore(); }
});

/* =================== Mutaciones concurrentes por id ===================== */

test("crud 61: dos PUT del mismo elemento fuera de orden: gana el más nuevo", async () => {
    fresh();
    const primero = deferred();
    const segundo = deferred();
    let puts = 0;
    const net = installFetch((url, init) => {
        if (init.method === "PUT") {
            puts += 1;
            return puts === 1 ? primero.promise : segundo.promise;
        }
        return jsonResponse(200, page([record(1)]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;

        const putA = engine.update(1, { title: "A" });
        const putB = engine.update(1, { title: "B" });
        await tick(2);

        segundo.resolve(jsonResponse(200, record(1, { title: "B" })));   // B responde primero
        await putB;
        primero.resolve(jsonResponse(200, record(1, { title: "A" })));   // A responde después
        await putA;
        await tick(3);

        assertEqual(engine.getState().content[0].title, "B", "la actualización más nueva prevalece");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 62: un DELETE exitoso impide que un PUT anterior tardío resucite el elemento", async () => {
    fresh();
    const putPendiente = deferred();
    const net = installFetch((url, init) => {
        if (init.method === "PUT") return putPendiente.promise;
        if (init.method === "DELETE") return makeResponse({ status: 204, body: "" });
        return jsonResponse(200, page([record(1), record(2)]));
    });
    try {
        const engine = mount(host, descriptor(), { confirm: () => true });
        await engine.ready;

        const put = engine.update(1, { title: "Zombi" });
        await tick(2);
        await engine.remove(1);
        assertEqual(engine.getState().content.length, 1, "eliminado");

        putPendiente.resolve(jsonResponse(200, record(1, { title: "Zombi" })));
        await put;
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.content.length, 1, "el elemento NO resucita");
        assertEqual(estado.content.some((r) => r.id === 1), false, "sigue eliminado");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 63: una mutación pendiente que responde tras destroy() no modifica nada", async () => {
    fresh();
    const putPendiente = deferred();
    const net = installFetch((url, init) => {
        if (init.method === "PUT") return putPendiente.promise;
        return jsonResponse(200, page([record(1)]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const put = engine.update(1, { title: "Tardío" });
        await tick(2);
        engine.destroy();
        const estadoAntes = JSON.stringify(engine.getState());

        putPendiente.resolve(jsonResponse(200, record(1, { title: "Tardío" })));
        await put;
        await tick(3);

        assertEqual(JSON.stringify(engine.getState()), estadoAntes, "estado intacto tras destruir");
        assertEqual(host.textContent.indexOf("Tardío"), -1, "y sin repintar");
    } finally { net.restore(); }
});

/* =================== POST con la página llena =========================== */

test("crud 64: con la página llena, el POST no rompe la página y pide recarga manual", async () => {
    fresh();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(99, { title: "Nuevo" }));
        gets += 1;
        return jsonResponse(200, {
            content: [record(1), record(2)], page: 0, size: 2,
            totalElements: 2, totalPages: 1, last: true
        });
    });
    try {
        const engine = mount(host, descriptor(), { pageSize: 2 });
        await engine.ready;
        assertEqual(engine.getState().content.length, 2, "la página está llena");

        await engine.create({ title: "Nuevo", amount: 1, count: 1 });
        const estado = engine.getState();

        assertEqual(estado.content.length, 2, "no se supera el tamaño de página");
        assertEqual(estado.content.some((r) => r.id === 99), false, "no se inserta a la fuerza");
        assertEqual(estado.totalElements, 3, "pero el total sí se actualiza");
        assertEqual(estado.totalPages, 2, "y las páginas también");
        assertEqual(estado.needsReload, true, "se señala que hace falta una recarga manual");
        assertEqual(gets, 1, "y NO se dispara un GET automático");
        engine.destroy();
    } finally { net.restore(); }
});

/* ==================== Coherencia del formulario ========================= */

test("crud 65: un número opcional vacío viaja como null, nunca como 0", async () => {
    fresh();
    let cuerpo = null;
    const net = installFetch((url, init) => {
        if (init.method === "POST") {
            cuerpo = JSON.parse(init.body);
            return jsonResponse(201, record(5));
        }
        return jsonResponse(200, page([]));
    });
    try {
        // `amount` deja de ser obligatorio: se puede dejar vacío.
        const opcional = descriptor();
        opcional.fields = opcional.fields.map((f) =>
            f.name === "amount" ? { ...f, required: false } : f);

        const engine = mount(host, opcional);
        await engine.ready;
        engine.openForm(null);
        host.querySelector('[name="title"]').value = "ok";
        host.querySelector('[name="amount"]').value = "";
        host.querySelector('[name="count"]').value = "3";
        await engine.submitForm();
        await tick(2);

        assert(cuerpo !== null, "se envió");
        assertEqual(cuerpo.amount, null, "vacío es null, no 0: cero es un valor con significado");
        assertEqual(cuerpo.count, 3, "los que sí tienen valor se convierten");
        assertEqual("id" in cuerpo, false, "los readOnly no se envían");
        assertEqual("createdAt" in cuerpo, false, "tampoco las fechas de auditoría");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 66: dos formularios montados no comparten ids ni se interfieren", async () => {
    fresh();
    const otro = document.createElement("div");
    document.body.appendChild(otro);
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const a = mount(host, descriptor());
        const b = mount(otro, descriptor());
        await a.ready;
        await b.ready;
        a.openForm(null);
        b.openForm(null);

        const inputA = host.querySelector('[name="title"]');
        const inputB = otro.querySelector('[name="title"]');
        assert(inputA.id !== inputB.id, "los ids de input son únicos entre instancias");

        const erroresA = host.querySelector(".crud-form__errors");
        const erroresB = otro.querySelector(".crud-form__errors");
        assert(erroresA.id !== erroresB.id, "y los ids de error también");

        // Una violación en A no marca el input de B.
        a.showFormViolations({
            violationsByField: { title: [{ rule: "r", field: "title", message: "Solo A" }] },
            generalViolations: [], requestId: null
        });
        assertEqual(inputA.getAttribute("aria-invalid"), "true", "A marcado");
        assertEqual(inputB.getAttribute("aria-invalid"), null, "B intacto");
        assertEqual(inputA.getAttribute("aria-describedby"), erroresA.id, "A conectado a SUS errores");

        // Y al limpiar, aria-describedby desaparece.
        a.closeForm();
        assertEqual(inputA.getAttribute("aria-describedby"), null, "aria-describedby se limpia");
        a.destroy(); b.destroy();
        otro.remove();
    } finally { net.restore(); }
});

test("crud 67: setSubmitting(false) no reabre un formulario cerrado ni destruido", async () => {
    fresh();
    const net = installFetch(() => jsonResponse(200, page([record(1)])));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        engine.openForm(null);
        const enviar = host.querySelector(".crud-form__submit");
        assertEqual(enviar.disabled, false, "abierto: se puede enviar");

        engine.closeForm();
        engine.setFormSubmitting(false);
        assertEqual(enviar.disabled, true, "cerrado: sigue bloqueado");

        engine.openForm(null);
        assertEqual(enviar.disabled, false, "reabierto explícitamente: habilitado");

        engine.destroy();
        engine.setFormSubmitting(false);
        assertEqual(enviar.disabled, true, "destruido: nunca vuelve a habilitarse");
    } finally { net.restore(); }
});

/* ============ Orden por "última operación INICIADA" (mismo id) =========== */

test("crud 68: dos PUT del mismo id, el ANTIGUO responde primero: nunca se aplica", async () => {
    fresh();
    const antiguo = deferred();
    const nuevo = deferred();
    let puts = 0;
    const net = installFetch((url, init) => {
        if (init.method === "PUT") { puts += 1; return puts === 1 ? antiguo.promise : nuevo.promise; }
        return jsonResponse(200, page([record(1, { title: "Original" })]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;

        const putAntiguo = engine.update(1, { title: "Antiguo" });
        const putNuevo = engine.update(1, { title: "Nuevo" });
        await tick(2);

        // El ANTIGUO responde PRIMERO: no debe aplicarse ni un instante.
        antiguo.resolve(jsonResponse(200, record(1, { title: "Antiguo" })));
        const resultadoAntiguo = await putAntiguo;
        await tick(2);
        assertEqual(resultadoAntiguo, null, "la operación obsoleta resuelve como descartada");
        assertEqual(engine.getState().content[0].title, "Original",
            "el valor antiguo NO se aplicó ni temporalmente");

        nuevo.resolve(jsonResponse(200, record(1, { title: "Nuevo" })));
        await putNuevo;
        await tick(2);
        assertEqual(engine.getState().content[0].title, "Nuevo", "manda la última iniciada");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 69: el ERROR de un PUT obsoleto no reemplaza el resultado del nuevo", async () => {
    fresh();
    const antiguo = deferred();
    const nuevo = deferred();
    let puts = 0;
    const net = installFetch((url, init) => {
        if (init.method === "PUT") { puts += 1; return puts === 1 ? antiguo.promise : nuevo.promise; }
        return jsonResponse(200, page([record(1, { title: "Original" })]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;

        const putAntiguo = engine.update(1, { title: "Antiguo" });
        const putNuevo = engine.update(1, { title: "Nuevo" });
        await tick(2);

        nuevo.resolve(jsonResponse(200, record(1, { title: "Nuevo" })));
        await putNuevo;
        assertEqual(engine.getState().error, null, "el nuevo terminó sin error");

        // Ahora FALLA el antiguo, tarde.
        antiguo.resolve(errorResponse(409, { code: "conflict", requestId: "req-viejo" }));
        assertEqual(await putAntiguo, null, "descartado");
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.error, null, "el fallo obsoleto no aparece en el estado");
        assertEqual(estado.content[0].title, "Nuevo", "ni revierte el resultado nuevo");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 70: el error de la operación VIGENTE sí conserva su modelo normalizado", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (init.method === "PUT") {
            return errorResponse(503, { code: "data_unavailable", kind: "FAILURE", requestId: "req-put" });
        }
        return jsonResponse(200, page([record(1)]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        await engine.update(1, { title: "x" });
        const error = engine.getState().error;
        assertEqual(error.category, CATEGORY.UNAVAILABLE, "categoría normalizada");
        assertEqual(error.code, "data_unavailable", "código del backend, sin interpretar");
        assertEqual(error.requestId, "req-put", "requestId conservado");
        assertEqual(error.retryable, true, "capacidad de reintento del contrato");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 71: dos DELETE del mismo id descuentan una sola vez, respondan como respondan", async () => {
    for (const [caso, invertido] of [["en orden", false], ["al revés", true]]) {
        fresh();
        const primero = deferred();
        const segundo = deferred();
        let deletes = 0;
        const net = installFetch((url, init) => {
            if (init.method === "DELETE") {
                deletes += 1;
                return deletes === 1 ? primero.promise : segundo.promise;
            }
            return jsonResponse(200, page([record(1), record(2)]));
        });
        try {
            const engine = mount(host, descriptor(), { confirm: () => true });
            await engine.ready;
            assertEqual(engine.getState().totalElements, 2, caso + ": punto de partida");

            const borradoA = engine.remove(1);
            const borradoB = engine.remove(1);
            await tick(2);

            const respuesta = () => makeResponse({ status: 204, body: "" });
            if (invertido) {
                segundo.resolve(respuesta()); await borradoB;
                primero.resolve(respuesta()); await borradoA;
            } else {
                primero.resolve(respuesta()); await borradoA;
                segundo.resolve(respuesta()); await borradoB;
            }
            await tick(3);

            const estado = engine.getState();
            assertEqual(estado.totalElements, 1, caso + ": el total baja UNA sola vez");
            assertEqual(estado.content.length, 1, caso + ": y el contenido también");
            assertEqual(estado.totalPages, 1, caso + ": totalPages coherente");
            assertEqual(estado.last, true, caso + ": última página");
            engine.destroy();
        } finally { net.restore(); }
    }
});

test("crud 72: PUT antiguo + DELETE nuevo: el PUT no resucita ni siquiera fallando", async () => {
    fresh();
    const put = deferred();
    const net = installFetch((url, init) => {
        if (init.method === "PUT") return put.promise;
        if (init.method === "DELETE") return makeResponse({ status: 204, body: "" });
        return jsonResponse(200, page([record(1), record(2)]));
    });
    try {
        const engine = mount(host, descriptor(), { confirm: () => true });
        await engine.ready;

        const putPendiente = engine.update(1, { title: "Zombi" });
        await tick(2);
        await engine.remove(1);                       // DELETE es ahora la última iniciada
        assertEqual(engine.getState().totalElements, 1, "eliminado");

        // El PUT antiguo falla tarde: tampoco puede dejar su error.
        put.resolve(errorResponse(409, { code: "conflict", requestId: "req-put-viejo" }));
        assertEqual(await putPendiente, null, "descartado");
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.content.some((r) => r.id === 1), false, "no resucita");
        assertEqual(estado.error, null, "ni deja un error obsoleto");
        assertEqual(estado.totalElements, 1, "ni altera los totales");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 73: DELETE antiguo + PUT nuevo: gana la última iniciada, que es el PUT", async () => {
    fresh();
    const borrado = deferred();
    const net = installFetch((url, init) => {
        if (init.method === "DELETE") return borrado.promise;
        if (init.method === "PUT") return jsonResponse(200, record(1, { title: "Actualizado" }));
        return jsonResponse(200, page([record(1), record(2)]));
    });
    try {
        const engine = mount(host, descriptor(), { confirm: () => true });
        await engine.ready;

        const borradoPendiente = engine.remove(1);
        await tick(2);
        await engine.update(1, { title: "Actualizado" });   // última iniciada

        borrado.resolve(makeResponse({ status: 204, body: "" }));
        assertEqual(await borradoPendiente, null, "el DELETE antiguo se descarta");
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.content.length, 2, "el elemento sigue ahí");
        assertEqual(estado.content[0].title, "Actualizado", "con el valor del PUT");
        assertEqual(estado.totalElements, 2, "el total no bajó");
        engine.destroy();
    } finally { net.restore(); }
});

/* ============= Coherencia de paginación tras las mutaciones ============= */

test("crud 74: tras POST en página llena, last y totalPages quedan coherentes", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(99));
        return jsonResponse(200, {
            content: [record(1), record(2)], page: 0, size: 2,
            totalElements: 2, totalPages: 1, last: true
        });
    });
    try {
        const engine = mount(host, descriptor(), { pageSize: 2 });
        await engine.ready;
        assertEqual(engine.getState().last, true, "antes era la última página");

        await engine.create({ title: "x", amount: 1, count: 1 });
        const estado = engine.getState();
        assertEqual(estado.totalElements, 3, "total nuevo");
        assertEqual(estado.totalPages, 2, "totalPages recalculado");
        assertEqual(estado.last, false, "la página 0 ya NO es la última");
        assertEqual(estado.page, 0, "seguimos en la misma página");
        assertEqual(estado.content.length, 2, "sin exceder el tamaño de página");
        assert(estado.page < estado.totalPages, "page < totalPages");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 75: tras DELETE, last y totalPages se recalculan con los totales nuevos", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (init.method === "DELETE") return makeResponse({ status: 204, body: "" });
        return jsonResponse(200, {
            content: [record(1), record(2)], page: 0, size: 2,
            totalElements: 3, totalPages: 2, last: false
        });
    });
    try {
        const engine = mount(host, descriptor(), { pageSize: 2, confirm: () => true });
        await engine.ready;
        assertEqual(engine.getState().last, false, "había una página más");

        await engine.remove(1);
        const estado = engine.getState();
        assertEqual(estado.totalElements, 2, "total nuevo");
        assertEqual(estado.totalPages, 1, "una sola página ahora");
        assertEqual(estado.last, true, "y esta es la última");
        assertEqual(estado.page, 0, "sin salirse de rango");
        assert(estado.page < estado.totalPages, "page < totalPages");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 76: al eliminar el último elemento de la colección, el estado queda vacío y coherente", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (init.method === "DELETE") return makeResponse({ status: 204, body: "" });
        return jsonResponse(200, page([record(1)]));
    });
    try {
        const engine = mount(host, descriptor(), { confirm: () => true });
        await engine.ready;
        await engine.remove(1);
        const estado = engine.getState();
        assertEqual(estado.totalElements, 0, "sin elementos");
        assertEqual(estado.totalPages, 0, "sin páginas");
        assertEqual(estado.page, 0, "página 0");
        assertEqual(estado.content.length, 0, "contenido vacío");
        assertEqual(estado.last, true, "y última por definición");
        engine.destroy();
    } finally { net.restore(); }
});

/* ============== POST con búsqueda o con orden activos =================== */

test("crud 77: con búsqueda activa, el POST no inventa pertenencia al filtro", async () => {
    fresh();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(99, { title: "Nuevo" }));
        gets += 1;
        return jsonResponse(200, page([record(1)]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        await engine.setSearch("filtro");
        const antes = engine.getState();

        const creado = await engine.create({ title: "Nuevo", amount: 1, count: 1 });
        const estado = engine.getState();

        assertEqual(creado.id, 99, "el 201 sigue resolviendo con el recurso");
        assertEqual(estado.totalElements, antes.totalElements,
            "NO se toca el total: el motor no sabe si el recurso pasa el filtro");
        assertEqual(estado.totalPages, antes.totalPages, "ni las páginas");
        assertEqual(estado.content.length, antes.content.length, "ni se inserta en la lista filtrada");
        assertEqual(estado.needsReload, true, "se pide una recarga manual");
        assertEqual(gets, 2, "y NO hay GET automático tras el POST");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 78: con orden activo se integra, pero la posición no se presenta como autoritativa", async () => {
    fresh();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(99, { title: "Aaa primero por orden" }));
        gets += 1;
        return jsonResponse(200, page([record(1, { title: "Zzz" })]));
    });
    try {
        const engine = mount(host, descriptor());     // defaultSort: title,asc
        await engine.ready;
        assert(engine.getState().sort !== null, "hay un orden activo");

        await engine.create({ title: "Aaa primero por orden", amount: 1, count: 1 });
        const estado = engine.getState();

        assertEqual(estado.content.length, 2, "se integra para que se vea la creación");
        assertEqual(estado.totalElements, 2, "el total sí sube: no hay filtro");
        assertEqual(estado.needsReload, true,
            "pero la posición no la puede reproducir el motor: se pide recarga");
        assertEqual(gets, 1, "sin GET automático");
        engine.destroy();
    } finally { net.restore(); }
});

/* ============ Coherencia aritmética de PageResponse ===================== */

test("crud 79: readPage rechaza totales matemáticamente imposibles", async () => {
    fresh();
    let respuesta = page([record(1)]);
    const net = installFetch(() => jsonResponse(200, respuesta));
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        assertEqual(engine.getState().content.length, 1, "hay contenido utilizable");

        const llena = (n) => Array.from({ length: n }, (_, i) => record(i + 1));
        const incoherentes = [
            ["100 elementos, size 20, totalPages 1",
             { content: llena(20), page: 0, size: 20, totalElements: 100, totalPages: 1, last: true }],
            ["21 elementos, size 20, primera página con menos de 20",
             { content: llena(3), page: 0, size: 20, totalElements: 21, totalPages: 2, last: false }],
            ["última página con cantidad incompatible",
             { content: llena(5), page: 1, size: 20, totalElements: 21, totalPages: 2, last: true }],
            ["totalElements 0 con totalPages 1",
             { content: [], page: 0, size: 20, totalElements: 0, totalPages: 1, last: true }],
            ["totalElements > 0 con totalPages 0",
             { content: [record(1)], page: 0, size: 20, totalElements: 5, totalPages: 0, last: true }],
            ["primera página vacía sin colección vacía",
             { content: [], page: 0, size: 20, totalElements: 5, totalPages: 1, last: true }]
        ];
        for (const [caso, cuerpo] of incoherentes) {
            respuesta = cuerpo;
            await engine.reload();
            const estado = engine.getState();
            assertEqual(estado.error.category, CATEGORY.CLIENT, caso + ": error local");
            assertEqual(estado.content.length, 1, caso + ": conserva lo último utilizable");
            assertEqual(estado.content[0].id, 1, caso + ": sin corregir nada");
        }

        // Y una página intermedia LLENA sí se acepta.
        respuesta = { content: llena(20), page: 0, size: 20, totalElements: 21, totalPages: 2, last: false };
        await engine.reload();
        assertEqual(engine.getState().error, null, "la coherente se acepta");
        assertEqual(engine.getState().content.length, 20, "con sus 20 elementos");
        engine.destroy();
    } finally { net.restore(); }
});

/* ========== Un POST confirmado invalida las cargas anteriores =========== */

test("crud 80: un POST que NO se integra invalida igualmente el GET anterior", async () => {
    fresh();
    const getPendiente = deferred();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(7, { title: "Creado aparte" }));
        if (init.method === "PUT") return new Promise(() => {});   // queda en vuelo
        gets += 1;
        return gets === 1 ? jsonResponse(200, page([record(1)])) : getPendiente.promise;
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;

        // 1. Un GET en vuelo.
        const cargaVieja = engine.reload();
        await tick(2);
        // 2. Una mutación iniciada para el id 7 (nunca responde).
        engine.update(7, { title: "otra cosa" });
        await tick(2);
        // 3. El POST confirma la creación de ese MISMO id: no puede integrarse.
        const creado = await engine.create({ title: "Creado aparte", amount: 1, count: 1 });
        assertEqual(creado.id, 7, "el 201 resuelve con el recurso");
        const trasPost = engine.getState();
        assertEqual(trasPost.needsReload, true, "no se integró: hace falta recargar");
        assertEqual(trasPost.content.length, 1, "y el contenido no cambió");

        // 4. Responde el GET anterior, con la lista de ANTES de crear.
        getPendiente.resolve(jsonResponse(200, page([record(1), record(2)])));
        await cargaVieja;
        await tick(3);

        const estado = engine.getState();
        assertEqual(estado.content.length, 1, "el GET anterior se descartó");
        assertEqual(estado.content[0].id, 1, "sin alterar el estado");
        assertEqual(estado.needsReload, true, "needsReload sigue activo");
        assertEqual(gets, 2, "y no hubo GET automático tras el POST");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 81: una carga iniciada DESPUÉS del POST sí se aplica", async () => {
    fresh();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") return jsonResponse(201, record(9, { title: "Creado" }));
        gets += 1;
        return jsonResponse(200, page([record(1), record(9, { title: "Creado" })]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        await engine.create({ title: "Creado", amount: 1, count: 1 });
        await engine.reload();                       // carga posterior
        const estado = engine.getState();
        assertEqual(estado.content.length, 2, "la carga posterior sí manda");
        assertEqual(estado.needsReload, false, "y deja la lista sincronizada");
        engine.destroy();
    } finally { net.restore(); }
});

/* ============ Identidad obligatoria en las respuestas de mutación ======= */

test("crud 82: un 201 sin identidad confirma el efecto remoto pero no se puede integrar", async () => {
    const casos = [
        ["sin idField", { title: "x", amount: 1, count: 1, enabled: true, createdAt: "2026-08-22T10:00:00Z" }],
        ["id null", { id: null, title: "x" }],
        ["id cadena vacía", { id: "   ", title: "x" }],
        ["cuerpo no objeto", "solo texto"]
    ];
    for (const [caso, cuerpo] of casos) {
        fresh();
        let gets = 0;
        const net = installFetch((url, init) => {
            if (init.method === "POST") return jsonResponse(201, cuerpo);
            gets += 1;
            return jsonResponse(200, page([record(1)]));
        });
        try {
            const engine = mount(host, descriptor());
            await engine.ready;
            const antes = engine.getState();

            await engine.create({ title: "x", amount: 1, count: 1 });
            const estado = engine.getState();

            assertEqual(estado.error.category, CATEGORY.CLIENT, caso + ": categoría client");
            assertEqual(estado.content.length, antes.content.length, caso + ": contenido intacto");
            assertEqual(estado.totalElements, antes.totalElements, caso + ": totales intactos");
            assertEqual(estado.totalPages, antes.totalPages, caso + ": totalPages intacto");
            assertEqual(estado.page, antes.page, caso + ": página intacta");
            assertEqual(estado.last, antes.last, caso + ": last intacto");
            // El 201 SÍ ocurrió: la colección remota cambió aunque no sepamos cómo.
            assertEqual(estado.revision, antes.revision + 1, caso + ": revision sube exactamente uno");
            assertEqual(estado.needsReload, true, caso + ": la vista quedó desfasada");
            assertEqual(gets, 1, caso + ": sin petición adicional");
            engine.destroy();
        } finally { net.restore(); }
    }
});

test("crud 83: un PUT sin identidad o con OTRA identidad conserva la fila anterior", async () => {
    const casos = [
        ["sin idField", { title: "Cambiado", amount: 1 }],
        ["id null", { id: null, title: "Cambiado" }],
        ["id distinto", { id: 999, title: "Cambiado" }]
    ];
    for (const [caso, cuerpo] of casos) {
        fresh();
        let gets = 0;
        const net = installFetch((url, init) => {
            if (init.method === "PUT") return jsonResponse(200, cuerpo);
            gets += 1;
            return jsonResponse(200, page([record(1, { title: "Original" }), record(2)]));
        });
        try {
            const engine = mount(host, descriptor());
            await engine.ready;
            const antes = engine.getState();

            await engine.update(1, { title: "Cambiado" });
            const estado = engine.getState();

            assertEqual(estado.error.category, CATEGORY.CLIENT, caso + ": categoría client");
            assertEqual(estado.content.length, 2, caso + ": la fila no se sustituye por otra identidad");
            assertEqual(estado.content[0].id, 1, caso + ": sigue el id original");
            assertEqual(estado.content[0].title, "Original", caso + ": con su valor anterior");
            assertEqual(estado.totalElements, antes.totalElements, caso + ": totales intactos");
            assertEqual(estado.revision, antes.revision, caso + ": revision NO se incrementa");
            assertEqual(gets, 1, caso + ": sin petición adicional");
            engine.destroy();
        } finally { net.restore(); }
    }
});

test("crud 84: un id numérico y su forma textual equivalente SÍ se aceptan", async () => {
    fresh();
    const net = installFetch((url, init) => {
        // Se pide actualizar el 1 (número) y el backend devuelve "1" (cadena):
        // es la equivalencia habitual al serializar, y designa el mismo elemento.
        if (init.method === "PUT") return jsonResponse(200, { ...record(1, { title: "Cambiado" }), id: "1" });
        return jsonResponse(200, page([record(1, { title: "Original" })]));
    });
    try {
        const engine = mount(host, descriptor());
        await engine.ready;
        const antes = engine.getState();

        const guardado = await engine.update(1, { title: "Cambiado" });
        const estado = engine.getState();

        assert(guardado !== null, "se acepta: 1 y \"1\" designan el mismo elemento");
        assertEqual(estado.error, null, "sin error");
        assertEqual(estado.content[0].title, "Cambiado", "la fila se sustituye");
        assertEqual(estado.revision, antes.revision + 1, "y cuenta como mutación confirmada");
        engine.destroy();
    } finally { net.restore(); }
});

/* ======== DELETE en página intermedia: proyección incompleta ============ */

test("crud 85: un DELETE en una página que no es la última marca needsReload", async () => {
    fresh();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "DELETE") return makeResponse({ status: 204, body: "" });
        gets += 1;
        return jsonResponse(200, {
            content: [record(1), record(2)], page: 0, size: 2,
            totalElements: 5, totalPages: 3, last: false
        });
    });
    try {
        const engine = mount(host, descriptor(), { pageSize: 2, confirm: () => true });
        await engine.ready;
        assertEqual(engine.getState().needsReload, false, "recién cargada está sincronizada");

        await engine.remove(1);
        const estado = engine.getState();

        assertEqual(estado.content.length, 1, "localmente queda un hueco");
        assertEqual(estado.totalElements, 4, "los totales sí se recalculan");
        assertEqual(estado.totalPages, 2, "y las páginas");
        assertEqual(estado.last, false, "sigue sin ser la última");
        assertEqual(estado.page, 0, "en la misma página");
        assertEqual(estado.needsReload, true,
            "el elemento que debía subir desde la página siguiente no se puede traer localmente");
        assertEqual(gets, 1, "y NO se dispara un GET automático");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 86: un DELETE en la última página completa no marca needsReload", async () => {
    fresh();
    const net = installFetch((url, init) => {
        if (init.method === "DELETE") return makeResponse({ status: 204, body: "" });
        return jsonResponse(200, page([record(1), record(2)]));
    });
    try {
        const engine = mount(host, descriptor(), { confirm: () => true });
        await engine.ready;
        await engine.remove(1);
        const estado = engine.getState();
        assertEqual(estado.content.length, 1, "queda uno");
        assertEqual(estado.totalElements, 1, "y el total coincide");
        assertEqual(estado.needsReload, false,
            "aquí la proyección local SÍ es completa: no falta nada por subir");
        engine.destroy();
    } finally { net.restore(); }
});

test("crud 87: un 201 sin identidad invalida el GET anterior y no impide el siguiente", async () => {
    fresh();
    const getPendiente = deferred();
    let gets = 0;
    const net = installFetch((url, init) => {
        if (init.method === "POST") {
            // 201 con cuerpo que incumple el contrato: sin idField.
            return jsonResponse(201, { title: "Sin identidad" }, { "X-Request-Id": "req-201-roto" });
        }
        gets += 1;
        if (gets === 1) return jsonResponse(200, page([record(1)]));
        if (gets === 2) return getPendiente.promise;
        return jsonResponse(200, page([record(1), record(2)]));
    });
    try {
        // 1. Página válida cargada.
        const engine = mount(host, descriptor());
        await engine.ready;
        const inicial = engine.getState();
        assertEqual(inicial.content.length, 1, "página inicial");

        // 2. Un GET que queda pendiente.
        const cargaVieja = engine.reload();
        await tick(2);

        // 3. POST con 201 de cuerpo inválido.
        const resultado = await engine.create({ title: "Sin identidad", amount: 1, count: 1 });
        const trasPost = engine.getState();

        // 4. Error local, needsReload y UNA sola subida de revision.
        assertEqual(resultado, null, "no devuelve un recurso que no se puede identificar");
        assertEqual(trasPost.error.category, CATEGORY.CLIENT, "error local client");
        assertEqual(trasPost.error.requestId, "req-201-roto", "conserva el requestId de la respuesta");
        assertEqual(trasPost.needsReload, true, "la vista quedó desfasada");
        assertEqual(trasPost.revision, inicial.revision + 1, "revision sube exactamente uno");
        assertEqual(trasPost.content.length, 1, "sin integrar nada");
        assertEqual(trasPost.totalElements, inicial.totalElements, "y sin tocar los totales");

        // 5 y 6. El GET anterior responde: debe descartarse.
        getPendiente.resolve(jsonResponse(200, page([record(5), record(6), record(7)])));
        await cargaVieja;
        await tick(3);

        const trasGetViejo = engine.getState();
        assertEqual(trasGetViejo.content.length, 1, "el GET anterior se descarta");
        assertEqual(trasGetViejo.content[0].id, 1, "sin sobrescribir el estado");
        assertEqual(trasGetViejo.needsReload, true, "y sigue haciendo falta recargar");

        // 7. Un GET NUEVO sí se aplica y limpia needsReload.
        await engine.reload();
        const final = engine.getState();
        assertEqual(final.content.length, 2, "la carga posterior sí manda");
        assertEqual(final.needsReload, false, "y deja la lista sincronizada");
        assertEqual(final.error, null, "sin arrastrar el error anterior");
        engine.destroy();
    } finally { net.restore(); }
});
}
