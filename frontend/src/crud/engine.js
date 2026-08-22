/**
 * frontend/src/crud/engine.js — Motor CRUD genérico gobernado por descriptores.
 *
 * QUÉ ES ESTO
 * -----------
 * Una sola implementación de listar, buscar, ordenar, paginar, crear, editar y
 * eliminar, que no sabe qué recurso está manipulando. Todo lo específico entra
 * por parámetro, en un DESCRIPTOR. Agregar un recurso consiste en escribir su
 * descriptor y registrarlo; ningún archivo de `crud/` ni de `platform/` se toca
 * (ADR-F01).
 *
 * LO QUE ESTE MÓDULO NO PUEDE HACER, POR DISEÑO
 * ---------------------------------------------
 * - No importa nada de `src/resources/**`.
 * - No nombra recursos concretos ni contiene sus rutas.
 * - No conoce campos de dominio ni casos especiales por descriptor.
 * - No llama a `fetch()`: el único transporte es el API público de
 *   `platform/http.js`.
 * - No conoce access tokens ni refresh tokens: de eso se ocupa el proveedor que
 *   `platform/http.js` tiene inyectado (ADR-F02).
 * - No lee `frontend/config.js`: el tamaño de página entra como opción.
 * - No interpreta reglas de negocio del backend.
 *
 * Dirección de dependencias permitida:  app → crud → platform.
 * Nunca: crud → resources, ni platform → crud.
 *
 * FORMA DEL DESCRIPTOR
 * --------------------
 * Este ejemplo es documentación y fixture neutral. NO es un recurso real:
 *
 *     {
 *       key: "records",                 // identificador interno, estable
 *       label: "Registros",             // título en plural
 *       singularLabel: "Registro",      // título en singular
 *       path: "/api/records",           // ruta base, relativa
 *       idField: "id",                  // campo que identifica cada elemento
 *
 *       search: {                       // opcional
 *         field: "title",               // campo mostrado como buscable
 *         queryParam: "name",           // nombre del parámetro que espera la API
 *         placeholder: "Buscar"
 *       },
 *
 *       defaultSort: {                  // opcional; el campo debe ser sortable
 *         field: "createdAt",
 *         direction: "desc"
 *       },
 *
 *       permits: {                      // capacidades declarativas, no roles
 *         read: "AUTHENTICATED",
 *         write: "ADMIN"
 *       },
 *
 *       danger: {                       // opcional
 *         delete: "confirm"
 *       },
 *
 *       fields: [
 *         {
 *           name: "title",
 *           label: "Título",
 *           type: "text",               // text | decimal | integer | boolean | datetime
 *           required: true,
 *           maxLength: 100,
 *           readOnly: false,
 *           inList: true,
 *           sortable: true,
 *           align: "left"               // left | center | right
 *         },
 *         {
 *           name: "createdAt",
 *           label: "Creado",
 *           type: "datetime",
 *           readOnly: true,
 *           inList: true,
 *           sortable: true,
 *           align: "right"
 *         }
 *       ]
 *     }
 *
 * TÁCTICAS (Cap. 8): "Abstract Common Services" —una sola implementación de CRUD
 * para todos los recursos—, "Restrict Dependencies" —el motor no puede alcanzar
 * a los recursos— y "Defer Binding" —el descriptor, el tamaño de página y las
 * capacidades entran en tiempo de ejecución—.
 */

import { get, post, put, del, HttpError } from "../platform/http.js";
import { CATEGORY } from "../platform/errors.js";
import { createTable } from "./table.js";
import { createForm } from "./form.js";
import { createPager } from "./pager.js";

/**
 * Tamaño de página por defecto si la composición no entrega uno.
 *
 * Coincide con `config.pageSize`, pero NO se importa desde aquí: `crud/` no lee
 * la configuración. Quien monta el motor pasa `{ pageSize: config.pageSize }` y
 * así la configuración sigue teniendo un solo dueño.
 */
export const DEFAULT_PAGE_SIZE = 20;

const SUPPORTED_TYPES = ["text", "decimal", "integer", "boolean", "datetime"];
const SUPPORTED_ALIGNMENTS = ["left", "center", "right"];
const DIRECTIONS = ["asc", "desc"];
/** Vocabulario de acciones peligrosas. Genérico: no nombra ninguna operación de dominio. */
const DANGER_MODES = ["confirm", "none"];
/** `maxLength` solo tiene sentido donde hay longitud: en texto. */
const TYPES_WITH_LENGTH = ["text"];

/** Fallo local del motor: descriptor mal formado, contenedor inválido, etc. */
export class CrudError extends Error {
    constructor(message) {
        super(message);
        this.name = "CrudError";
    }
}

let instanceCounter = 0;

/* ------------------------------------------------------------------ *
 * Validación del descriptor
 * ------------------------------------------------------------------ */

function nonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}

/**
 * Valida el descriptor ENTERO antes de montar nada y antes de tocar la red.
 *
 * Un descriptor mal formado tiene que fallar aquí, con un error local claro, y
 * no tres pantallas después con una petición a una ruta indefinida. Esta
 * validación no produce ninguna muestra de métricas porque no hay petición: el
 * fallo es del cliente y ocurre antes de que exista un intento HTTP.
 */
