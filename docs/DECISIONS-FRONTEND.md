# Decisiones arquitectónicas — Rol 3 (Frontend / Tier de presentación)

Taller 2 — Arquitectura de Software. Base teórica: Bass, Clements & Kazman,
*Software Architecture in Practice*, 4a ed., Cap. 8 (Modificabilidad).

Este archivo es el equivalente, para el tier de presentación, de
[`DECISIONS.md`](DECISIONS.md) (Rol 1). Alimenta la misma columna
**"Rationale and Assumptions"** del cuestionario de tácticas de la Tabla 8.2, y
registra lo mismo por entrada: la decisión, las alternativas descartadas, la
razón, la táctica del Cap. 8 que la respalda y el costo aceptado.

**Por qué un archivo aparte y con prefijo `F` en el número.** `DECISIONS.md` ya
numera de forma corrida (ADR-001 … ADR-012) y lo edita Rol 1. Numerar aquí
`ADR-F01`, `ADR-F02`, … evita colisiones de número entre integrantes que trabajan
en paralelo y deja claro con solo leer el identificador qué tier decidió qué.
Cuando una decisión de este archivo dependa de una del otro, se cita por su número
(`ADR-001`, `ADR-011`, …).

**Relación con Taller 1.** Los ADR del sistema (tres tiers, disponibilidad,
despliegue) están en
[`backend/docs/documentacion-arquitectura.md`](../backend/docs/documentacion-arquitectura.md),
sección 6, numerados ADR-01 … ADR-11 sin ceros. Ese documento sigue vigente: nada
de este archivo lo contradice, y en particular se respeta ADR-06 (artefacto único
y configuración externa), que es la restricción que más pesa sobre las decisiones
de este tier.

**Contrato consumido.** Lo que este tier asume del backend está en
[`frontend/CONTRATO.md`](../frontend/CONTRATO.md), separado explícitamente entre
lo verificado contra el código y lo propuesto pendiente de confirmación.

---

## ADR-F01 — Estructura del tier de presentación

**Fecha:** 2026-08-20
**Estado:** Aceptada

### Contexto

El tier de presentación hoy son tres archivos planos —[`frontend/index.html`](../frontend/index.html),
[`frontend/styles.css`](../frontend/styles.css) y [`frontend/app.js`](../frontend/app.js)—
que resuelven una sola pantalla: el formulario de login contra `/api/auth/login`.
Toda la lógica vive dentro de un único *listener* de `submit`, que hace de una vez
cinco cosas: conoce la URL absoluta del backend, arma el `fetch`, interpreta la
respuesta, guarda los tokens en `localStorage` y escribe el mensaje en el DOM. Con
una pantalla eso funciona; el problema aparece con la segunda.

Lo que viene son pantallas de **CRUD sobre recursos**. El contrato ya publicado
por Rol 1 expone productos (`GET/POST/PUT/DELETE /api/products`, con listado
paginado, búsqueda por nombre y borrado lógico), y el CRUD de usuarios está
registrado como trabajo pendiente en la tabla "Decisiones pendientes" de
`DECISIONS.md`. Es decir: como mínimo dos recursos, y la posibilidad realista de
un tercero.

Los dos comparten exactamente la misma mecánica —pedir una página, pintar una
tabla, abrir un formulario, enviar, refrescar la tabla, resaltar los campos que el
backend reportó en `violations`— y difieren solo en **datos**: la ruta base, los
campos, sus etiquetas, qué columnas se muestran, qué valida el cliente antes de
enviar.

Esa es exactamente la situación que el Cap. 8 describe como el caso donde la
modificabilidad se pierde: el cambio esperado —"agregar un recurso"— no está
localizado en ningún módulo, porque la lógica de CRUD y la descripción del recurso
están mezcladas en el mismo archivo. Si cada recurso trae su propia copia de la
tabla y del formulario, el costo de un cambio transversal —cambiar la paginación,
cambiar cómo se muestra un `503 data_unavailable`, empezar a reenviar el
`X-Request-Id`— se multiplica por el número de recursos.

Hay además dos restricciones que condicionan la respuesta y que no son negociables
desde este tier:

1. **ADR-06 (Taller 1): artefacto único, configuración externa.** El tier de
   presentación se sirve hoy como archivos estáticos, sin *toolchain* ni paso de
   compilación.
2. **El atributo de calidad evaluado no es la experiencia de usuario.** Taller 1
   midió disponibilidad (Cap. 4) y desplegabilidad (Cap. 5); Taller 2 mide
   modificabilidad (Cap. 8). Todo peso que se agregue aquí tiene que pagarse en
   modificabilidad, no en complejidad de despliegue.

### Decisión

Se estructura `frontend/` en tres módulos con responsabilidades disjuntas, más el
módulo de composición:

