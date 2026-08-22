/**
 * frontend/src/resources/index.js — Registro de recursos.
 *
 * La ÚNICA lista de qué recursos existen en la aplicación. Es el punto que
 * cambia al agregar uno: se crea su descriptor y se añade aquí. Nada más.
 *
 * Datos puros: sin HTTP, sin autenticación, sin DOM. La composición recorre este
 * registro sin conocer el detalle de ningún recurso concreto, así que el día que
 * haya un segundo la navegación funciona igual, sin casos especiales.
 */

import products from "./products.js";

/** Recursos en el orden en que deben aparecer en la navegación. */
export const resources = Object.freeze([products]);

/** Busca un recurso por su `key`. Devuelve null si no existe. */
export function findResource(key) {
    return resources.find((resource) => resource.key === key) || null;
}

export default resources;