export function validateDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== "object") {
        throw new CrudError("descriptor ausente o no es un objeto");
    }
    for (const key of ["key", "label", "singularLabel", "path"]) {
        if (!nonEmptyString(descriptor[key])) {
            throw new CrudError("descriptor sin '" + key + "' válido");
        }
    }
    if (!descriptor.path.startsWith("/")) {
        throw new CrudError("descriptor.path debe ser una ruta relativa que empiece por '/'");
    }
    if (!Array.isArray(descriptor.fields) || descriptor.fields.length === 0) {
        throw new CrudError("descriptor.fields debe ser un arreglo no vacío");
    }

    const names = new Set();
    let visibleColumns = 0;
    for (const field of descriptor.fields) {
        if (!field || !nonEmptyString(field.name)) {
            throw new CrudError("hay un campo sin 'name' válido");
        }
        if (names.has(field.name)) {
            throw new CrudError("campo duplicado en el descriptor: '" + field.name + "'");
        }
        names.add(field.name);
        if (!nonEmptyString(field.label)) {
            throw new CrudError("el campo '" + field.name + "' no declara 'label'");
        }
        if (!SUPPORTED_TYPES.includes(field.type)) {
            throw new CrudError("tipo no soportado en '" + field.name + "': " + String(field.type));
        }
        if (field.align !== undefined && !SUPPORTED_ALIGNMENTS.includes(field.align)) {
            throw new CrudError("alineación no soportada en '" + field.name + "': " + String(field.align));
        }
        // Las banderas son booleanas o no están. Un `required: "si"` es verdadero
        // en JavaScript y produciría un formulario que exige campos que el
        // descriptor no quiso exigir: es un defecto silencioso.
        for (const flag of ["required", "readOnly", "inList", "sortable"]) {
            if (field[flag] !== undefined && typeof field[flag] !== "boolean") {
                throw new CrudError("'" + flag + "' debe ser booleano en el campo '" + field.name + "'");
            }
        }
        if (field.maxLength !== undefined) {
            if (!Number.isInteger(field.maxLength) || field.maxLength <= 0) {
                throw new CrudError("maxLength debe ser un entero positivo en '" + field.name + "'");
            }
            if (!TYPES_WITH_LENGTH.includes(field.type)) {
                throw new CrudError("maxLength no aplica al tipo '" + field.type +
                    "' del campo '" + field.name + "'");
            }
        }
        if (field.inList === true) {
            visibleColumns += 1;
        }
    }

    // Sin columnas visibles la tabla no puede mostrar nada: es un descriptor
    // inservible y vale más decirlo al montar que dejar una tabla vacía.
    if (visibleColumns === 0) {
        throw new CrudError("el descriptor no declara ningún campo con inList:true");
    }

    // El idField SÍ puede ser readOnly —normalmente lo es—, pero tiene que estar
    // declarado: sin él no se pueden construir rutas ni identificar filas.
    if (!nonEmptyString(descriptor.idField) || !names.has(descriptor.idField)) {
        throw new CrudError("descriptor.idField debe nombrar un campo declarado");
    }

    if (descriptor.search !== undefined && descriptor.search !== null) {
        const search = descriptor.search;
        if (typeof search !== "object") {
            throw new CrudError("descriptor.search debe ser un objeto");
        }
        if (!nonEmptyString(search.field)) {
            throw new CrudError("descriptor.search debe declarar 'field'");
        }
        if (!names.has(search.field)) {
            throw new CrudError("descriptor.search.field apunta a un campo inexistente: " +
                String(search.field));
        }
        if (!nonEmptyString(search.queryParam)) {
            throw new CrudError("descriptor.search debe declarar 'queryParam'");
        }
        if (search.placeholder !== undefined && typeof search.placeholder !== "string") {
            throw new CrudError("descriptor.search.placeholder debe ser una cadena");
        }
    }

    if (descriptor.permits !== undefined && descriptor.permits !== null) {
        if (typeof descriptor.permits !== "object") {
            throw new CrudError("descriptor.permits debe ser un objeto");
        }
        for (const capability of ["read", "write"]) {
            const declared = descriptor.permits[capability];
            if (declared !== undefined && !nonEmptyString(declared)) {
                throw new CrudError("descriptor.permits." + capability +
                    " debe ser una capacidad no vacía");
            }
        }
    }

    if (descriptor.danger !== undefined && descriptor.danger !== null) {
        if (typeof descriptor.danger !== "object") {
            throw new CrudError("descriptor.danger debe ser un objeto");
        }
        if (descriptor.danger.delete !== undefined &&
            !DANGER_MODES.includes(descriptor.danger.delete)) {
            throw new CrudError("modo de confirmación no soportado: " +
                String(descriptor.danger.delete));
        }
    }

    if (descriptor.defaultSort !== undefined && descriptor.defaultSort !== null) {
        const { field, direction } = descriptor.defaultSort;
        if (!names.has(field)) {
            throw new CrudError("defaultSort apunta a un campo inexistente: " + String(field));
        }
        if (!isSortable(descriptor, field)) {
            throw new CrudError("defaultSort apunta a un campo no ordenable: " + String(field));
        }
        if (direction !== undefined && !DIRECTIONS.includes(direction)) {
            throw new CrudError("dirección de orden no soportada: " + String(direction));
        }
    }

    return descriptor;
}

function isSortable(descriptor, name) {
    const field = descriptor.fields.find((candidate) => candidate.name === name);
    return Boolean(field) && field.sortable === true;
}

/* ------------------------------------------------------------------ *
 * Validación de la página recibida
 * ------------------------------------------------------------------ */