```text
frontend/
├── index.html
├── config.js                ← configuración externa sustituible en runtime
├── styles.css
└── src/
    ├── app.js               ← composición: importa el registro y arranca
    ├── platform/            ← servicios técnicos
    ├── crud/                ← motor CRUD genérico
    └── resources/
        ├── index.js         ← registro de recursos
        ├── products.js
        └── users.js
```

**Todo el código JavaScript de la aplicación vive bajo `src/`.** `index.html` y
`styles.css` se quedan en la raíz de `frontend/`, que es donde el navegador los
busca.

**`config.js` también se queda en la raíz, y no es código de la aplicación: es
configuración externa.** Contiene los valores que cambian por entorno —empezando por
`apiBaseUrl`— y está fuera de `src/` precisamente para que se pueda **generar o
sustituir al desplegar**, sin tocar nada de `src/`. Apuntar el frontend a otro
backend es reemplazar ese archivo; **cambiar `apiBaseUrl` no debe exigir recompilar
ni reconstruir el frontend**, ni volver a editar código de la aplicación. Es la misma
propiedad que ADR-06 (Taller 1) exige del tier de lógica —un artefacto, la diferencia
por configuración externa— aplicada aquí: `src/` es el artefacto y `config.js` es la
configuración.

Solo `src/platform/` lee `config.js`; `src/crud/` y `src/resources/` no lo conocen,
igual que no conocen la URL del backend.

1. **Separación en `src/platform/`, `src/crud/` y `src/resources/`.**
   - `src/platform/` concentra lo transversal y técnico: el cliente HTTP (URL base
     tomada de `config.js`, cabecera `X-Request-Id`, traducción del cuerpo de error
     `ErrorResponse` del backend a un objeto de error propio, incluida la lista
     `violations` de ADR-007), la sesión (tokens en `localStorage`, renovación vía
     `/api/auth/refresh` y rotación del refresh token), y utilidades de DOM y de
     aviso al usuario. No sabe qué es un producto ni qué es un usuario.
   - `src/crud/` contiene **una sola** implementación de tabla, formulario, paginador
     y controlador. No sabe qué recurso está manipulando.
   - `src/resources/` contiene un archivo por recurso: un descriptor declarativo
     —ruta base, lista de campos con etiqueta y tipo, columnas de la tabla, clave
     primaria, validaciones **estructurales** de cliente—. Es **datos**, no
     comportamiento. **`src/resources/index.js` es el registro**: la única lista de
     qué recursos existen en la aplicación.

2. **Dirección de dependencias: `app` → `crud` → `platform`.**
   Estrictamente en ese sentido y sin ciclos. `src/app.js` es el único módulo que
   conoce a los tres: **importa el registro** `src/resources/index.js` y entrega
   cada descriptor al motor de `src/crud/`, que devuelve la pantalla montada.

3. **`src/crud/` recibe los descriptores por parámetro y no importa `src/resources/`.**
   Ningún archivo de `src/crud/` contiene un `import` de `src/resources/`, ni el
   nombre de un recurso concreto, ni una ruta como `/api/products`. Todo lo que
   `src/crud/` necesita saber del recurso entra como argumento de función. Esta
   regla es la que hace que la lógica de CRUD sea genuinamente reutilizable, en vez
   de ser "la pantalla de productos parametrizada".

4. **`src/platform/` no importa `src/crud/`.**
   El módulo más reutilizable es también el que menos sabe. `src/platform/` puede
   usarse desde una pantalla que no sea un CRUD —el propio login lo es— sin
   arrastrar nada de `src/crud/`.

5. **Agregar un recurso = crear su descriptor y registrarlo.**
   El procedimiento completo para un recurso nuevo es: escribir
   `src/resources/<recurso>.js` —`products.js`, `users.js`, …— y agregar **una
   entrada en `src/resources/index.js`**.
   **No se modifica ningún archivo de `src/crud/`, de `src/platform/` ni
   `src/app.js`.** Que el registro viva en `src/resources/index.js` y no en
   `src/app.js` es deliberado: deja `src/app.js` como composición estable —importa el
   registro, no la lista— y concentra el único punto que cambia al agregar un recurso
   dentro de la misma carpeta que el descriptor nuevo. Este enunciado es el criterio
   con el que se verifica que la decisión se está respetando: si agregar un recurso
   obliga a tocar un módulo de lógica, la separación está rota y hay que corregirla,
   no rodearla.

### Alternativas descartadas

