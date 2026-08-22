/**
 * frontend/src/crud/pager.js — Paginador genérico.
 *
 * Consume EXCLUSIVAMENTE los seis campos del contrato de página:
 *
 *     content · page · size · totalElements · totalPages · last
 *
 * No conoce rutas, ni recursos, ni HTTP: emite callbacks de navegación y el
 * motor decide qué hacer. Deliberadamente NO lee campos internos del `Page` de
 * Spring (`pageable`, `numberOfElements`, `sort`): esos pueden cambiar entre
 * versiones del framework y el backend expone un tipo propio justamente para
 * que el frontend no dependa de ellos.
 */

/** Índice de página seguro: nunca negativo, nunca NaN. */
function safePage(value) {
    const page = Number(value);
    return Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;
}

function safeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * @param {Element} container
 * @param {object}  callbacks  { onNavigate(page) }
 * @returns {{ element: Element, render: Function, destroy: Function }}
 */
export function createPager(container, callbacks = {}) {
    /** Igual que en la tabla: quitar el nodo no desactiva una referencia guardada. */
    let destroyed = false;
    const rawNavigate = typeof callbacks.onNavigate === "function" ? callbacks.onNavigate : () => {};
    const onNavigate = (page) => {
        if (destroyed) return;
        rawNavigate(page);
    };

    const nav = document.createElement("nav");
    nav.className = "crud-pager";
    nav.setAttribute("aria-label", "Paginación");

    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "crud-pager__previous";
    previous.textContent = "Anterior";

    const status = document.createElement("p");
    status.className = "crud-pager__status";
    // El estado de página cambia sin recargar: se anuncia de forma no intrusiva.
    status.setAttribute("aria-live", "polite");

    const next = document.createElement("button");
    next.type = "button";
    next.className = "crud-pager__next";
    next.textContent = "Siguiente";

    nav.appendChild(previous);
    nav.appendChild(status);
    nav.appendChild(next);
    container.appendChild(nav);

    let current = { page: 0, totalPages: 0, last: true };

    previous.addEventListener("click", () => {
        const target = current.page - 1;
        if (target >= 0) {
            onNavigate(target);
        }
    });

    next.addEventListener("click", () => {
        // Se navega solo si de verdad hay una página siguiente. Con `last:true`
        // el botón ya está deshabilitado, pero la comprobación se repite aquí
        // para que un clic programático tampoco produzca una página inexistente.
        if (!current.last && current.page + 1 < current.totalPages) {
            onNavigate(current.page + 1);
        }
    });

    function render(view = {}) {
        if (destroyed) return;
        const page = safePage(view.page);
        const totalPages = safeCount(view.totalPages);
        const totalElements = safeCount(view.totalElements);
        // `last` se respeta si viene declarado; si no, se deduce de los índices.
        const last = view.last === true || totalPages === 0 || page + 1 >= totalPages;

        current = { page, totalPages, last };

        previous.disabled = page <= 0 || view.loading === true;
        next.disabled = last || view.loading === true;

        if (totalElements === 0) {
            status.textContent = "Sin elementos";
        } else {
            status.textContent = "Página " + (page + 1) + " de " + Math.max(totalPages, 1) +
                " · " + totalElements + " elementos";
        }
    }

    function destroy() {
        if (destroyed) return;     // idempotente
        destroyed = true;
        if (nav.parentNode) {
            nav.parentNode.removeChild(nav);
        }
    }

    return { element: nav, render, destroy };
}