/**
 * Valida la forma contractual de PageResponse y, sobre todo, su COHERENCIA
 * INTERNA. Solo los seis campos del contrato; nada de `pageable`,
 * `numberOfElements` ni `sort` de Spring.
 *
 * No basta con que los campos existan: una página con `totalPages: 0` y
 * contenido, o con `last: true` en la página 1 de 5, describe algo imposible.
 * Aceptarla produciría un paginador que navega a páginas inexistentes o que se
 * niega a avanzar habiendo datos. Aquí NO se corrige nada en silencio —corregir
 * sería inventar— sino que se rechaza entera y el motor conserva lo último
 * utilizable, señalando un error local `client`.
 */
function readPage(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.content)) {
        return null;
    }

    const { content, page, size, totalElements, totalPages, last } = data;

    // Enteros de verdad: una página 1.5 o un tamaño 3.7 no significan nada.
    if (!Number.isInteger(page) || !Number.isInteger(size) ||
        !Number.isInteger(totalElements) || !Number.isInteger(totalPages)) {
        return null;
    }
    if (page < 0 || size <= 0 || totalElements < 0 || totalPages < 0) {
        return null;
    }
    // `last` debe venir declarado y ser booleano: deducirlo cuando falta es
    // exactamente el tipo de suposición que rompe la navegación.
    if (typeof last !== "boolean") {
        return null;
    }
    // Una página no puede traer más elementos de los que declara caber.
    if (content.length > size) {
        return null;
    }

    if (totalElements === 0) {
        // Colección vacía: el único estado posible es cero páginas, página 0,
        // contenido vacío y última.
        if (totalPages !== 0 || content.length !== 0 || page !== 0 || last !== true) {
            return null;
        }
        return { content, page, size, totalElements, totalPages, last };
    }

    // Con elementos tiene que haber páginas, y su número no es una opinión: sale
    // de dividir. Un `totalPages` que no cuadre con `totalElements` y `size`
    // describe una colección imposible, y el paginador construido sobre él
    // navegaría a páginas que no existen o se negaría a avanzar habiendo datos.
    if (totalPages === 0 || totalPages !== Math.ceil(totalElements / size)) {
        return null;
    }
    if (page >= totalPages) {
        return null;
    }
    if (last !== (page === totalPages - 1)) {
        return null;
    }

    // Cuántos elementos DEBE traer esta página, dados los totales declarados.
    // Toda página que no sea la última va llena; la última trae el resto. No se
    // admite excepción: el backend pagina con un tamaño fijo (CONTRATO §4.2), así
    // que una página intermedia a medias significa que los totales mienten.
    const expected = page === totalPages - 1
        ? totalElements - page * size
        : size;
    if (content.length !== expected) {
        return null;
    }

    return { content, page, size, totalElements, totalPages, last };
}

/* ------------------------------------------------------------------ *
 * Modelo de error presentable
 * ------------------------------------------------------------------ */

/** Traduce cualquier fallo al modelo mínimo que la vista necesita. */
function toViewError(cause) {
    if (cause instanceof HttpError && cause.error) {
        const model = cause.error;
        return {
            category: model.category,
            code: model.code,
            message: model.message,
            detail: model.detail,
            requestId: model.requestId,
            httpStatus: model.httpStatus,
            retryable: model.retryable === true,
            violationsByField: model.violationsByField || {},
            generalViolations: model.generalViolations || []
        };
    }
    return {
        category: CATEGORY.CLIENT,
        code: null,
        message: cause && cause.message ? cause.message : "Error inesperado",
        detail: null,
        requestId: null,
        httpStatus: null,
        retryable: false,
        violationsByField: {},
        generalViolations: []
    };
}

/** Texto legible, derivado de la CATEGORÍA, nunca de una regla concreta. */
function describeError(error, descriptor) {
    switch (error.category) {
        case CATEGORY.UNAUTHORIZED:
            return "La sesión no es válida. Vuelve a iniciar sesión.";
        case CATEGORY.FORBIDDEN:
            return "No tienes permiso para esta operación.";
        case CATEGORY.NOT_FOUND:
            return "El elemento ya no existe.";
        case CATEGORY.CONFLICT:
            return "La operación entra en conflicto con el estado actual.";
        case CATEGORY.UNAVAILABLE:
            return "El servicio no está disponible en este momento.";
        case CATEGORY.TIMEOUT:
            return "La operación tardó demasiado y se canceló.";
        case CATEGORY.NETWORK:
            return "No se pudo contactar con el servidor.";
        case CATEGORY.BUSINESS_RULE:
            return error.message || "La operación fue rechazada.";
        case CATEGORY.VALIDATION:
            return "Los datos enviados no son válidos.";
        case CATEGORY.CLIENT:
            return error.message || "No se pudo preparar la operación.";
        default:
            return error.message || "Error al operar sobre " + descriptor.label + ".";
    }
}

/* ------------------------------------------------------------------ *
 * mount()
 * ------------------------------------------------------------------ */

/**
 * Monta una instancia del motor.
 *
 * @param {Element} container
 * @param {object}  descriptor
 * @param {object}  [options]
 * @param {number}  [options.pageSize]  por defecto DEFAULT_PAGE_SIZE; la
 *                  composición pasa config.pageSize.
 * @param {Function}[options.can]       can(capacidad) -> boolean. Si no se
 *                  entrega, se permite todo: el motor adapta la presentación,
 *                  nunca es una frontera de seguridad.
 * @param {Function}[options.confirm]   confirmación para acciones peligrosas.
 * @returns {object} controlador de la instancia
 */