1. **Una carpeta o una pantalla completa por recurso** (`productos/` con su tabla,
   su formulario y su paginador; `usuarios/` con los suyos). Es la opción de menor
   esfuerzo para el **primer** recurso y la de mayor costo a partir del segundo:
   duplica tabla, formulario y paginador tantas veces como recursos haya. El
   problema no es la duplicación en sí, es lo que le hace al cambio transversal:
   corregir el manejo de `401 invalid_session`, o cambiar el tamaño de página, pasa
   de ser un cambio en un módulo a ser N cambios coordinados, con N creciendo. Es
   la misma falta de cohesión que ADR-001 rechaza en el backend, vista desde el
   otro lado: allá el problema era que un cambio *por feature* se dispersaba entre
   capas técnicas; aquí sería que un cambio *transversal* se dispersa entre
   features.

2. **React, Vue u otro framework SPA.** Resuelve la composición de vistas, pero el
   costo no se justifica en el alcance de este trabajo.

   **No se descarta por incompatibilidad con el artefacto único**: una aplicación
   compilada también se empaqueta y se promueve como un artefacto único por todos los
   entornos, y ADR-06 seguiría cumpliéndose sin problema. Ese argumento sería falso y
   no se usa aquí.

   Se descarta por **costo incremental**: un framework agrega una *toolchain* (Node,
   gestor de paquetes, *bundler*), un árbol de dependencias de terceros que hay que
   instalar, fijar y actualizar, un paso de *build* que mantener y una segunda forma
   de equivocarse al desplegar. Hoy el tier de presentación se sirve tal cual, sin
   nada de eso.

   Y ese costo **no compra nada en el atributo de calidad evaluado**: el escenario de
   modificabilidad de Taller 2 es "agregar un atributo a Producto sin tocar el
   frontend ni el módulo de usuarios", y lo que decide el costo de ese cambio aquí es
   si el frontend tiene **un descriptor o N pantallas copiadas** —lo que resuelve esta
   misma decisión, sin framework—, no qué biblioteca pinta el DOM. Con dos o tres
   recursos, un formulario y una tabla, la parte del problema que un framework
   resolvería mejor es la que menos pesa. Si el alcance creciera —muchas pantallas
   con estado compartido, navegación real— la decisión debería revisarse: se registra
   como reversible, no como prohibición.

### Razón

El cambio que se espera con más frecuencia en este tier es **"agregar o modificar
un recurso"**. El Cap. 8 dice que la modificabilidad se diseña identificando los
cambios probables y acomodando la estructura de módulos para que esos cambios
queden **localizados**. Con esta estructura, "agregar un recurso" es un archivo
nuevo más una línea: el cambio no se propaga porque `src/crud/` no depende de
`src/resources/`, y por lo tanto no existe ningún módulo de lógica que haya que abrir
para que el recurso nuevo funcione.

El segundo cambio esperado —"cambiar cómo se comporta el CRUD" (paginación, manejo
de errores, confirmaciones)— también queda localizado, y en el módulo opuesto: se
toca `src/crud/` una vez y todos los recursos lo heredan. Los dos cambios probables van
a módulos distintos y ninguno arrastra al otro; ese es el resultado que la decisión
persigue.

**Es la misma forma que ADR-003 en el backend, aplicada a otro problema.** Allá,
agregar una regla de negocio es crear una clase que implementa `ProductRule` y
anotarla como `@Component`: el motor la descubre y no se toca. Aquí, agregar un
recurso es crear un descriptor y añadirlo al registro: `src/crud/` lo consume y no se
toca. En ambos casos el módulo genérico conoce la *forma* del elemento nuevo, nunca
al elemento concreto. La única diferencia es el mecanismo de registro —`@Component` y
*classpath scanning* allá, una entrada en `src/resources/index.js` aquí—, porque sin
framework no hay descubrimiento automático que aprovechar. Que las dos mitades del
sistema lleguen a la misma solución por caminos independientes es un argumento a
favor de la solución, no una coincidencia.

**Por qué no se replica el *vertical slice* de ADR-001.** ADR-001 organiza el
backend por feature porque allá el eje de cambio esperado es *por feature*
("agregar un atributo a Producto" toca dominio, api y reglas del mismo módulo).
En este tier, la parte específica del recurso se reduce a **un archivo de datos**;
no hay cuatro capas que agrupar bajo una raíz de feature. El descriptor
`src/resources/products.js` **es** el *vertical slice* del recurso en el frontend, y
`src/crud/` es el motor que lo interpreta. Las dos decisiones aplican el mismo
principio —alinear la estructura con el eje de cambio real— y por eso llegan a
estructuras distintas: los ejes de cambio de los dos tiers son distintos.

La dirección de dependencias es lo que sostiene todo lo anterior. Sin ella, nada
impide que alguien haga un `import` de `src/resources/products.js` dentro de
`src/crud/table.js` "solo para este caso" —y en ese momento la estructura sigue
existiendo en las carpetas pero ya no en el código, que es donde importa.

### Tácticas del Cap. 8 aplicadas

