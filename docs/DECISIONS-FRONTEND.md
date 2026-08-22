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

---

## ADR-F02 — Cliente HTTP único y sesión por inversión de dependencia

**Fecha:** 2026-08-21
**Estado:** Aceptada

### Contexto

El tier de presentación nació con un único archivo, [`frontend/app.js`](../frontend/app.js),
que resuelve la pantalla de login haciendo todo por su cuenta dentro de un
*listener* de `submit`:

- llama a `fetch()` directamente (`app.js:14`);
- conoce una URL absoluta del backend escrita a mano
  (`"http://localhost:8080/api/auth/login"`, `app.js:15`);
- serializa el cuerpo y parsea la respuesta él mismo;
- guarda los tokens en `localStorage` (`app.js:34`, `app.js:38`);
- decide el texto que se muestra al usuario.

Lo que no hace es todo lo demás: no aplica timeout, no genera ni propaga un
identificador de correlación, no mide nada, no traduce los errores del backend a
un modelo común y no sabe renovar una sesión. Con una pantalla eso se sostiene;
con un CRUD sobre varios recursos, cada pantalla nueva repetiría las mismas cinco
responsabilidades y ninguna de las políticas transversales, y una petición sin
timeout o sin medir sería indistinguible de una correcta hasta que fallara en
producción.

**Ese archivo legado sigue existiendo tal cual.** `frontend/index.html:46` continúa
cargándolo con `<script src="app.js">`, y no ha sido migrado. Este ADR **no**
afirma lo contrario. La invariante que sí está en vigor hoy se enuncia sobre el
código modular:

> Dentro de `frontend/src/**`, solamente `src/platform/http.js` puede llamar a
> `fetch()`.

`frontend/app.js` queda temporalmente fuera de esa invariante y entrará en ella
cuando se reemplace, en el commit de arranque de la aplicación.

### Decisión

Todo el HTTP del código modular pasa por **`frontend/src/platform/http.js`**, que
concentra:

| Responsabilidad | Dónde |
|---|---|
| Resolución de la URL a partir de `frontend/config.js` | `resolveUrl(path)`, importado en `http.js:41` |
| Construcción determinista del *query string* | `buildQuery()` |
| Serialización del cuerpo | antes de `fetch`, `http.js:355-370` |
| Cabeceras `Accept` y `Content-Type` | `buildHeaders()` |
| Generación y propagación de `X-Request-Id` | `newRequestId()` + `buildHeaders()` |
| `Authorization: Bearer` | `buildHeaders()`, a partir del proveedor inyectado |
| Timeout | `AbortController` + `setTimeout(config.requestTimeoutMs)` |
| Cancelación externa (`signal`) | combinada con el timeout interno |
| Lectura del cuerpo **una sola vez** | `readBody()`, siempre con `.text()` |
| Tolerancia a cuerpo vacío, no-JSON y `204` | `readBody()` |
| Traducción de fallos a `HttpError` | delegada en `errors.js` |
| Medición de cada intento | `metrics.record()` en los dos caminos |
| Reintento único tras una renovación exitosa | `http.js:513-525` |

Las responsabilidades complementarias viven fuera y son de un solo dueño:

- **`errors.js`** traduce respuestas y fallos —`ErrorResponse` JSON, cuerpo de
  texto, `403` vacío, timeout, red, fallo local— a un modelo interno uniforme con
  `code`, `kind`, `category`, `requestId` y `violations`.
- **`metrics.js`** registra una muestra por intento y las resume (`report()`).
- **`session.js`** administra tokens, expiración, persistencia, rol y renovación.
- Los **errores locales de serialización** se distinguen de los de red: se
  detectan antes de tocar la red (`http.js:355-370`), producen un `HttpError` de
  categoría `client` vía `fromClientFailure()` y **no generan una muestra**,
  porque no hubo ninguna petición que medir. Contarlos como red haría que un
  defecto del propio frontend apareciera como indisponibilidad del backend.

### Inversión de dependencia

La dirección permitida es una sola:

```text
session.js → http.js
```

y nunca

```text
http.js → session.js
```

`session.js` importa el API público de `http.js` (`session.js:36`). `http.js`
importa exactamente tres módulos —`config.js`, `metrics.js` y `errors.js`
(`http.js:41-43`)— y ninguno es la sesión.

La comunicación en sentido contrario entra por `configureAuthProvider()`, con
tres capacidades **opcionales**:

```text
getToken()    -> string | null
refresh()     -> Promise
notify(event) -> void
```

- Sin `getToken()`, la petición sale **sin `Authorization`**.
- Sin `refresh()`, un `401 invalid_session` se **propaga sin reintento**.
- Sin `notify()`, un `403` se **propaga sin evento**.
- `http.js` **no sabe quién** las implementa: solo declara su forma.
- `crud/**` y `resources/**` no reciben ni pasan tokens: no saben que existen.
- El proveedor se instala desde las operaciones de sesión, no al importar el
  módulo, de modo que no hay ciclo de imports ni efectos de carga.

### Refresh y reintento

- **Login, refresh y logout** se invocan con `{auth:false, retryAuth:false}`: no
  llevan `Authorization` —el backend recibe los tokens en el cuerpo— y un fallo de
  autenticación en el propio refresh no puede disparar otro refresh.
- Las **solicitudes normales** usan `retryAuth:true` (valor por defecto,
  `http.js:336`).
- Ante `401 invalid_session`, `http.js` pide una renovación al proveedor; si
  funciona, **reintenta la petición una sola vez**, y el reintento lleva
  `retryAuth:false` para que un segundo `401` no vuelva a entrar en el ciclo.
- Si la renovación **falla**, se propaga **el error real del refresh** —incluido su
  `requestId`—, no el `401` que lo disparó. Quien depure el incidente necesita el
  identificador de la llamada que de verdad falló.
- El intento original y el reintento dejan **muestras independientes** en
  `metrics.js`: son dos peticiones reales y ocultar una falsearía la medición.
- `http.js` **no tiene** `refreshPromise`, ni cola, ni contador de renovaciones.
  La única promesa compartida vive en `session.js` (`session.js:175`, con la
  identidad estricta en `session.js:698-719`).
- Esa misma promesa coordina las cuatro fuentes de renovación: **proactiva** (por
  temporizador), **reactiva** (tras un `401`), **manual** y la que inicia
  `restore()`. El refresh token es de un solo uso y rota al canjearse, así que dos
  canjes simultáneos harían que el segundo recibiera `401` y cerrara una sesión
  válida.

**Protección por generaciones.** Una respuesta que llega tarde no puede escribir
sobre una sesión posterior: cada operación que establece o destruye una sesión
—`login()`, `logout()`, `restore()`, `clear()`— reclama una identidad al empezar,
y toda operación asíncrona comprueba la suya antes de aplicar. `login()` usa dos
identidades, una de inicio y otra de confirmación: la primera ordena dos login
concurrentes y la segunda expulsa a los refresh de la sesión anterior que
arrancaron mientras el login viajaba. El `finally` de una renovación antigua solo
limpia la referencia compartida si sigue siendo la suya, de modo que no puede
borrar la promesa de una renovación nueva.

### Alternativas descartadas

1. **`fetch()` en cada pantalla.** Es lo que hace hoy `app.js` y es el punto de
   partida del problema: cada pantalla repetiría URL, cabeceras y parseo, y —lo
   grave— ninguna aplicaría timeout, correlación ni medición. Las políticas
   transversales no se aplican por convención, se aplican porque solo hay un
   camino.

2. **Importar `session.js` desde `http.js`.** Es la solución evidente y crea un
   ciclo: la sesión necesita hablar HTTP para hacer login y refresh, y el
   transporte necesita un token. Un ciclo de imports en módulos ES es además una
   trampa de inicialización: el orden de evaluación decide qué mitad ve a la otra
   a medio construir.

3. **Pasar el token manualmente desde cada llamada CRUD.** Rompe la encapsulación
   en la dirección peor: obligaría a `crud/**` y a `resources/**` a conocer la
   autenticación, cuando su razón de existir es no conocer nada del dominio
   técnico. Y bastaría una llamada que olvidara el token para producir un `401`
   inexplicable.

4. **Mantener una cola de refresh en HTTP *y* en sesión.** Parece defensa en
   profundidad y es lo contrario: dos coordinadores producen dos canjes del mismo
   refresh token de un solo uso, y el segundo recibe `401` y cierra una sesión que
   estaba viva. La coordinación tiene que tener **un solo dueño**.

