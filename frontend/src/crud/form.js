/**
 * frontend/src/crud/form.js — Formulario genérico generado desde el descriptor.
 *
 * VALIDACIÓN: SOLO ESTRUCTURAL
 * ----------------------------
 * Este módulo comprueba únicamente que el dato EXISTA y TENGA LA FORMA correcta:
 * obligatoriedad, longitud máxima, que un número sea un número y que una fecha
 * sea interpretable. Nada más.
 *
 * Está PROHIBIDO implementar aquí reglas de negocio —precio mayor que cero,
 * stock no negativo, unicidad, cualquier límite semántico—. Esas reglas viven en
 * el motor del backend, pueden activarse y desactivarse con *feature toggles*, y
 * llegan al cliente como `422` con violaciones por campo. Una copia en el cliente
 * sería una segunda fuente de verdad capaz de rechazar una operación que el
 * servidor acepta, y el defecto sería invisible desde el backend.
 *
 * Por eso `-5` o `0` se aceptan estructuralmente: son números válidos. Si el
 * negocio los rechaza, lo dirá el `422`.
 *
 * PRESENTACIÓN DE VIOLACIONES
 * ---------------------------
 * Se muestran TODAS las violaciones de cada campo, con el `message` que envió el
 * backend, sin reescribirlo ni ampliarlo. El identificador `violation.rule` se
 * conserva como dato de diagnóstico y NUNCA se ramifica sobre él: el formulario
 * no sabe —ni debe saber— qué significa una regla concreta.
 *
 * No habla HTTP: recibe y devuelve datos por callback.
 */

const SUPPORTED_TYPES = ["text", "decimal", "integer", "boolean", "datetime"];

let instanceCounter = 0;

function inputTypeFor(type) {
    switch (type) {
        case "boolean": return "checkbox";
        case "integer": return "number";
        case "decimal": return "number";
        case "datetime": return "datetime-local";
        default: return "text";
    }
}

/** Valor de dominio -> valor que entiende el control del DOM. */
function toInputValue(value, type) {
    if (value === null || value === undefined) {
        return type === "boolean" ? false : "";
    }
    if (type === "boolean") {
        return value === true;
    }
    if (type === "datetime") {
        const parsed = Date.parse(value);
        if (!Number.isFinite(parsed)) {
            return "";
        }
        // `datetime-local` no admite zona ni milisegundos.
        return new Date(parsed).toISOString().slice(0, 16);
    }
    return String(value);
}