| Táctica | Dónde se aplica |
|---|---|
| **Increase Cohesion / Split module** | El módulo único actual (`frontend/app.js`, que hoy mezcla transporte HTTP, manejo de sesión, presentación y reglas de una pantalla) se parte según *responsibility*: `src/platform/` (técnico), `src/crud/` (lógica de interacción) y `src/resources/` (descripción del dominio). Cada módulo resultante queda con una sola razón para cambiar. |
| **Reduce Coupling / Restrict dependencies** | La dirección `app → crud → platform` es una restricción explícita, no una convención de estilo: `src/crud/` no importa `src/resources/` y `src/platform/` no importa `src/crud/`. Se limita deliberadamente con qué módulos puede hablar cada módulo, para que un cambio en un recurso no tenga ninguna ruta por la cual alcanzar la lógica de CRUD. Es la misma táctica que ADR-001 invoca para que la capa compartida no dependa del módulo de productos. |
| **Reduce Coupling / Encapsulate** | El descriptor es la interfaz explícita entre un recurso y la lógica de CRUD: `src/crud/` conoce la *forma* del descriptor, nunca a un recurso concreto. `src/resources/index.js` encapsula además *qué* recursos existen, de modo que `src/app.js` no lleva la lista. Del mismo lado, `src/platform/http` encapsula la URL base, la cabecera `X-Request-Id` y el formato del cuerpo de error del backend (`code`/`kind`/`message`/`violations`), de modo que un cambio en el contrato de transporte se absorbe en un módulo y no se filtra a `src/crud/` ni a `src/resources/`. |

### Costo aceptado

- **Indirección.** Leer el flujo completo de una pantalla exige abrir tres archivos
  (descriptor, controlador de CRUD, cliente HTTP) en vez de uno. Para el primer
  recurso esto es estrictamente más trabajo que la alternativa descartada; la
  inversión se recupera a partir del segundo. Se acepta porque el CRUD de usuarios
  ya está en la tabla de pendientes de `DECISIONS.md`: el segundo recurso no es
  hipotético.

- **Expresividad limitada del descriptor.** Un recurso que necesite algo que el
  descriptor no sabe expresar obliga a extender `src/crud/` —es decir, a tocar un
  módulo de lógica—, que es justo lo que la decisión promete evitar. Se acepta a
  sabiendas: la respuesta correcta en ese caso es ampliar el vocabulario del
  descriptor **una vez**, no ramificar `src/crud/` con un caso especial por recurso.
  Si un recurso resulta genuinamente irreducible al descriptor, debe implementarse
  como una pantalla propia fuera de `src/crud/` y documentarse en un ADR nuevo, en
  vez de deformar el módulo genérico. Es el mismo costo que ADR-003 acepta cuando una
  regla no cabe en la interfaz `ProductRule`.

- **La regla de dependencias no se verifica automáticamente desde el primer día.**
  Inicialmente se comprueba por **revisión de código** contra este ADR y con
  **búsquedas automatizadas** —basta con que `grep -rn "resources/" src/crud/` y
  `grep -rn "crud/" src/platform/` no devuelvan nada para que la regla se cumpla, y
  eso es ejecutable en cualquier momento, incluso desde un *hook* de pre-commit—. El
  criterio operativo del punto 5 ("agregar un recurso no toca `src/crud/` ni
  `src/platform/`") existe precisamente para que esa revisión sea objetiva y no una
  discusión de estilo. **Si más adelante hiciera falta algo más fuerte, se puede
  añadir *linting* con una regla de dependencias sin adoptar ningún framework**: es
  una herramienta de desarrollo, no un cambio de arquitectura ni del artefacto que se
  despliega. No se hace desde ya por no introducir una dependencia antes de tener
  código que la justifique.

- **El descriptor puede desincronizarse del backend.** Duplica información que ya
  vive en `ProductRequest` (qué campos hay, cuáles son obligatorios, el máximo de
  120 caracteres del nombre). Si Rol 1 agrega un campo y nadie toca el descriptor,
  el formulario simplemente no lo muestra: falla en silencio, no con un error. Se
  acepta porque la alternativa —generar el descriptor desde un esquema publicado por
  el backend— exigiría un paso de generación y la coordinación de ese esquema, un
  costo mayor que el problema que resuelve en este alcance. La mitigación es de
  proceso, no de diseño: `frontend/CONTRATO.md` es el documento que las dos partes
  revisan cuando el contrato cambia.

  Nótese que esto vale **solo para lo estructural**. Las reglas de negocio no se
  replican en el descriptor en ningún caso: viven en el motor del backend, son
  activables por *toggle* (ADR-005) y llegan como `422 violations[]`; copiarlas aquí
  crearía una segunda fuente de verdad capaz de rechazar operaciones que el servidor
  acepta. Está detallado en §4.1 de `frontend/CONTRATO.md`.