export function mount(container, descriptor, options = {}) {
    if (!container || typeof container.appendChild !== "function") {
        throw new CrudError("contenedor inválido: se esperaba un elemento del DOM");
    }
    const spec = validateDescriptor(descriptor);

    const pageSize = Number.isInteger(options.pageSize) && options.pageSize > 0
        ? options.pageSize
        : DEFAULT_PAGE_SIZE;

    // Capacidades declarativas: el motor NO sabe qué es "ADMIN". Solo pregunta.
    const can = typeof options.can === "function" ? options.can : () => true;
    const permits = spec.permits || {};
    const canRead = () => permits.read === undefined || can(permits.read) === true;
    const canWrite = () => permits.write === undefined || can(permits.write) === true;

    const confirmAction = typeof options.confirm === "function"
        ? options.confirm
        : () => true;

    const instanceId = ++instanceCounter;

    const state = {
        content: [],
        page: 0,
        size: pageSize,
        totalElements: 0,
        totalPages: 0,
        last: true,
        search: "",
        sort: spec.defaultSort
            ? { field: spec.defaultSort.field, direction: spec.defaultSort.direction || "asc" }
            : null,
        loading: false,
        error: null,
        selected: null,
        destroyed: false,
        requestSequence: 0,
        submitting: false,
        /**
         * Revisión del estado. La incrementa TODA mutación aplicada con éxito.
         * Una carga guarda la revisión con la que empezó y solo puede aplicarse
         * si nadie mutó mientras viajaba: si no, una lista pedida ANTES de crear
         * un elemento llegaría después y lo haría desaparecer de la pantalla.
         */
        revision: 0,
        /** ¿La lista dejó de reflejar al servidor y conviene recargar a mano? */
        needsReload: false
    };

    /**
     * ORDEN DE LAS MUTACIONES: "última operación INICIADA por identificador".
     *
     * La secuencia se registra AL EMPEZAR, no al aplicar. La diferencia importa:
     * registrar solo lo ya aplicado describe "la última que respondió", y con eso
     * una operación vieja que responde primero se aplicaría igualmente, aunque ya
     * hubiera otra más nueva en vuelo para el mismo elemento. En pantalla se vería el
     * valor viejo pisando al nuevo, aunque fuese un instante.
     *
     * Con esta política, en cuanto arranca una operación para un id, cualquier
     * respuesta —éxito O error— de una operación anterior sobre ese mismo id
     * queda descartada sin tocar nada: ni contenido, ni totales, ni `revision`,
     * ni `needsReload`, ni `error`, ni formulario, ni DOM.
     *
     * Es identidad POR ID y no una secuencia global porque dos mutaciones sobre
     * elementos distintos no compiten entre sí: ordenarlas mutuamente descartaría
     * resultados perfectamente válidos.
     *
     * LIMITACIÓN DECLARADA DE create(): su identificador solo existe cuando llega
     * el 201, así que no puede registrarse al empezar y NO participa de este
     * orden. No se inventa una identidad antes de conocerla. Dos creaciones
     * concurrentes no compiten —producen recursos distintos—, así que la ausencia
     * de orden no las afecta. Lo que sí se protege: una creación cuya respuesta
     * llega tras destroy() no toca nada, y si al conocer el id resulta que ese
     * elemento ya tenía una operación iniciada, la creación no se integra y se
     * marca `needsReload` en vez de competir a ciegas con ella.
     */
    let mutationSequence = 0;
    const lastStartedMutation = new Map();

    /** Registra esta operación como la última iniciada para ese id. */
    function beginMutation(id) {
        const sequence = ++mutationSequence;
        lastStartedMutation.set(String(id), sequence);
        return sequence;
    }

    /** ¿Sigue siendo la última iniciada, o ya arrancó otra para el mismo id? */
    function isLatestStarted(id, sequence) {
        return lastStartedMutation.get(String(id)) === sequence;
    }

    /** Toda mutación aplicada invalida las cargas que empezaron antes de ella. */
    function bumpRevision() {
        state.revision += 1;
    }

    /* ------------------------------ DOM ------------------------------ */

    const root = document.createElement("section");
    root.className = "crud";
    root.dataset.crud = spec.key;
    root.dataset.instance = String(instanceId);

    const heading = document.createElement("h2");
    heading.className = "crud__title";
    heading.textContent = spec.label;
    root.appendChild(heading);

    const toolbar = document.createElement("div");
    toolbar.className = "crud__toolbar";
    root.appendChild(toolbar);

    let searchInput = null;
    if (spec.search) {
        const searchId = "crud-search-" + instanceId;
        const searchLabel = document.createElement("label");
        searchLabel.className = "crud__search-label";
        searchLabel.htmlFor = searchId;
        searchLabel.textContent = spec.search.placeholder || "Buscar";

        searchInput = document.createElement("input");
        searchInput.id = searchId;
        searchInput.type = "search";
        searchInput.className = "crud__search";

        toolbar.appendChild(searchLabel);
        toolbar.appendChild(searchInput);
    }

    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.className = "crud__create";
    createButton.textContent = "Nuevo";
    toolbar.appendChild(createButton);

    /** Región de estado y errores generales, anunciada sin interrumpir. */
    const status = document.createElement("div");
    status.className = "crud__status";
    status.setAttribute("aria-live", "polite");
    root.appendChild(status);

    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "crud__retry";
    retryButton.textContent = "Reintentar";
    retryButton.hidden = true;
    root.appendChild(retryButton);

    const formHost = document.createElement("div");
    formHost.className = "crud__form-host";
    root.appendChild(formHost);

    const tableHost = document.createElement("div");
    tableHost.className = "crud__table-host";
    root.appendChild(tableHost);

    const pagerHost = document.createElement("div");
    pagerHost.className = "crud__pager-host";
    root.appendChild(pagerHost);

    container.appendChild(root);

    /* --------------------------- Submódulos --------------------------- */

    const form = createForm(formHost, spec, {
        onSubmit: () => submitForm(),
        onCancel: () => closeForm()
    });
    form.setEnabled(false);

    const table = createTable(tableHost, spec, {
        onSort: (field) => setSort(field),
        onEdit: (record) => openForm(record),
        onDelete: (record) => remove(record[spec.idField])
    });

    const pager = createPager(pagerHost, {
        onNavigate: (page) => load(page)
    });

    const handleSearch = () => {
        state.search = searchInput ? searchInput.value.trim() : "";
        load(0);
    };
    if (searchInput) {
        // Sin debounce en este commit: llega con el commit de interacción.
        searchInput.addEventListener("change", handleSearch);
    }
    const handleCreate = () => openForm(null);
    createButton.addEventListener("click", handleCreate);
    const handleRetry = () => load(state.page);
    retryButton.addEventListener("click", handleRetry);

    /* ---------------------------- Render ------------------------------ */

    function render() {
        if (state.destroyed) return;
        const writable = canWrite();

        createButton.hidden = !writable;

        table.render({
            content: state.content,
            loading: state.loading,
            sort: state.sort,
            canWrite: writable
        });
        pager.render({
            page: state.page,
            size: state.size,
            totalElements: state.totalElements,
            totalPages: state.totalPages,
            last: state.last,
            loading: state.loading
        });

        status.textContent = "";
        delete status.dataset.requestId;
        delete status.dataset.category;
        retryButton.hidden = true;

        if (state.loading) {
            status.textContent = "Cargando " + spec.label + "…";
            return;
        }
        if (state.error) {
            status.dataset.category = String(state.error.category);
            const line = document.createElement("p");
            line.className = "crud__error";
            line.textContent = describeError(state.error, spec);
            status.appendChild(line);
            if (state.error.requestId) {
                // El identificador de correlación se muestra para que un
                // incidente sea rastreable en los logs del backend.
                status.dataset.requestId = state.error.requestId;
                const trace = document.createElement("p");
                trace.className = "crud__error-trace";
                trace.textContent = "Referencia: " + state.error.requestId;
                status.appendChild(trace);
            }
            // Reintento MANUAL. Nunca automático: un backend caído no debe
            // recibir un bucle de reintentos desde cada cliente (ADR-F03).
            retryButton.hidden = false;
        }
    }

    /* ----------------------------- Carga ------------------------------ */

    /** ¿Esta respuesta sigue siendo la vigente? */
    function isCurrent(sequence) {
        return !state.destroyed && sequence === state.requestSequence;
    }

    function buildQuery() {
        const query = { page: state.page, size: state.size };
        if (state.sort) {
            query.sort = state.sort.field + "," + state.sort.direction;
        }
        // Una búsqueda vacía NO se envía: "sin filtro" y "filtrar por cadena
        // vacía" no son lo mismo, y el backend trata el parámetro ausente como
        // listar todo.
        if (spec.search && state.search !== "") {
            query[spec.search.queryParam] = state.search;
        }
        return query;
    }

    async function load(targetPage = state.page) {
        if (state.destroyed) return null;

        if (!canRead()) {
            // Sin permiso de lectura no se hace la petición: se presenta el
            // estado restringido. El backend sigue siendo la frontera real.
            state.loading = false;
            state.content = [];
            state.error = {
                category: CATEGORY.FORBIDDEN, code: null, message: null, detail: null,
                requestId: null, httpStatus: null, retryable: false,
                violationsByField: {}, generalViolations: []
            };
            render();
            return null;
        }

        const requested = Math.max(0, Number(targetPage) || 0);
        state.page = requested;
        // Secuencia monotónica: identidad de ESTA carga.
        const sequence = ++state.requestSequence;
        // Revisión con la que empieza: si una mutación se aplica mientras esta
        // carga viaja, su resultado ya no describe el estado y se descarta.
        const revisionAtStart = state.revision;
        state.loading = true;
        state.error = null;
        render();

        try {
            const response = await get(spec.path, { query: buildQuery() });
            // Solo la carga vigente puede tocar estado o DOM. Una búsqueda vieja
            // que responde después de una nueva no puede pisarla, y una respuesta
            // posterior a destroy() no pinta nada.
            if (!isCurrent(sequence)) return null;
            // Y tampoco puede aplicarse si mientras tanto hubo una mutación: el
            // elemento recién creado, actualizado o eliminado no debe reaparecer
            // ni desaparecer porque llegue tarde una lista pedida antes.
            if (state.revision !== revisionAtStart) {
                state.needsReload = true;
                return null;
            }

            const page = readPage(response.data);
            if (!page) {
                state.error = {
                    category: CATEGORY.CLIENT, code: null,
                    message: "La respuesta del listado no tiene la forma esperada",
                    detail: "PageResponse inválido", requestId: response.requestId,
                    httpStatus: null, retryable: false,
                    violationsByField: {}, generalViolations: []
                };
                // No se inventan contenido ni totales: se conserva lo último útil.
                return null;
            }

            state.content = page.content;
            state.page = page.page;
            state.size = page.size;
            state.totalElements = page.totalElements;
            state.totalPages = page.totalPages;
            state.last = page.last;
            state.needsReload = false;
            return page;
        } catch (cause) {
            // Un error viejo tampoco puede sustituir un resultado más reciente,
            // ni ocultar el resultado de una mutación posterior.
            if (!isCurrent(sequence) || state.revision !== revisionAtStart) return null;
            state.error = toViewError(cause);
            // El contenido anterior se conserva: un error no debe producir una
            // pantalla en blanco si todavía hay algo utilizable en pantalla.
            return null;
        } finally {
            if (isCurrent(sequence)) {
                state.loading = false;
                render();
            }
        }
    }

    /* --------------------------- Ordenamiento -------------------------- */

    /**
     * Solo se ordena por campos declarados `sortable:true`. Un valor arbitrario
     * de la UI nunca puede convertirse en el parámetro `sort`: llegaría al
     * backend y produciría un fallo del lado del servidor por un dato del cliente.
     */
    function setSort(field) {
        if (!isSortable(spec, field)) {
            throw new CrudError("campo no ordenable: " + String(field));
        }
        const direction = state.sort && state.sort.field === field && state.sort.direction === "asc"
            ? "desc"
            : "asc";
        state.sort = { field, direction };
        return load(0);
    }

    /* ---------------------------- Mutaciones --------------------------- */

    function openForm(record) {
        if (!canWrite()) return;
        state.selected = record ? record[spec.idField] : null;
        form.clearErrors();
        form.setValues(record || {});
        form.setEnabled(true);
    }

    function closeForm() {
        state.selected = null;
        form.clearErrors();
        form.setEnabled(false);
    }

    async function submitForm() {
        // Doble envío bloqueado mientras la operación está en vuelo.
        if (state.submitting || state.destroyed) return null;
        const check = form.validate();
        if (!check.valid) return null;

        const values = form.getValues();
        const id = state.selected;
        state.submitting = true;
        form.setSubmitting(true);
        try {
            const saved = id === null || id === undefined
                ? await create(values)
                : await update(id, values);
            if (saved) closeForm();
            return saved;
        } finally {
            state.submitting = false;
            form.setSubmitting(false);
        }
    }

    /**
     * Deja `page`, `totalPages`, `last` y `content` describiendo un estado
     * internamente posible después de una mutación.
     *
     * Devuelve la página a la que hay que ir si la actual dejó de existir, o
     * null si el estado ya es coherente. No lanza peticiones por su cuenta: la
     * decisión de abandonar una página inexistente ya estaba tomada y es la única
     * carga que una mutación puede provocar.
     */
    function normalizePagination() {
        state.totalElements = Math.max(0, state.totalElements);
        state.totalPages = state.totalElements === 0
            ? 0
            : Math.max(1, Math.ceil(state.totalElements / Math.max(state.size, 1)));

        if (state.totalPages === 0) {
            // Colección vacía: el único estado posible.
            state.page = 0;
            state.content = [];
            state.last = true;
            return null;
        }
        if (state.page >= state.totalPages) {
            // La página actual dejó de existir: hay que ir a la última que queda.
            return state.totalPages - 1;
        }
        state.last = state.page === state.totalPages - 1;
        return null;
    }

    /**
     * Identidad utilizable, o null.
     *
     * Un identificador sirve para dos cosas: emparejar filas y construir rutas.
     * `null`, `undefined` y la cadena vacía no sirven para ninguna de las dos, y
     * aceptarlos produciría una fila que no se puede volver a editar y una ruta
     * como `/api/…/`. Genérico: no sabe qué recurso identifica.
     */
    function readIdentity(record) {
        if (!record || typeof record !== "object") return null;
        const value = record[spec.idField];
        if (value === null || value === undefined) return null;
        if (typeof value === "string" && value.trim() === "") return null;
        return value;
    }

    /**
     * ¿Dos identificadores designan el mismo elemento?
     *
     * Se comparan por su forma textual, así que un id numérico `1` y su
     * representación `"1"` se aceptan como el mismo —es la equivalencia habitual
     * al serializar JSON—, pero `1` y `2` no. No se acepta nada más laxo: dos
     * valores realmente distintos son elementos distintos.
     */
    function sameIdentity(a, b) {
        return String(a) === String(b);
    }

    /**
     * Error LOCAL del cliente, con el `requestId` de la respuesta que lo provocó.
     *
     * Existe porque `toViewError()` solo puede recuperar el identificador de
     * correlación cuando el fallo viene envuelto en un HttpError; aquí el fallo
     * lo detecta el motor sobre una respuesta que HTTP consideró exitosa, y ese
     * identificador es igual de necesario para rastrear el incidente.
     */
    function clientError(message, requestId = null) {
        return {
            category: CATEGORY.CLIENT,
            code: null,
            message,
            detail: null,
            requestId: requestId || null,
            httpStatus: null,
            retryable: false,
            violationsByField: {},
            generalViolations: []
        };
    }

    /** Ruta de un elemento, con el identificador codificado. */
    function itemPath(id) {
        return spec.path + "/" + encodeURIComponent(String(id));
    }

    function applyMutationError(cause) {
        const error = toViewError(cause);
        if (error.category === CATEGORY.BUSINESS_RULE) {
            // 422: las violaciones se pintan en el formulario, campo por campo,
            // con el mensaje del backend. El motor NO interpreta `rule`.
            form.showViolations(error);
        }
        state.error = error;
        render();
        return null;
    }

    /**
     * POLÍTICA DE INTEGRACIÓN DEL 201
     * -------------------------------
     * El 201 trae el recurso completo, así que NUNCA se vuelve a pedir la lista.
     * Lo que sí varía es cuánto puede afirmar el motor sobre la página:
     *
     * 1. CON BÚSQUEDA ACTIVA — no se toca nada del listado. El motor es genérico:
     *    no sabe si el recurso recién creado pertenece al resultado filtrado, y
     *    para saberlo tendría que evaluar el filtro del backend, que es
     *    exactamente lo que no puede hacer. Sumar 1 a `totalElements` sería
     *    afirmar una pertenencia desconocida. Se marca `needsReload`.
     *
     * 2. SIN BÚSQUEDA, CON SITIO EN LA PÁGINA — se suma al total (el recurso sí
     *    pertenece a la colección) y se anexa al final para que quien lo creó lo
     *    vea. Si hay un ORDEN activo, esa posición no es la que el servidor daría:
     *    se anexa igualmente, porque ver la creación vale más que una lista
     *    perfectamente ordenada, pero se marca `needsReload` para no presentar
     *    como autoritativa una posición que el motor no puede reproducir.
     *
     * 3. SIN BÚSQUEDA, PÁGINA LLENA — se suma al total, NO se inserta —produciría
     *    una página con más filas de las que declara— y NO se expulsa a nadie para
     *    hacerle sitio: cuál sobra depende del orden del servidor. Se marca
     *    `needsReload`.
     *
     * En ningún caso hay GET automático.
     */
    async function create(values) {
        if (!canWrite()) return null;
        try {
            const response = await post(spec.path, { body: values });
            if (state.destroyed) return null;

            const created = response.data;
            const id = readIdentity(created);

            // EL 201 CONFIRMA EL EFECTO REMOTO. Ocurrió una creación en el
            // servidor, y eso es cierto con independencia de que su
            // representación sea o no integrable. Por tanto la colección remota
            // cambió y toda carga iniciada ANTES de este POST queda invalidada.
            // El incremento va aquí, una sola vez y antes de cualquier rama:
            // repetirlo o saltárselo en alguna son los dos errores que esta
            // colocación evita.
            bumpRevision();

            if (id === null) {
                // Efecto remoto confirmado, representación NO integrable: sin un
                // '<idField>' utilizable no se sabe QUÉ recurso se creó, así que
                // no se puede emparejar una fila ni construir su ruta. Y como no
                // se sabe qué se creó, tampoco se puede afirmar cómo cambió el
                // listado: no se toca `content`, ni `totalElements`, ni
                // `totalPages`, ni `page`, ni `last`. Solo se registra que la
                // vista quedó desfasada y por qué. Nada de inventar un id, y
                // nada de GET automático: la recarga la pide una persona.
                state.needsReload = true;
                state.error = clientError(
                    "la respuesta de creación incumple el contrato: no trae un '" +
                    spec.idField + "' utilizable",
                    response.requestId);
                render();
                return null;
            }

            state.error = null;

            if (lastStartedMutation.has(String(id))) {
                // Ese elemento ya tiene una operación iniciada: esta creación no
                // compite con ella a ciegas, pero la lista sí quedó desfasada.
                state.needsReload = true;
                render();
                return created;
            }

            const already = state.content.some((item) => sameIdentity(item[spec.idField], id));
            if (!already) {
                if (state.search !== "") {
                    state.needsReload = true;          // caso 1
                } else {
                    state.totalElements += 1;
                    if (state.content.length < state.size) {
                        state.content = state.content.concat([created]);   // caso 2
                        if (state.sort) {
                            state.needsReload = true;
                        }
                    } else {
                        state.needsReload = true;      // caso 3
                    }
                    const target = normalizePagination();
                    if (target !== null) {
                        // La página actual dejó de ser válida con los totales
                        // nuevos: se va a la que existe.
                        return load(target).then(() => created);
                    }
                }
            }
            render();
            return created;
        } catch (cause) {
            if (state.destroyed) return null;
            return applyMutationError(cause);
        }
    }

    async function update(id, values) {
        if (!canWrite()) return null;
        // Identidad registrada AL EMPEZAR: desde este instante, cualquier
        // operación anterior sobre este id queda obsoleta.
        const sequence = beginMutation(id);
        try {
            const response = await put(itemPath(id), { body: values });
            if (state.destroyed) return null;
            // Obsoleta si ya arrancó otra operación para este id, responda esta
            // antes o después. Se descarta sin tocar absolutamente nada.
            if (!isLatestStarted(id, sequence)) return null;
            const saved = response.data;
            const savedId = readIdentity(saved);
            if (savedId === null) {
                return applyMutationError(new CrudError(
                    "la respuesta de actualización no trae un '" + spec.idField + "' utilizable"));
            }
            // El backend debe devolver EL MISMO elemento que se pidió actualizar.
            // Si devuelve otro, sustituir la fila cambiaría su identidad en
            // silencio: la fila editada desaparecería y otra ocuparía su sitio.
            // Se conserva la fila anterior, se señala un fallo local y NO se
            // cuenta como mutación confirmada.
            if (!sameIdentity(savedId, id)) {
                return applyMutationError(new CrudError(
                    "la respuesta de actualización corresponde a otro elemento"));
            }
            // Se sustituye con la representación FINAL que devolvió el backend:
            // no se mezclan a mano campos viejos y nuevos. El orden de la página
            // se conserva.
            state.content = state.content.map((item) =>
                sameIdentity(item[spec.idField], id) ? saved : item);
            bumpRevision();
            state.error = null;
            render();
            return saved;
        } catch (cause) {
            // El error de una operación obsoleta NO puede sustituir el resultado
            // ni limpiar el error de la operación posterior sobre el mismo id.
            if (state.destroyed || !isLatestStarted(id, sequence)) return null;
            return applyMutationError(cause);
        }
    }

    async function remove(id) {
        if (!canWrite()) return null;
        if (spec.danger && spec.danger.delete === "confirm") {
            if (confirmAction({ action: "delete", id, descriptor: spec }) !== true) {
                return null;
            }
        }
        const sequence = beginMutation(id);
        try {
            await del(itemPath(id));   // 204: sin cuerpo, no se intenta parsear
            if (state.destroyed) return null;
            if (!isLatestStarted(id, sequence)) return null;

            // El total solo baja si este DELETE es el que retira el elemento. Un
            // segundo DELETE del mismo id, o uno cuyo elemento ya no estaba
            // representado, no tiene evidencia para volver a descontar: hacerlo
            // dejaría un total menor que la colección real.
            const estaba = state.content.some((item) => sameIdentity(item[spec.idField], id));
            if (estaba) {
                state.content = state.content.filter((item) => !sameIdentity(item[spec.idField], id));
                state.totalElements = Math.max(0, state.totalElements - 1);
            } else {
                state.needsReload = true;
            }
            bumpRevision();
            state.error = null;

            const target = normalizePagination();

            /**
             * PROYECCIÓN OPTIMISTA E INCOMPLETA, dicho sin adornos.
             *
             * Al retirar una fila queda un hueco que el servidor llenaría con el
             * primer elemento de la página siguiente. El motor no lo tiene: solo
             * conoce la página que cargó. Así que si esta página debería mostrar
             * más elementos de los que quedan, el contenido es una aproximación
             * —le falta una fila— aunque `totalElements`, `totalPages` y `last`
             * ya estén recalculados y sean correctos.
             *
             * Se marca `needsReload` para que la composición ofrezca una recarga
             * MANUAL. No se lanza un GET automático: la única carga que una
             * mutación provoca sigue siendo abandonar una página que dejó de
             * existir, que estaba decidida de antes.
             */
            if (target === null && state.totalPages > 0) {
                const esperados = Math.min(
                    state.size,
                    state.totalElements - state.page * state.size
                );
                if (state.content.length < esperados) {
                    state.needsReload = true;
                }
            }
            if (target !== null && target !== state.page) {
                // La página actual dejó de existir. Es la ÚNICA carga que una
                // mutación puede provocar, y estaba decidida de antes.
                return load(target);
            }
            if (state.content.length === 0 && state.page > 0) {
                return load(state.page - 1);
            }
            render();
            return true;
        } catch (cause) {
            if (state.destroyed || !isLatestStarted(id, sequence)) return null;
            return applyMutationError(cause);
        }
    }

    /* ------------------------------ Estado ----------------------------- */

    /**
     * Copia defensiva: quien la reciba puede inspeccionarla y hasta mutarla sin
     * que eso altere el estado interno del motor.
     */
    function getState() {
        return {
            ...state,
            content: state.content.map((item) => ({ ...item })),
            sort: state.sort ? { ...state.sort } : null,
            error: state.error ? { ...state.error } : null
        };
    }

    let destroyed = false;

    function destroy() {
        if (destroyed) return;      // idempotente: llamarlo dos veces no lanza
        destroyed = true;
        state.destroyed = true;
        // `loading` se apaga explícitamente: si quedara en true, getState()
        // describiría para siempre una operación en curso que ya nadie atiende.
        state.loading = false;
        // Invalida toda respuesta pendiente: ninguna podrá pintar ni escribir.
        state.requestSequence += 1;
        if (searchInput) searchInput.removeEventListener("change", handleSearch);
        createButton.removeEventListener("click", handleCreate);
        retryButton.removeEventListener("click", handleRetry);
        table.destroy();
        form.destroy();
        pager.destroy();
        if (root.parentNode) {
            // El contenedor queda como estaba: el motor retira lo que montó.
            root.parentNode.removeChild(root);
        }
    }

    render();

    // Carga inicial. Se dispara al montar, sin bloquear: mount() es síncrono y
    // devuelve el controlador de inmediato. Quien necesite esperar la primera
    // página tiene la promesa en `ready`.
    const ready = load(0);

    return {
        element: root,
        descriptor: spec,
        ready,
        load,
        reload: () => load(state.page),
        setSearch: (value) => { state.search = String(value || "").trim(); return load(0); },
        setSort,
        openForm,
        closeForm,
        submitForm,
        // Accesos al formulario para la composición y las pruebas. El motor
        // sigue siendo quien decide CUÁNDO presentar violaciones (solo ante la
        // categoría de reglas de negocio); esto solo expone el CÓMO.
        showFormViolations: (model) => form.showViolations(model),
        setFormSubmitting: (value) => form.setSubmitting(value),
        create,
        update,
        remove,
        getState,
        destroy
    };
}