5. **Parsear siempre con `response.json()`.** Un `Response` solo se puede consumir
   una vez, y `.json()` lanza sobre un cuerpo vacío o no-JSON. Con el `403` vacío
   de la cadena de seguridad —sin `Content-Type` y sin cuerpo— eso convertiría un
   rechazo previsto en un error de *parsing* del frontend. Leyendo `.text()` una
   vez y parseando aparte, el mismo camino sirve para JSON, texto plano, cuerpo
   vacío y `204`.

6. **Guardar el access token y el refresh token en claves separadas.** Dos
   escrituras pueden intercalarse: una interrupción entre ambas deja un access
   token nuevo junto a un refresh token viejo, y la siguiente renovación falla con
   `401` sobre una sesión que era válida. Se guarda **un único registro JSON
   versionado**, sustituido con un solo `setItem`.

7. **Permitir más de un reintento automático tras un `401`.** Si la renovación
   funcionó y la petición vuelve a dar `401`, el problema no es la sesión, y
   reintentar en bucle solo multiplica la carga sobre un backend que ya está
   rechazando. Un intento, y el error se propaga.

### Tácticas aplicadas

| Táctica | Dónde se aplica |
|---|---|
| **Encapsulate** (Cap. 7) | El transporte —URL, cabeceras, serialización, parseo, traducción de errores— queda detrás de `get/post/put/del`, y la forma en que el backend reporta un fallo queda detrás del modelo de `errors.js`. Un cambio en el contrato de transporte se absorbe en un módulo. |
| **Use an Intermediary** (Cap. 7) | `http.js` es el intermediario entre los consumidores y el backend. Nadie más habla con la red, y por eso las políticas transversales se pueden garantizar en vez de recordar. |
| **Restrict Dependencies** (Cap. 8) | `http.js` no importa `session.js`, y `crud/**` y `resources/**` no conocen la autenticación. Las dependencias permitidas se limitan deliberadamente, no por convención. |
| **Abstract Common Services** (Cap. 8) | Timeout, correlación, traducción de errores, medición y renovación existen **una sola vez**, no una por pantalla. |
| **Defer Binding** (Cap. 8) | El proveedor de autenticación se inyecta en tiempo de ejecución mediante `configureAuthProvider()`, declarado por capacidades y no por identidad del módulo. |

La justificación de *seguridad* del timeout —por qué abortar una espera es
obligatorio, no una comodidad— **no pertenece a este ADR**: está en ADR-F03.

### Costo aceptado

- **Más indirección.** Seguir una petición exige abrir el módulo que la pide,
  `http.js`, `errors.js` y a veces `session.js`. Para una pantalla es más trabajo
  que un `fetch()` suelto; la inversión se recupera con la segunda.
- **Un punto central con alcance transversal.** Un defecto en `http.js` afecta a
  toda la aplicación a la vez. Es la contrapartida inevitable de que solo haya un
  camino, y es la razón de que el módulo esté cubierto por pruebas exhaustivas.
- **Un contrato de capacidades entre transporte y sesión.** `getToken`, `refresh`
  y `notify` son una interfaz implícita que hay que mantener coherente en los dos
  lados sin que ninguno importe al otro.
- **Pruebas del intermediario obligatorias.** Sin ellas, el punto único deja de ser
  una garantía y pasa a ser un riesgo concentrado.
- **Complejidad para coordinar renovación y carreras.** Promesa compartida,
  identidad estricta y generaciones son mecanismos que no harían falta si cada
  pantalla se las arreglara sola —y que son justamente lo que impide que dos
  canjes simultáneos cierren una sesión válida.
- **Persistencia en `localStorage`.** Con `allowCredentials=false` en el backend no
  hay cookies, así que el token vive en el cliente y queda expuesto a cualquier
  script que se ejecute en el origen. Es la superficie de riesgo que acepta la
  arquitectura actual, no una elección indiferente.
- **`frontend/app.js` sigue fuera de la invariante** hasta que se reemplace. Es
  deuda declarada, con fecha de vencimiento en el commit de arranque.

---

## ADR-F03 — Timeout distinto del presupuesto de latencia y degradación controlada

**Fecha:** 2026-08-21
**Estado:** Aceptada

### Contexto

`frontend/config.js` declara dos valores distintos, y su diferencia es una
decisión, no un descuido (`config.js:106-107`):

```text
requestTimeoutMs: 5000
latencyBudgetMs:  2000
```

No miden lo mismo:

- **2000 ms es el presupuesto de calidad**: el umbral a partir del cual una
  respuesta se considera un incumplimiento del objetivo de latencia. No aborta
  nada; se **mide**.
