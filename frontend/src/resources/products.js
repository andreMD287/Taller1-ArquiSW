/**
 * frontend/src/resources/products.js — Descriptor del recurso "productos".
 *
 * QUÉ ES ESTO
 * -----------
 * DATOS, no comportamiento. Este archivo describe un recurso y nada más: no
 * llama a `fetch`, no toca el DOM, no genera HTML, no consulta la sesión, no
 * decide permisos y no implementa ninguna regla de negocio. El motor genérico de
 * `crud/` lo recibe por parámetro y hace todo el trabajo (ADR-F01).
 *
 * Es lo que hace barato agregar un recurso: se escribe un descriptor como este
 * y se registra. Ningún archivo de `crud/` ni de `platform/` cambia.
 *
 * CORRESPONDENCIA CON EL BACKEND
 * ------------------------------
 * Los campos reflejan `ProductResponse` —id, name, price, stock, active,
 * createdAt— y los editables reflejan `ProductRequest`, cuyo contrato de entrada
 * es exactamente (name, price, stock).
 *
 * Por eso id, active y createdAt van como `readOnly`: `form.getValues()` omite
 * los campos marcados así, de modo que sencillamente NO SE ENVÍAN. La corrección
 * es del lado del cliente y es deliberada: no se apoya en que Jackson o el
 * backend descarten propiedades sobrantes, porque esa tolerancia es una
 * configuración que puede cambiar y no forma parte del contrato. Enviar campos
 * de salida en una petición de entrada sería, además, prometer una edición que
 * el contrato no ofrece.
 *
 * VALIDACIÓN: SOLO ESTRUCTURAL
 * ----------------------------
 * Aquí se declara lo que el DTO exige por forma —obligatoriedad, tipo y la
 * longitud máxima de 120 caracteres del nombre—. NO se declara `price > 0` ni
 * `stock >= 0`: esas son reglas de NEGOCIO, viven en el motor de reglas del
 * backend, son activables por *feature toggle* y llegan como `422` con
 * violaciones por campo. Copiarlas aquí crearía una segunda fuente de verdad
 * capaz de rechazar una operación que el servidor acepta.
 */

export default {
    key: "products",
    label: "Productos",
    singularLabel: "Producto",
    path: "/api/products",
    idField: "id",

    search: {
        field: "name",
        queryParam: "name",
        placeholder: "Buscar por nombre"
    },

    // El campo tiene que estar declarado como `sortable` para poder ordenarse.
    defaultSort: {
        field: "name",
        direction: "asc"
    },

    // Capacidades declarativas. El motor no sabe qué significan: se las pregunta
    // a la función `can()` que le entrega la composición.
    permits: {
        read: "AUTHENTICATED",
        write: "ADMIN"
    },

    // Modo soportado hoy por el motor. La confirmación escribiendo el nombre
    // llega en un commit posterior.
    danger: {
        delete: "confirm"
    },

    fields: [
        {
            name: "id",
            label: "ID",
            type: "integer",
            readOnly: true,      // lo asigna el backend
            inList: false,
            align: "right"
        },
        {
            name: "name",
            label: "Nombre",
            type: "text",
            required: true,
            maxLength: 120,      // @Size(max = 120) en ProductRequest
            inList: true,
            sortable: true,
            align: "left"
        },
        {
            name: "price",
            label: "Precio",
            type: "decimal",
            required: true,      // @NotNull: solo presencia, no "mayor que cero"
            inList: true,
            sortable: true,
            align: "right"
        },
        {
            name: "stock",
            label: "Stock",
            type: "integer",
            required: true,      // @NotNull: solo presencia, no "no negativo"
            inList: true,
            sortable: true,
            align: "right"
        },
        {
            name: "active",
            label: "Activo",
            type: "boolean",
            readOnly: true,      // solo cambia por el borrado lógico del backend
            inList: true,
            align: "center"
        },
        {
            name: "createdAt",
            label: "Creado",
            type: "datetime",
            readOnly: true,      // auditoría: el cliente no la gobierna
            inList: true,
            sortable: true,
            align: "right"
        }
    ]
};