export function createForm(container, descriptor, callbacks = {}) {
    /**
     * Igual que en la tabla y el paginador: una referencia guardada al botón
     * seguiría disparando el callback después de destruir. La bandera lo corta.
     */
    let destroyed = false;
    /** ¿El formulario está abierto? Un formulario cerrado no envía nada. */
    let enabled = false;
    let submitting = false;

    const rawSubmit = typeof callbacks.onSubmit === "function" ? callbacks.onSubmit : () => {};
    const rawCancel = typeof callbacks.onCancel === "function" ? callbacks.onCancel : () => {};
    const onSubmit = () => { if (!destroyed && enabled) rawSubmit(); };
    const onCancel = () => { if (!destroyed && enabled) rawCancel(); };

    // Los campos de solo lectura no se editan: id, fechas de auditoría y todo lo
    // que el backend ignora aunque se envíe.
    const editable = descriptor.fields.filter((field) => field.readOnly !== true);
    const uid = "crud-form-" + (++instanceCounter);

    const form = document.createElement("form");
    form.className = "crud-form";
    form.noValidate = true;   // la validación estructural la hacemos nosotros

    const legend = document.createElement("p");
    legend.className = "crud-form__legend";
    legend.textContent = descriptor.singularLabel;
    form.appendChild(legend);

    /** Región de errores generales: violaciones sin campo y avisos del formulario. */
    const generalErrors = document.createElement("div");
    generalErrors.className = "crud-form__general-errors";
    generalErrors.setAttribute("aria-live", "polite");
    form.appendChild(generalErrors);

    const controls = new Map();

    for (const field of editable) {
        const wrapper = document.createElement("div");
        wrapper.className = "crud-form__field";

        const inputId = uid + "-" + field.name;
        const errorId = inputId + "-error";

        const label = document.createElement("label");
        label.className = "crud-form__label";
        // Asociación explícita: sin esto el lector de pantalla no relaciona
        // etiqueta y control, y pulsar el texto no enfoca el campo.
        label.htmlFor = inputId;
        label.textContent = field.label;

        const input = document.createElement("input");
        input.id = inputId;
        input.name = field.name;
        input.className = "crud-form__input";
        input.type = inputTypeFor(field.type);
        if (field.type === "decimal") {
            input.step = "any";
        }
        if (field.type === "integer") {
            input.step = "1";
        }
        if (Number.isInteger(field.maxLength) && field.type === "text") {
            input.maxLength = field.maxLength;
        }
        if (field.required === true) {
            input.setAttribute("aria-required", "true");
        }

        const errors = document.createElement("ul");
        errors.className = "crud-form__errors";
        errors.id = errorId;
        errors.hidden = true;

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        wrapper.appendChild(errors);
        form.appendChild(wrapper);

        controls.set(field.name, { field, input, errors, errorId });
    }

    const actions = document.createElement("div");
    actions.className = "crud-form__actions";

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "crud-form__submit";
    submit.textContent = "Guardar";

    const cancel = document.createElement("button");
    cancel.type = "button";           // no es submit: no debe enviar el formulario
    cancel.className = "crud-form__cancel";
    cancel.textContent = "Cancelar";

    actions.appendChild(submit);
    actions.appendChild(cancel);
    form.appendChild(actions);

    container.appendChild(form);

    const handleSubmit = (event) => {
        event.preventDefault();
        onSubmit();
    };
    const handleCancel = () => onCancel();
    form.addEventListener("submit", handleSubmit);
    cancel.addEventListener("click", handleCancel);

    /* ---------------------------------------------------------------- *
     * API pública
     * ---------------------------------------------------------------- */

    function setValues(values = {}) {
        for (const [name, control] of controls) {
            const value = toInputValue(values[name], control.field.type);
            if (control.field.type === "boolean") {
                control.input.checked = value === true;
            } else {
                control.input.value = value;
            }
        }
    }

    /**
     * Valores ya convertidos al tipo declarado. No valida: eso es validate().
     *
     * Solo devuelve los campos EDITABLES: los `readOnly` no se envían nunca,
     * porque el backend los ignora y enviarlos sugeriría que el cliente puede
     * fijar un id o una fecha de auditoría.
     *
     * POLÍTICA DE VACÍOS: un número opcional vacío viaja como `null`, nunca como
     * `0`. Cero es un valor con significado y convertir "no lo puse" en "puse
     * cero" es inventar un dato.
     *
     * POLÍTICA DE FECHAS: `datetime-local` entrega una hora de pared SIN zona.
     * Se interpreta en la zona local del navegador —que es lo único que se
     * puede saber— y se serializa a ISO-8601 en UTC. No se afirma una zona que
     * el control no proporciona: se documenta la que se asume.
     */
    function getValues() {
        const values = {};
        for (const [name, { field, input }] of controls) {
            if (field.type === "boolean") {
                values[name] = input.checked === true;
            } else if (field.type === "integer" || field.type === "decimal") {
                const raw = input.value.trim();
                values[name] = raw === "" ? null : Number(raw);
            } else if (field.type === "datetime") {
                const raw = input.value.trim();
                const parsed = raw === "" ? NaN : Date.parse(raw);
                values[name] = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
            } else {
                values[name] = input.value;
            }
        }
        return values;
    }

    /**
     * Validación ESTRUCTURAL y nada más. Devuelve el resultado y, además, lo
     * presenta: obligatoriedad, longitud máxima, número interpretable y fecha
     * interpretable. Ninguna comprobación semántica.
     */
    function validate() {
        const problems = {};
        for (const [name, { field, input }] of controls) {
            const messages = [];
            const raw = field.type === "boolean" ? String(input.checked) : input.value.trim();

            if (field.required === true && field.type !== "boolean" && raw === "") {
                messages.push("Este campo es obligatorio");
            }
            if (field.type === "text" && Number.isInteger(field.maxLength) && raw.length > field.maxLength) {
                messages.push("No puede exceder " + field.maxLength + " caracteres");
            }
            if ((field.type === "integer" || field.type === "decimal") && raw !== "") {
                const numeric = Number(raw);
                if (!Number.isFinite(numeric)) {
                    messages.push("Debe ser un número");
                } else if (field.type === "integer" && !Number.isInteger(numeric)) {
                    messages.push("Debe ser un número entero");
                }
            }
            if (field.type === "datetime" && raw !== "" && !Number.isFinite(Date.parse(raw))) {
                messages.push("Debe ser una fecha válida");
            }

            if (messages.length > 0) {
                problems[name] = messages.map((message) => ({ rule: null, field: name, message }));
            }
        }

        const valid = Object.keys(problems).length === 0;
        showViolations({ violationsByField: problems, generalViolations: [], requestId: null });
        return { valid, errors: problems };
    }

    /**
     * Pinta las violaciones del modelo normalizado de errores.
     *
     * Acepta tal cual `violationsByField` y `generalViolations`. Muestra TODAS
     * las de cada campo y usa el `message` del backend sin tocarlo. `rule` se
     * conserva en un atributo de datos para diagnóstico y no se interpreta.
     */
    function showViolations(model = {}) {
        clearErrors();
        const byField = model.violationsByField && typeof model.violationsByField === "object"
            ? model.violationsByField
            : {};
        // COPIA LOCAL. El modelo normalizado que entrega la plataforma es de
        // quien lo produjo: mutar su `generalViolations` para acumular ahí las
        // violaciones de campos no visibles lo contaminaría, y una segunda
        // presentación del MISMO modelo mostraría los mensajes duplicados. Aquí
        // no se toca ni el modelo, ni sus arreglos, ni los objetos de violación.
        const general = Array.isArray(model.generalViolations)
            ? model.generalViolations.slice()
            : [];

        for (const [name, violations] of Object.entries(byField)) {
            const control = controls.get(name);
            const list = Array.isArray(violations) ? violations : [violations];
            if (!control || list.length === 0) {
                // Violación de un campo que este formulario no muestra: se
                // presenta como general SOLO en esta vista local.
                general.push(...list);
                continue;
            }
            control.input.setAttribute("aria-invalid", "true");
            control.input.setAttribute("aria-describedby", control.errorId);
            control.errors.hidden = false;
            for (const violation of list) {
                const item = document.createElement("li");
                item.className = "crud-form__error";
                if (violation && typeof violation.rule === "string") {
                    item.dataset.rule = violation.rule;   // diagnóstico, no lógica
                }
                item.textContent = violation && violation.message ? violation.message : "Valor inválido";
                control.errors.appendChild(item);
            }
        }

        if (general.length > 0 || (model.requestId && Object.keys(byField).length === 0)) {
            for (const violation of general) {
                const item = document.createElement("p");
                item.className = "crud-form__general-error";
                if (violation && typeof violation.rule === "string") {
                    item.dataset.rule = violation.rule;
                }
                item.textContent = violation && violation.message ? violation.message : "Operación rechazada";
                generalErrors.appendChild(item);
            }
        }

        if (typeof model.requestId === "string" && model.requestId !== "") {
            // Se conserva para diagnóstico: permite cruzar el rechazo con los
            // logs del backend sin pedir que se reproduzca el incidente.
            generalErrors.dataset.requestId = model.requestId;
        }
    }

    function clearErrors() {
        generalErrors.textContent = "";
        delete generalErrors.dataset.requestId;
        for (const { input, errors } of controls.values()) {
            input.removeAttribute("aria-invalid");
            input.removeAttribute("aria-describedby");
            errors.textContent = "";
            errors.hidden = true;
        }
    }

    /**
     * Los botones están bloqueados si el formulario está destruido, cerrado, o
     * con una operación en vuelo. Por eso `setSubmitting(false)` NO reactiva un
     * formulario que ya se cerró o se destruyó: liberar el bloqueo de envío no es
     * lo mismo que volver a abrirlo.
     */
    function applyButtonState() {
        const blocked = destroyed || !enabled || submitting;
        submit.disabled = blocked;
        cancel.disabled = blocked;
        form.dataset.submitting = submitting ? "true" : "false";
    }

    /** Bloquea el envío mientras la operación está en vuelo (anti doble submit). */
    function setSubmitting(value) {
        submitting = value === true;
        applyButtonState();
    }

    function setEnabled(value) {
        enabled = value === true && !destroyed;
        form.hidden = !enabled;
        applyButtonState();
    }

    function destroy() {
        if (destroyed) return;     // idempotente
        destroyed = true;
        enabled = false;
        applyButtonState();
        form.removeEventListener("submit", handleSubmit);
        cancel.removeEventListener("click", handleCancel);
        controls.clear();
        if (form.parentNode) {
            form.parentNode.removeChild(form);
        }
    }

    return {
        element: form,
        supportedTypes: SUPPORTED_TYPES.slice(),
        setValues,
        getValues,
        validate,
        showViolations,
        clearErrors,
        setSubmitting,
        setEnabled,
        destroy
    };
}