- **5000 ms es el límite de espera**: el punto en que seguir esperando deja de ser
  seguro y la operación se **aborta**.

De ahí que una respuesta de **4000 ms** incumpla el presupuesto y, aun así, sea una
**respuesta completa y observable**:

- se conoce su `status`;
- se conoce su `kind`;
- se sabe si fue éxito o error;
- se mide su latencia completa, la real;
- se marca `budgetExceeded: true`;
- y **no se confunde con un fallo de transporte**.

**Qué se pierde si los dos valores fueran 2000 ms.** Una operación que habría
respondido a los 2500, 3000 o 4000 ms sería abortada alrededor de los 2000 ms. Esa
operación **NO desaparece de las métricas** —conviene decirlo con precisión, porque
es fácil suponer lo contrario—: `http.js` registra su muestra en el camino de
fallo de transporte, con `timeout: true` y con `budgetExceeded` calculado sobre la
latencia observada; `metrics.getNetworkSamples()` la incluye, `latencyStats()` la
mete en p50, p95 y max, y `report()` cuenta los timeouts y los incumplimientos por
separado. El contador de incumplimientos no quedaría en cero y los percentiles no
se calcularían solo sobre lo que llegó a tiempo.

Lo que se pierde no es la muestra, sino **su contenido**:

1. **La latencia deja de ser la real y pasa a ser la del corte.** El intento entra
   en los percentiles con la latencia observada hasta el aborto —unos 2000 ms—, no
   con la que habría tenido. Una operación de 2100 ms y otra de 4900 ms se
   registran ambas como ~2000 ms: la distribución queda truncada contra el
   timeout, artificialmente comprimida, y deja de poder distinguir "lenta" de
   "gravísima".
2. **Se pierde el desenlace por completo.** Sin respuesta no hay `status`, no hay
   `kind` y no se sabe si aquello habría sido un éxito, un error de negocio o una
   caída. Una operación que iba a devolver `200` queda registrada exactamente
   igual que una que iba a devolver `503`.
3. **La disponibilidad medida empeora sin que el backend haya empeorado.** Una
   respuesta lenta de `200` cuenta como `available = 1`; el mismo intento
   abortado llega a `metrics.isAvailable()` con `httpStatus: "000"` y sin `kind`,
   así que cuenta como `available = 0`. Igualar los valores convertiría éxitos
   observables en indisponibilidad registrada.

La ventana de 2000 a 5000 ms es justamente la que hay que poder observar **con
información completa**, no solo la que hay que poder contar.

El timeout **no garantiza** el presupuesto. Son cosas distintas: el presupuesto es
un objetivo que se comprueba sobre respuestas reales, y el timeout es un límite
que evita una espera insegura.

> Todo lo que sigue describe **diseño y comportamiento verificado en el arnés de
> pruebas** del propio repositorio. No hay aquí mediciones de tráfico real de
> usuarios, y no se presenta ninguna como tal.

### Decisión — medición

- El cronómetro arranca **inmediatamente antes del intento de red**
  (`http.js:400`), después de construir cabeceras.
- Por eso la latencia del proveedor de autenticación **no contamina** la métrica:
  `getToken()` puede ser asíncrono y se resuelve antes (`http.js:374`).
- Se mide **hasta después de leer y parsear el cuerpo** (`http.js:414`): el cuerpo
  es parte de lo que el usuario espera, no solo las cabeceras.
- Cada intento HTTP deja **exactamente una muestra**, tanto en el camino de éxito
  como en el de fallo de transporte.
- Los **errores locales previos a la red** no generan muestra: no hubo petición que
  medir.
- **Timeout, aborto externo y error de red se distinguen** con banderas propias, no
  por inferencia: un timeout aborta el controlador igual que una cancelación, así
  que sin distinguirlos serían indistinguibles entre sí y de un fallo de red.
- Un timeout conserva **la latencia realmente observada** hasta el aborto, no el
  valor nominal del límite: es lo que el usuario esperó.
- `budgetExceeded` se calcula comparando esa latencia con `latencyBudgetMs`
  (`http.js:427`, `http.js:479`).
- Los timeouts se cuentan **además por separado**, porque "cuántas peticiones
  expiraron" y "cuántas excedieron el presupuesto" son dos preguntas distintas.
