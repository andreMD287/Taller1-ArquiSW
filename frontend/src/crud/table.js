/**
 * frontend/src/crud/table.js — Tabla genérica gobernada por un descriptor.
 *
 * No conoce ningún recurso: recibe el descriptor y los datos por parámetro, y
 * devuelve las interacciones por callback. No habla HTTP, no importa nada de
 * `platform/` y no sabe qué es un registro concreto.
 *
 * SEGURIDAD DEL DOM
 * -----------------
 * Todo valor que venga del backend se escribe con `textContent`, NUNCA con
 * `innerHTML`. Un nombre que contenga `<img onerror=...>` debe verse como texto,
 * no ejecutarse. La misma regla vale para las etiquetas del descriptor: aunque
 * hoy las escribimos nosotros, mañana podrían venir de otro sitio.
 *
 * TÁCTICA (Cap. 8): "Abstract Common Services". Una sola implementación de tabla
 * para todos los recursos; agregar uno no la toca.
 */

/** Marcador único para un valor ausente. Consistente en toda la tabla. */
const EMPTY_CELL = "—";

const ALIGNMENTS = ["left", "center", "right"];

/**
 * Formateadores por tipo. `Intl` cuando está disponible —un decimal debe verse
 * como decimal en el idioma de quien lo lee— y una representación simple como
 * respaldo, para que un entorno sin `Intl` degrade a texto legible en vez de
 * romper la tabla.
 */
function formatValue(value, type) {
    if (value === null || value === undefined || value === "") {
        return EMPTY_CELL;
    }
    switch (type) {
        case "boolean":
            return value === true ? "Sí" : "No";
        case "integer":
        case "decimal": {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) {
                return String(value);
            }
            if (typeof Intl === "undefined" || typeof Intl.NumberFormat !== "function") {
                return String(numeric);
            }
            const options = type === "integer"
                ? { maximumFractionDigits: 0 }
                : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
            return new Intl.NumberFormat(undefined, options).format(numeric);
        }
        case "datetime": {
            const parsed = Date.parse(value);
            if (!Number.isFinite(parsed)) {
                return String(value);
            }
            if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
                return new Date(parsed).toISOString();
            }
            return new Intl.DateTimeFormat(undefined, {
                dateStyle: "short",
                timeStyle: "short"
            }).format(new Date(parsed));
        }
        default:
            return String(value);
    }
}

function alignmentClass(align) {
    const chosen = ALIGNMENTS.includes(align) ? align : "left";
    return "crud-cell--" + chosen;
}

/**
 * @param {Element}  container   dónde montarse.
 * @param {object}   descriptor  descriptor ya validado por el motor.
 * @param {object}   callbacks   { onSort(field), onEdit(record), onDelete(record) }
 * @returns {{ element: Element, render: Function, destroy: Function }}
 */
export function createTable(container, descriptor, callbacks = {}) {
    const columns = descriptor.fields.filter((field) => field.inList === true);

    /**
     * Bandera de destrucción comprobada por CADA callback.
     *
     * Quitar el nodo del documento no basta: si otro código guardó una
     * referencia a un botón —una prueba, un fragmento de UI, un `querySelector`
     * anterior— un clic programático seguiría ejecutando el listener y llamando
     * al motor ya destruido. La bandera corta eso en el único sitio donde se
     * puede garantizar: dentro del propio callback.
     */
    let destroyed = false;
    const guard = (handler) => (...args) => {
        if (destroyed) return;
        handler(...args);
    };

    const onSort = guard(typeof callbacks.onSort === "function" ? callbacks.onSort : () => {});
    const onEdit = guard(typeof callbacks.onEdit === "function" ? callbacks.onEdit : () => {});
    const onDelete = guard(typeof callbacks.onDelete === "function" ? callbacks.onDelete : () => {});

    const table = document.createElement("table");
    table.className = "crud-table";

    const caption = document.createElement("caption");
    caption.className = "crud-table__caption";
    caption.textContent = descriptor.label;
    table.appendChild(caption);

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    tbody.className = "crud-table__body";
    table.appendChild(tbody);

    /** Cabeceras. Solo las columnas `sortable:true` reciben botón de orden. */
    const headerButtons = new Map();
    for (const column of columns) {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.className = "crud-table__header " + alignmentClass(column.align);
        if (column.sortable === true) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "crud-table__sort";
            button.textContent = column.label;
            // El nombre viaja como dato del botón, ya validado por el descriptor:
            // la tabla nunca inventa un nombre de campo de ordenamiento.
            button.dataset.field = column.name;
            button.addEventListener("click", () => onSort(column.name));
            headerButtons.set(column.name, { cell, button });
            cell.appendChild(button);
        } else {
            cell.textContent = column.label;
        }
        headRow.appendChild(cell);
    }

    const actionsHeader = document.createElement("th");
    actionsHeader.scope = "col";
    actionsHeader.className = "crud-table__header crud-table__header--actions";
    actionsHeader.textContent = "Acciones";
    headRow.appendChild(actionsHeader);

    container.appendChild(table);

    /** Fila de una sola celda para los estados vacío y cargando. */
    function messageRow(text, modifier) {
        const row = document.createElement("tr");
        row.className = "crud-table__message crud-table__message--" + modifier;
        const cell = document.createElement("td");
        cell.colSpan = columns.length + 1;
        cell.textContent = text;
        row.appendChild(cell);
        return row;
    }

    function render(view = {}) {
        if (destroyed) return;     // una respuesta tardía no puede repintar
        const records = Array.isArray(view.content) ? view.content : [];
        const canWrite = view.canWrite !== false;
        const sort = view.sort || null;

        // Indicador de orden accesible, solo en columnas ordenables.
        for (const [name, { cell }] of headerButtons) {
            const active = sort && sort.field === name;
            cell.setAttribute("aria-sort", active
                ? (sort.direction === "desc" ? "descending" : "ascending")
                : "none");
        }

        actionsHeader.hidden = !canWrite;
        tbody.textContent = "";

        if (view.loading === true) {
            tbody.appendChild(messageRow("Cargando…", "loading"));
            return;
        }
        if (records.length === 0) {
            tbody.appendChild(messageRow("No hay elementos que mostrar.", "empty"));
            return;
        }

        for (const record of records) {
            const row = document.createElement("tr");
            row.className = "crud-table__row";
            row.dataset.id = String(record[descriptor.idField]);

            for (const column of columns) {
                const cell = document.createElement("td");
                cell.className = "crud-table__cell " + alignmentClass(column.align);
                // textContent, nunca innerHTML: el contenido viene del backend.
                cell.textContent = formatValue(record[column.name], column.type);
                row.appendChild(cell);
            }

            const actions = document.createElement("td");
            actions.className = "crud-table__cell crud-table__cell--actions";
            actions.hidden = !canWrite;
            if (canWrite) {
                const edit = document.createElement("button");
                edit.type = "button";
                edit.className = "crud-table__action crud-table__action--edit";
                edit.textContent = "Editar";
                edit.addEventListener("click", () => onEdit(record));

                const remove = document.createElement("button");
                remove.type = "button";
                remove.className = "crud-table__action crud-table__action--delete";
                remove.textContent = "Eliminar";
                remove.addEventListener("click", () => onDelete(record));

                actions.appendChild(edit);
                actions.appendChild(remove);
            }
            row.appendChild(actions);
            tbody.appendChild(row);
        }
    }

    function destroy() {
        if (destroyed) return;     // idempotente
        destroyed = true;
        tbody.textContent = "";
        headerButtons.clear();
        if (table.parentNode) {
            table.parentNode.removeChild(table);
        }
    }

    return { element: table, render, destroy };
}