- Los futuros aciertos de caché **no deben entrar** en los percentiles de red: no
  midieron red. La distinción ya existe en `metrics.getNetworkSamples()`
  (`metrics.js:135`), que filtra por `cacheHit === false`, aunque hoy ninguna
  muestra lo tenga en `true`.

### Decisión — disponibilidad

`metrics.isAvailable()` (`metrics.js:81`) aplica una regla única:

```text
cualquier 2xx             → available = 1
kind === "EXPECTED"       → available = 1
cualquier otro resultado  → available = 0
```

Consecuencias, todas deliberadas:

- Un **`204 No Content`** exitoso es **disponible**: el borrado funcionó.
- Un **`422` con `kind: EXPECTED`** es **disponible**: el sistema respondió según su
  especificación, y una regla de negocio incumplida no es una caída.
- Un **`403` vacío** es **no disponible** para la métrica del cliente: no trae `kind`
  y, desde el navegador, es una operación que no se pudo completar.
- **Timeout y fallo de red** son **no disponibles**.
- Un **error local de serialización** no representa un intento HTTP y **no entra** en
  esta medición.

**Relación con `backend/scripts/probe.sh`.** Los dos son **clientes externos al
backend**: `probe.sh` mide con `curl` desde el entorno donde se ejecuta el script,
y este módulo mide desde el navegador del usuario. Ninguno mide dentro del
servidor. Las columnas del CSV pueden coincidir, pero **la definición exacta de
`available` y el conjunto de operaciones observadas no son iguales** —`probe.sh`
trata explícitamente `200` y `201`, y no ejercita las operaciones que responden
`204`—. Por eso **no se deben concatenar ni promediar las dos fuentes sin
normalizar** primero la semántica; si se combinan, cada muestra debe conservar su
origen.

### Decisión — degradación

Lo implementado hoy, verificado en `session.js` y `http.js`:

**`401 invalid_session` durante el refresh** — limpia la sesión, emite
`session:expired` y propaga el mismo `HttpError`. Cubre también al usuario
desactivado, porque el backend responde igual en los dos casos: el frontend **no
inventa** un código propio como `user_inactive` que la API no entrega.

**`503 data_unavailable` durante el refresh** — **no** se presenta como sesión
expirada. Conserva el estado necesario para un reintento posterior, emite
`system:degraded`, conserva el error y su `requestId`, y **no crea un intervalo ni
un bucle automático**: no programa inmediatamente otro refresh. Un cliente que
reintenta solo contra un backend caído multiplica la carga justo cuando menos
puede soportarla.

**Timeout o red durante el refresh** — conserva el estado, **no** emite expiración,
propaga el error y no crea bucles. Solo el `401 invalid_session` cierra la sesión.

**`403` en cualquier petición** — emite `session:forbidden`, **conserva la sesión**,
**no refresca** y propaga el error con su `requestId`, que llega en `X-Request-Id`
incluso cuando el cuerpo viene vacío.

**Lo que todavía NO existe**, y no debe leerse como implementado:

- El **banner visual de degradación**: `frontend/index.html` no ha sido migrado y
  sigue cargando el `app.js` legado, así que ningún componente consume
  `system:degraded`.
- El **modo de consulta** durante una degradación: el motor CRUD no existe.
- El **botón de reintento manual**: no existe.
- La **política futura** permitirá como máximo **dos reintentos manuales**. Está
  decidida, no construida, y el límite es deliberado: los reintentos los pide una
  persona, no un bucle.

### Alternativas descartadas

1. **Un solo valor para presupuesto y timeout.** No es que dejara de medirse: el
   intento abortado **siempre** deja su muestra, con la latencia observada y
   `timeout: true`, y **siempre** entra en los percentiles. Lo que ya no está
   garantizado es la marca de incumplimiento, porque `budgetExceeded` se calcula
   aparte, con la comparación estricta `latencyMs > budget`: un aborto observado
   *por encima* del presupuesto queda marcado, pero con los dos valores iguales la
   latencia observada cae justo alrededor del umbral y la comparación puede no
   cumplirse. La conclusión no depende de ese detalle: la muestra entra en los
   percentiles pero queda **censurada y sin desenlace** —latencia truncada contra
   el timeout en vez de la real, sin `status` ni `kind`—, y una respuesta lenta
   pero correcta pasaría a contabilizarse como no disponible. Se mediría igual de
   cantidad y peor de calidad.
2. **No usar timeout.** Una petición que nunca responde deja a la aplicación
   esperando indefinidamente, con el usuario mirando una pantalla que no cambia y
   sin forma de saber que no va a cambiar.
3. **Medir solo las respuestas exitosas.** Produce un panel que mejora cuando el
   sistema empeora: cuantos más fallos, mejor se ve lo que queda.
4. **Contar los fallos locales como fallos de red.** Un cuerpo no serializable es un
   defecto del frontend; clasificarlo como red haría que apareciera como
   indisponibilidad del backend y contaminaría la métrica que sirve para decidir.
5. **Cerrar sesión ante cualquier error del refresh.** Convertiría una caída
   temporal del tier de datos en una expulsión del usuario: un fallo del frontend,
   no del backend.
6. **Reintentar un `503` automáticamente y sin límite.** Multiplica la carga sobre
   un backend que ya está caído, y desde N clientes a la vez.
7. **Mezclar los aciertos de caché con los percentiles de red.** Un acierto de caché
   no midió red; incluirlo haría que el p95 "mejorara" al añadir caché sin que la
   red fuera más rápida.
8. **Promediar directamente navegador y `probe.sh`.** Distinta definición de
   `available` y distinto conjunto de operaciones: el promedio sería un número sin
   significado.
9. **Tratar el `403` como expiración de sesión.** Un `403` no dice que la sesión sea
   inválida, sino que esa operación no está permitida; cerrar sesión expulsaría a
   un usuario perfectamente autenticado por pulsar un botón que no le corresponde.

### Tácticas aplicadas

| Táctica | Dónde se aplica |
|---|---|
| **Timeout / Unsafe State Detection** (Cap. 10, *Safety*) | Toda petición tiene un límite duro. Seguir esperando una respuesta que no va a llegar es el estado inseguro que esta táctica detecta y corta. |
| **Degradation** (Cap. 10, *Safety*) | Ante un `503` se conservan las funciones que siguen siendo posibles —la sesión local sigue viva mientras el access token no expire— en vez de convertir una caída del tier de datos en una expiración falsa. |
| **Clasificación de disponibilidad** (Cap. 4) | El resultado se clasifica por respuesta, `kind`, timeout y fallo de transporte, con la taxonomía `EXPECTED`/`FAULT`/`FAILURE` como criterio de qué cuenta contra la disponibilidad. |
| **Monitor Resources / Metering** (Cap. 6) | Cada intento real deja su muestra, incluidos los que fallan, y el resumen separa timeouts de incumplimientos de presupuesto. |

Conviene no confundir dos responsabilidades que recaen sobre el **mismo
mecanismo**: el **Cap. 10 justifica abortar** —seguir esperando es inseguro—, y el
**Cap. 4 determina cómo se clasifica y contabiliza** el resultado de ese aborto —el
intento cuenta como no disponible—. El timeout participa en las dos, y por eso su
código vive en `http.js` mientras la regla que lo clasifica vive en `metrics.js`.

### Costo aceptado

- **Dos parámetros que hay que mantener coherentes.** Si alguien iguala los dos
  valores, o pone el presupuesto por encima del timeout, la medición deja de
  significar lo que dice. Es una invariante que solo protege la documentación y
  una prueba.
- **Clasificación más compleja.** Distinguir timeout, aborto externo, red y fallo
  local exige banderas y orden de comprobación, en vez de un `catch` único.
- **Una ventana de 2 a 5 segundos** en la que la aplicación sigue esperando aunque
  el presupuesto ya se incumplió. Es deliberado: preferimos una respuesta lenta
  —con su latencia real, su `status` y su `kind`— a un aborto temprano que dejaría
  una muestra empobrecida, con la latencia truncada contra el timeout y sin
  desenlace conocido.
- **Estado conservado tras un `503`.** El registro de sesión sobrevive a una caída
  del tier de datos, lo que alarga la vida de un refresh token en el cliente a
  cambio de no expulsar al usuario por un fallo que no es suyo.
- **Hay que distinguir las fuentes de medición.** Navegador y `probe.sh` no son
  intercambiables, y cualquier análisis conjunto exige normalizar antes.
- **Ausencia deliberada de reintentos ilimitados.** Ante un backend caído, el
  cliente no insiste solo; la recuperación depende de una acción del usuario. Se
  acepta a cambio de no amplificar la caída.
- **Una respuesta lenta consume recursos hasta llegar o hasta el timeout.** La
  conexión, el temporizador y la promesa siguen vivos durante esos segundos.
