# Contrato de API consumido por el frontend

Tier de presentación (Rol 3) ← → tier de lógica (Rol 1 / Rol 2).

Este documento registra **lo que el frontend asume del backend**. No es la
documentación oficial de la API —esa es
[`backend/GUIA-DE-USO.md`](../backend/GUIA-DE-USO.md)— sino el subconjunto que este
tier consume, con el detalle que hace falta para construir pantallas: qué campos
son obligatorios, qué códigos de error hay que distinguir en la UI, y qué respuesta
corresponde a cada caso.

## Cómo leer este documento

| Marca | Significado |
|---|---|
| ✅ **VERIFICADO** | Leído directamente del código del backend en el commit `291b2a1`. Las fuentes se citan en cada sección. Si el código cambia y este documento no, **el documento está mal**. |
| 🟡 **PROPUESTO** | **No existe en el código.** Es una petición del frontend, pendiente de confirmación de Rol 1. Nada de esto puede darse por implementado. |
| ⚠️ **BLOQUEANTE** | Verificado en el código, y hoy impide que el frontend funcione. Requiere acción de otro rol. |

**Fuentes verificadas:** `backend/src/main/java/com/taller/auth/product/api/`
(`ProductController`, `ProductRequest`, `ProductResponse`, `PageResponse`),
`controller/AuthController.java`, `controller/DiagnosticsController.java`,
`dto/`, `exception/`, `config/SecurityConfig.java`, `config/CorsConfig.java`,
`security/RequestIdFilter.java`, `application.yml`,
`db/migration/V3__users_roles_products.sql`, y los tests
`ProductControllerTest` / `ErrorContractTest`.

**Verificación en ejecución.** Las respuestas marcadas *(observado)* se comprobaron
levantando el backend en local con el perfil `test` (H2 en memoria, sin Docker) el
2026-08-20 y llamándolo con `curl`. Lo que no pudo ejecutarse se marca como
*(deducido del código)* y dice por qué.

---

## 1. Reglas generales — ✅ VERIFICADO

### 1.1 Origen y transporte

- **URL base:** `http://localhost:8080` en desarrollo. Hoy está *hardcodeada* en
  [`app.js`](app.js). Según ADR-F01 el **valor** pasa a `frontend/config.js`
  —configuración externa sustituible al desplegar, sin recompilar— y el **uso** a
  `src/platform/http`, que es el único módulo que la lee.
- Todo el intercambio es JSON. Las peticiones con cuerpo requieren
  `Content-Type: application/json`.
- **CORS** (`CorsConfig`): orígenes `*`, métodos **`GET, POST, PUT, DELETE, OPTIONS`**,
  cabeceras `*`, `allowCredentials = false`, y **una sola cabecera expuesta:
  `X-Request-Id`**.
  - Consecuencia 1: **`PATCH` no está permitido.** Cualquier operación nueva que el
    frontend necesite debe pedirse sobre uno de los cinco métodos permitidos, o
    exigir un cambio en `CorsConfig`.
  - Consecuencia 2: al ser `allowCredentials = false`, **no hay cookies**. El token
    tiene que viajar en cabecera y guardarse en el cliente (hoy, `localStorage`).
  - Consecuencia 3: el frontend **no puede leer `Location`** ni ninguna otra
    cabecera de respuesta que no sea `X-Request-Id`. Por eso los `POST` de creación
    devuelven el recurso en el cuerpo y no solo un `Location`.

### 1.2 Correlación: `X-Request-Id`

`RequestIdFilter` lee `X-Request-Id` de la petición si viene; si no, genera un UUID.
Siempre lo devuelve en la respuesta, y lo incluye en el cuerpo de error como
`requestId`.

*(observado)* Si el cliente envía la cabecera, el backend la respeta y la devuelve
tal cual, y el mismo valor aparece como `requestId` en el cuerpo de error:

```
$ curl -i -H "X-Request-Id: mi-id-de-prueba-123" -X POST .../api/auth/login -d '{...}'
X-Request-Id: mi-id-de-prueba-123
{"code":"invalid_credentials", ... ,"requestId":"mi-id-de-prueba-123"}
```

**Estado en el frontend: no implementado.** El [`app.js`](app.js) actual no envía
ninguna cabecera aparte de `Content-Type`, ni lee `X-Request-Id` de la respuesta.

**Comportamiento previsto** (no implementado todavía, requiere `src/platform/http`):
el cliente HTTP **leerá el `X-Request-Id` de la respuesta** y lo adjuntará a los
errores que muestre la UI, para que un incidente sea rastreable en los logs del
backend sin pedirle al usuario que reproduzca nada. Que además el cliente **genere**
la cabecera es posible —el backend la acepta— pero no está decidido ni implementado,
y este documento no lo da por hecho.

### 1.3 Cuerpo de error — único para toda la API

Producido exclusivamente por `GlobalExceptionHandler`. Ningún controlador arma
errores a mano.

```json
{
  "code": "business_rule_violation",
  "kind": "EXPECTED",
  "message": "La operacion incumple una o mas reglas de negocio",
  "retryable": false,
  "requestId": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
  "violations": [
    { "rule": "price.must-be-positive", "field": "price", "message": "El precio debe ser mayor a 0" }
  ]
}
```

| Campo | Tipo | Uso en el frontend |
|---|---|---|
| `code` | string | **Clave de decisión.** El frontend ramifica por `code`, nunca por `message`. |
| `kind` | `EXPECTED` \| `FAULT` \| `ERROR` \| `FAILURE` | Informativo. Sirve para decidir el tono del aviso: `EXPECTED` es un resultado normal, no una caída. |
| `message` | string | Texto legible. Es aceptable mostrarlo tal cual. |
| `retryable` | boolean | Si es `true`, el frontend ofrece "Reintentar". Hoy solo `data_unavailable` lo trae en `true`. |
| `requestId` | string | Se muestra en errores irrecuperables. |
| `detail` | string \| **ausente** | Detalle de validación estructural (`campo: mensaje; campo: mensaje`). Diagnóstico, **no UI**. |
| `violations` | array \| **ausente** | Solo en `business_rule_violation`. |

**`detail` y `violations` se omiten del JSON cuando no aplican.**
`@JsonInclude(NON_NULL)` está aplicado **a la clase** `ErrorResponse`, así que
alcanza a todas sus propiedades nulas: ninguna de las dos llega como `null`, ni
`violations` llega como `[]`. **El cliente debe comprobar la existencia de la
propiedad**, no su valor ni su longitud. *(observado)*:

```
401 → {"code":"invalid_credentials", ... ,"requestId":"..."}                    ← sin detail ni violations
400 → {"code":"validation_error", ... ,"detail":"password: size must be ...;"}  ← con detail, sin violations
```

Protegido por `ErrorContractTest`.

Dos matices que se siguen de lo anterior:

- **`@JsonInclude` es de `ErrorResponse`, no una convención global de la API.** Las
  respuestas de éxito no lo llevan: `/api/auth/logout` sí devuelve `"note": null`
  explícitamente (§3.5). No generalizar la omisión a otros cuerpos.
- **`detail` no es texto de UI.** Lo generan los mensajes por defecto de Bean
  Validation, que llegan en inglés aunque el resto del cuerpo esté en español
  (`"password: size must be between 8 and 100"`, observado). Sirve para diagnóstico
  y para la consola, no para mostrárselo al usuario.

Cada violación trae `field`, que es el nombre del campo tal como aparece en el JSON
de la petición: eso es lo que permite **resaltar el input correspondiente** en el
formulario. Y el motor **acumula todas las violaciones** en un solo viaje (ADR-004),
así que el formulario puede marcar varios campos a la vez.

### 1.4 Catálogo de códigos de error

| `code` | HTTP | `kind` | `retryable` | Dónde puede aparecer | Reacción del frontend |
|---|---|---|---|---|---|
| `invalid_credentials` | 401 | EXPECTED | no | `/api/auth/login` | Mensaje en el formulario. No cerrar sesión (no hay). |
| `account_locked` | 423 | EXPECTED | no | `/api/auth/login` | Mensaje explícito de bloqueo temporal. El backend indica los segundos en `message`. |
| `user_already_exists` | 409 | EXPECTED | no | `/api/auth/register` | Marcar el campo `username`. |
| `invalid_session` | 401 | EXPECTED | no | `/api/auth/validate`, `/api/auth/refresh` | Intentar `refresh`; si el `refresh` también falla, cerrar sesión y volver al login. |
| `validation_error` | 400 | EXPECTED | no | cualquier `POST`/`PUT` | Error **estructural** (falta un campo, formato inválido). Detalle en `detail`, no en `violations`. |
| `malformed_request` | 400 | EXPECTED | no | cualquier `POST`/`PUT` | Defecto del frontend: el cuerpo no era JSON válido. Log en consola. |
| `business_rule_violation` | **422** | EXPECTED | no | `POST`/`PUT /api/products` | Error **de negocio**. Resaltar cada `violations[].field` con su `message`. |
| `product_not_found` | 404 | EXPECTED | no | `GET`/`PUT`/`DELETE /api/products/{id}` | El producto no existe **o fue dado de baja**. Refrescar la tabla. |
| `data_unavailable` | 503 | FAILURE | **sí** | todo lo que toca la BD | Aviso de indisponibilidad temporal + botón "Reintentar". No cerrar sesión. |
| `internal_error` | 500 | FAULT | no | cualquiera | Aviso genérico + `requestId`. No reintentar automáticamente. |

**La distinción 400 vs 422 es deliberada y el frontend debe respetarla** (ADR-004):
`400 validation_error` significa que la petición estaba mal formada —es un defecto
del frontend, que debería haberlo atajado antes de enviar—; `422
business_rule_violation` significa que la petición era correcta y el **negocio** la
rechazó, que es información para el usuario.

### 1.5 El `403` no tiene `code` ni cuerpo — *(observado)*

**Ninguna respuesta de la tabla anterior cubre el `403`**, porque no la produce
`GlobalExceptionHandler`: la corta Spring Security en la cadena de filtros, antes de
llegar al controlador. No hay `@ExceptionHandler(AccessDeniedException)` ni
`AuthenticationEntryPoint` propio en el backend, así que el cuerpo **viene vacío**:

```
$ curl -i http://localhost:8080/api/products
HTTP/1.1 403
X-Request-Id: 1960d2ca-ae57-44b6-935a-b4e54335de06
Content-Length: 0            ← sin Content-Type, sin cuerpo, sin code
```

Hay que distinguir dos situaciones que producen el mismo `403`:

| | Causa | Duración |
|---|---|---|
| **Hoy** | No existe el filtro que construye la autenticación a partir del JWT, así que **ninguna** petición a un endpoint protegido llega autenticada — ni siquiera con un `Bearer` válido (§2, verificado con token real). | Transitoria: desaparece cuando Rol 2 entregue el filtro. |
| **Permanente** | Un usuario **autenticado** intenta una operación reservada a `ADMIN` (`POST`/`PUT`/`DELETE` de productos, ADR-011). | Estable: es el comportamiento correcto del sistema. |

**Consecuencias para el cliente HTTP:**

1. **Debe tolerar respuestas de error vacías o sin JSON parseable.** Un
   `await response.json()` incondicional sobre un `403` lanza una excepción de
   *parsing* y convierte un rechazo previsto en un fallo del frontend. El cliente
   comprueba primero si hay cuerpo, y si no lo hay construye un error propio a partir
   del status.
2. **No hay `code` estable que consultar.** Este documento **no inventa uno**: el
   backend no lo produce. La UI ramifica por el status `403`, no por `code`.
3. **El `X-Request-Id` sí llega** incluso en el `403` vacío —`RequestIdFilter` corre
   con `HIGHEST_PRECEDENCE`, antes de la cadena de seguridad—, así que el error
   sigue siendo correlacionable con los logs del backend.
4. Mientras dure la situación de la primera fila, **un `403` no significa "no eres
   ADMIN"**: hoy significa "el filtro JWT todavía no existe". La UI no debe deducir
   el rol del usuario a partir de un `403`.

---

## 2. ⚠️ BLOQUEANTE — estado real de la autorización

**Verificado en `SecurityConfig` (sin cambios desde Taller 1) y advertido por Rol 1
en la cabecera de `ProductController` y en ADR-011.**

`SecurityConfig` declara `permitAll()` para `/api/auth/**`, `/api/diagnostics` y los
`/actuator/health/**` — y `.anyRequest().authenticated()` para todo lo demás. Pero
**no existe ningún filtro que traduzca el JWT en un `Authentication`**, y
`@EnableWebSecurity` está sin `@EnableMethodSecurity`. De ahí se siguen dos hechos:

1. **Hoy los cinco endpoints de `/api/products` responden con rechazo a todo el
   mundo**, incluido `GET`, incluso enviando un `accessToken` válido. No hay forma
   de que el frontend los consuma todavía.
2. Los `@PreAuthorize("hasRole('ADMIN')")` de `ProductController` **están inertes**:
   Spring los ignora en silencio sin `@EnableMethodSecurity`. Si llegara solo el
   filtro JWT y no la anotación de configuración, `POST`/`PUT`/`DELETE` quedarían
   abiertos a **cualquier usuario autenticado**.

**Cómo procede el frontend mientras tanto:** las pantallas de productos se
construyen contra este contrato tal como está escrito abajo (es el contrato que
Rol 1 ya fijó y que no va a cambiar cuando la autorización se active), y el envío
del token se implementa en `src/platform/http` desde ya, para que el día que el filtro
exista no haya que tocar `src/crud/` ni `src/resources/`. Lo que no puede hacerse hoy es
**probar** esas pantallas de punta a punta.

### 2.1 Cómo se envía el token — 🟡 PROPUESTO

Ningún endpoint actual lee la cabecera `Authorization`: `/api/auth/**` recibe el
token **en el cuerpo** (`{"token": ...}`, `{"refreshToken": ...}`), y `/api/products`
no llega a leer nada porque la petición se rechaza antes.

El frontend asume el estándar `Authorization: Bearer <accessToken>`, que es lo que
un filtro JWT convencional espera. **Confirmar con Rol 2** al implementar el filtro.

---

## 3. Autenticación — ✅ VERIFICADO

Base: `/api/auth`. Ninguno de estos endpoints requiere autenticación previa.

### 3.1 `POST /api/auth/register`

```json
{ "username": "maria123", "password": "unaClaveSegura1" }
```

Validación estructural (`RegisterRequest`), que el frontend replica antes de enviar:

| Campo | Reglas |
|---|---|
| `username` | obligatorio; 3–50 caracteres; **solo alfanumérico** (`^[a-zA-Z0-9]+$`) |
| `password` | obligatorio; 8–100 caracteres. Sin más restricciones de composición. |

**`201 Created`** → `{ "username": "maria123" }`

El usuario nace con rol `USER` y `active = true` (`User`, `V3`). **La respuesta no
incluye el rol** — ver §6.3.

Errores: `400 validation_error`, `409 user_already_exists`, `503 data_unavailable`.

### 3.2 `POST /api/auth/login`

```json
{ "username": "maria123", "password": "unaClaveSegura1" }
```

Ambos campos obligatorios. **No se valida el formato aquí a propósito** (aplicar
reglas distintas que en el registro delataría por qué se rechazó el login), así que
el frontend tampoco debe aplicar el patrón alfanumérico en esta pantalla.

**`200 OK`**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
  "refreshToken": "a1b2c3...",
  "username": "maria123",
  "accessTokenExpiresAt": "2026-08-21T02:40:14.219425Z",
  "refreshTokenExpiresAt": "2026-08-28T02:25:14.219425Z"
}
```

Ambos instantes son ISO-8601 en UTC, **con fracción de segundo de precisión de
microsegundos** *(observado)*. `Date.parse` los acepta sin trabajo extra. El frontend
los usa para **renovar antes de que expire**, en vez de esperar a un `401`.

| Token | Naturaleza | Vida |
|---|---|---|
| `accessToken` | JWT firmado (HS256), se valida en memoria | 15 min por defecto (`JWT_TTL_SECONDS`) |
| `refreshToken` | opaco, persistido, **revocable** | 7 días |

**Sobre el contenido del JWT** (`TokenService`): el `subject` es el **ID numérico**
del usuario y el `username` viaja como *claim* aparte. El frontend **no decodifica
el JWT**: lo trata como una cadena opaca y toma el `username` del cuerpo de la
respuesta. Decodificarlo acoplaría el frontend al formato interno del token, que ya
cambió una vez (ADR-002).

Errores: `401 invalid_credentials`, `423 account_locked`, `400 validation_error`,
`503 data_unavailable`.

El bloqueo se activa a los **5 intentos fallidos** y dura **60 segundos**
(`app.lockout` en `application.yml`; los valores reales se pueden consultar en
`/api/diagnostics`, ver §5).

### 3.3 `POST /api/auth/validate`

```json
{ "token": "<accessToken>" }
```

**`200 OK`**

```json
{ "username": "maria123", "expiresAt": "2026-08-21T02:40:14Z" }
```

**`expiresAt` aquí no tiene fracción de segundo, y en `/login` sí.** No es una
inconsistencia del contrato, son dos orígenes distintos del mismo instante:

- `/login` y `/refresh` serializan el `Instant` que genera el servicio
  (`now.plusSeconds(accessTtlSeconds)`), que conserva la precisión del reloj: por eso
  se observan **microsegundos** (§3.2).
- `/validate` **reconstruye** `expiresAt` desde el *claim* `exp` del JWT
  (`claims.getExpiration().toInstant()`), y `exp` es un **NumericDate**: segundos
  enteros desde la época. La fracción no viaja en el token, así que no puede volver.

Los dos valores corresponden **al mismo access token** y pueden diferir en esa
fracción. *(observado sobre un mismo token: `/login` devolvió
`"2026-08-21T04:32:21.262909Z"`, `/validate` devolvió `"2026-08-21T04:32:21Z"`, y el
claim crudo era `"exp":1787286741`.)*

**Consecuencia práctica:** para programar la **renovación proactiva**, el frontend usa
`accessTokenExpiresAt` de `/login` o de `/refresh`, no el `expiresAt` de `/validate`.
La diferencia es de menos de un segundo y no cambia ninguna decisión, pero fijar una
sola fuente evita comparar dos valores que no son idénticos para el mismo token.

Errores: `401 invalid_session`, `400 validation_error`.

**Nunca devuelve `503`**: se verifica la firma en memoria, sin tocar la base de
datos (ADR-08 de Taller 1). El frontend puede usarlo para restaurar la sesión al
recargar la página, con la garantía de que funciona aunque el tier de datos esté
caído.

**No devuelve el rol ni el ID del usuario** — ver §6.3.

### 3.4 `POST /api/auth/refresh`

```json
{ "refreshToken": "<refreshToken>" }
```

**`200 OK`** → el mismo cuerpo de `/login`, con un **par nuevo**.

**Rotación de un solo uso:** el `refreshToken` enviado queda invalidado en el mismo
momento en que se canjea. El frontend **debe reemplazar los dos tokens
almacenados**; conservar el anterior garantiza un `401 invalid_session` en la
siguiente renovación.

Consecuencia operativa: **dos renovaciones concurrentes con el mismo refresh token
fallan**, porque la primera lo consume. `src/platform/session` debe serializar la
renovación —una sola en vuelo, las demás peticiones esperan a que termine—.

Errores: `401 invalid_session` (inexistente o expirado), `400 validation_error`,
`503 data_unavailable`.

### 3.5 `POST /api/auth/logout`

```json
{ "refreshToken": "<refreshToken>" }
```

Dos respuestas posibles, **ambas de éxito**:

| HTTP | Cuerpo | Significado |
|---|---|---|
| `200 OK` | `{"revoked": true, "note": null}` | El refresh token se revocó. |
| **`202 Accepted`** | `{"revoked": false, "note": "El tier de datos no esta disponible: ..."}` | El tier de datos no respondía. El refresh token **sigue vivo**, pero el `accessToken` expira solo en ≤ 15 min. |

**El `202` no es un error y el frontend no debe tratarlo como tal**: en los dos
casos borra los tokens locales y vuelve al login. Es *best-effort* documentado en
ADR-08. Como el frontend ramifica por rango (`response.ok` cubre 200–299), el caso
se cubre solo, pero conviene registrar el `note` en consola.

---

## 4. Productos — ✅ VERIFICADO (contrato) / ⚠️ inaccesible hoy (§2)

Base: `/api/products`. **Nótese que la ruta está en inglés**, coherente con el resto
del código, no `/api/productos`.

### 4.1 Formas de datos

**Entrada** (`ProductRequest`, para `POST` y `PUT`):

```json
{ "name": "Teclado mecánico", "price": 19.99, "stock": 10 }
```

| Campo | Tipo | Validación **estructural** (→ `400`) |
|---|---|---|
| `name` | string | obligatorio, no en blanco, **máx. 120 caracteres** |
| `price` | número decimal | **obligatorio** (solo presencia) |
| `stock` | entero | **obligatorio** (solo presencia) |

**El `ProductRequest` no valida que `price > 0` ni que `stock >= 0`.** Eso es regla
de negocio y responde `422`, no `400` (ADR-004).

> **El frontend no evalúa reglas de negocio.** Solo hace validación **estructural**.
> `price > 0` y `stock >= 0` viven en el motor de reglas del backend, se pueden
> activar y desactivar por *feature toggle* (ADR-005) y llegan al cliente como
> `422` con `violations[]`. Una copia de esas reglas en el cliente sería una segunda
> fuente de verdad que **podría rechazar una operación que el servidor acepta** —por
> ejemplo, si el negocio habilita productos gratuitos apagando
> `price.must-be-positive`, un formulario que valide `precio > 0` por su cuenta
> bloquearía una operación perfectamente válida, y el defecto sería invisible desde
> el backend—. El formulario envía y deja que el servidor decida.

**La partición de responsabilidades, de fuera hacia dentro:**

| Nivel | Qué comprueba | Dónde vive | Qué devuelve |
|---|---|---|---|
| **Estructural** | Que el dato **exista y tenga la forma correcta**: obligatorio, tipo, longitud máxima. | Frontend **y** DTO (`ProductRequest`, `RegisterRequest`) — *sanity checking* en ambas interfaces | `400 validation_error` |
| **Semántica de negocio** | Que la operación **tenga sentido para el negocio**: precio positivo, nombre no repetido. Puede cambiar; es *toggleable*. | Motor de reglas (`ProductRule`, ADR-003/ADR-004) | `422 business_rule_violation` con `violations[]` |
| **Invariante** | Lo que **nunca** puede ser cierto en los datos, pase lo que pase. Última línea de defensa. | *Constraints* de PostgreSQL (`CHECK (price > 0)`, `CHECK (stock >= 0)`, `UNIQUE (name)`) | Error de integridad, traducido a `422` |

Que la validación estructural esté **duplicada** entre frontend y DTO es correcto y
deliberado: es *sanity checking* en cada interfaz, no una regla de negocio repartida.
Lo mismo aplica a replicar en el formulario de registro las reglas de §3.1 —3-50
caracteres, alfanumérico, contraseña de 8-100—: son restricciones de forma, fijas y
declaradas en el DTO, y comprobarlas antes de enviar solo evita un viaje. **No crean
una segunda fuente de verdad para reglas de negocio, porque no son reglas de
negocio.** La diferencia práctica: si el frontend se desincroniza en lo estructural,
el servidor responde `400` y el defecto es visible; si se desincronizara en lo
semántico, el frontend rechazaría en silencio operaciones válidas.

> `price` es monetario y el backend lo maneja como `BigDecimal` con `NUMERIC(12,2)`:
> **máximo 2 decimales y 10 dígitos enteros**. El frontend envía el número tal cual
> (JSON lo serializa sin pérdida a esa escala) y **no usa aritmética de punto
> flotante para totales**.

**Salida** (`ProductResponse`):

```json
{
  "id": 42,
  "name": "Teclado mecánico",
  "price": 19.99,
  "stock": 10,
  "active": true,
  "createdAt": "2026-08-20T18:04:11Z"
}
```

`active` refleja el borrado lógico. **Hoy siempre llega `true`**: todas las consultas
filtran por activos, así que un producto con `active: false` no es alcanzable por
ningún endpoint actual. El campo solo tendrá otro valor si se acepta la propuesta de
§6.2.

**Página** (`PageResponse<ProductResponse>`):

```json
{
  "content": [ /* ProductResponse[] */ ],
  "page": 0,
  "size": 20,
  "totalElements": 137,
  "totalPages": 7,
  "last": false
}
```

Es un tipo propio y **no** el `Page` de Spring Data, precisamente para que el
frontend no quede acoplado a la forma interna del framework (ADR-006). El paginador
de `src/crud/` se construye contra estos seis campos.

### 4.2 `GET /api/products` — listado paginado

| Parámetro | Tipo | Defecto | Notas |
|---|---|---|---|
| `name` | string | — | Búsqueda parcial, **sin distinguir mayúsculas**; se le aplica `trim`. Vacío o ausente = listar todo. |
| `page` | entero | `0` | Base 0. |
| `size` | entero | `20` | **Tope duro de 100** (`spring.data.web.pageable.max-page-size`). |
| `sort` | string | `name,asc` | Formato Spring: `campo,asc\|desc`. |

**`200 OK`** → `PageResponse<ProductResponse>`, solo productos activos.

⚠️ Pedir `size` mayor que 100 **no da error: Spring lo recorta en silencio** a 100.
El selector de tamaño de página del frontend se limita a valores ≤ 100 para que lo
que el usuario pide y lo que recibe coincidan.

⚠️ **`sort` con un campo que no existe en `Product` es una limitación abierta del
backend.** *(deducido del código — no verificable hoy: el endpoint responde `403` a
todo, §2, comprobado también con un `Bearer` válido.)*

`PageableHandlerMethodArgumentResolver` no valida el nombre del campo —no conoce el
tipo de dominio—, así que un `?sort=noExiste,asc` llega hasta Spring Data, que lanza
`PropertyReferenceException` al construir la consulta, **dentro** de
`ProductService.search()`. Y `search()` está anotado con
`@CircuitBreaker(name = "dataTier", fallbackMethod = "searchFallback")`: el
*fallback* recibe cualquier `Throwable`, comprueba si es `AppException` —no lo es— y
lo convierte en `DataUnavailableException`. El resultado esperado es, por tanto,
**`503 data_unavailable` con `retryable: true`**, no un `500 internal_error`.

Es peor que un `500`, y por eso se registra: `PropertyReferenceException` **no** está
en `ignore-exceptions` de Resilience4j, así que un parámetro mal escrito por un
cliente **cuenta como falla del tier de datos** en la ventana del circuit breaker y,
repetido, puede llegar a abrirlo para todos los usuarios. Es el mismo riesgo que
ADR-007 evita para las violaciones de negocio, por una vía que ese ADR no cubre.

**No es comportamiento deseable y no se documenta como contrato**: se reporta a Rol 1
para que lo confirme y decida (validar `sort` en el controlador lo convertiría en un
`400`). **Mitigación del frontend, independiente de lo que decida Rol 1:** `sort` se
construye **exclusivamente** a partir de los campos del descriptor marcados como
`sortable: true`, nunca desde texto libre ni desde un parámetro de URL. Así el
frontend no puede producir esta llamada.

Errores: `503 data_unavailable`.

### 4.3 `GET /api/products/{id}`

**`200 OK`** → `ProductResponse`. Errores: `404 product_not_found`, `503`.

Un producto dado de baja responde `404`, igual que uno inexistente: es deliberado,
para no filtrar que ese `id` existió alguna vez.

### 4.4 `POST /api/products` — crear (rol **ADMIN**)

Cuerpo: `ProductRequest`. **`201 Created`** → `ProductResponse` con el `id` asignado.

Como el frontend no puede leer `Location` (§1.1), **usa el cuerpo de la respuesta**
para insertar la fila nueva sin volver a pedir la lista.

Errores: `400 validation_error`, **`422 business_rule_violation`**,
`503 data_unavailable`.

Violaciones de negocio posibles al crear:

| `rule` | `field` | `message` |
|---|---|---|
| `price.must-be-positive` | `price` | El precio debe ser mayor a 0 |
| `stock.must-not-be-negative` | `stock` | El stock no puede ser negativo |
| `name.must-be-unique` | `name` | Ya existe un producto con ese nombre |

⚠️ **`name.must-be-unique` puede dispararse contra un producto que el usuario no ve.**
La unicidad del nombre es **global, no solo entre activos** (ADR-009): un producto
dado de baja **retiene su nombre para siempre**. Desde la UI esto se ve como "ya
existe un producto con ese nombre" mientras la tabla no muestra ninguno igual.

**El frontend muestra la violación tal como llega**, con el `message` del backend y
sin añadirle nada. No le corresponde explicar el borrado lógico: eso sería incorporar
al cliente conocimiento sobre el estado interno de los productos —qué existe pero no
se ve— que ninguna respuesta de la API le entrega, y que dejaría de ser cierto si
Rol 1 cambia ADR-009 sin avisar. **Si el mensaje debe ser más explícito, el cambio va
en el `message` de la regla**, que es donde vive esa información. Se registra aquí
como consecuencia observable del contrato, y la solución de fondo es la propuesta de
§6.2.

### 4.5 `PUT /api/products/{id}` — actualizar (rol **ADMIN**)

Cuerpo: `ProductRequest` **completo**. Es un reemplazo, no un parche: los tres
campos viajan siempre, incluso los que no cambiaron.

**`200 OK`** → `ProductResponse` actualizado.

`id`, `active` y `createdAt` **no son modificables**: el backend los ignora aunque se
envíen (`Product.applyChangesFrom`). El formulario no los expone como editables.

Errores: `400`, `404 product_not_found`, `422 business_rule_violation`, `503`.

Renombrar un producto conservando su propio nombre **no** dispara
`name.must-be-unique` (la regla excluye el propio `id`).

### 4.6 `DELETE /api/products/{id}` — borrado lógico (rol **ADMIN**)

**`204 No Content`**, **sin cuerpo**. El frontend no debe intentar parsear la
respuesta como JSON.

Errores: `404 product_not_found`, `503 data_unavailable`.

El borrado es lógico (`active = false`), pero **eso es un detalle de persistencia
que la API no expone**: tras el `DELETE`, el producto desaparece de todos los
listados y responde `404` por `id`. **No hay forma de deshacer esta operación con el
contrato actual** — ver §6.2.

---

## 5. Diagnóstico y salud — ✅ VERIFICADO

`GET /api/diagnostics` (público):

```json
{
  "circuitBreakerState": "CLOSED",
  "circuitBreakerFailureRate": -1.0,
  "lockoutPolicy": { "maxAttempts": 5, "lockoutSeconds": 60 },
  "features": { "newDashboard": false }
}
```

**Estado en el frontend: no se consume.** Ningún código actual llama a este endpoint
—[`app.js`](app.js) solo hace la petición de login— y no hay ningún commit aprobado
que lo introduzca. Se documenta como **información disponible**, no como dependencia
del tier de presentación.

Dos usos **posibles**, registrados aquí para no volver a investigarlos cuando se
evalúen, y que requieren decisión previa:

- **`lockoutPolicy`** permitiría decir "5 intentos, bloqueo de 60 s" en la pantalla de
  login sin *hardcodear* números que viven en la configuración del backend.
- **`features.newDashboard`** es un *feature toggle* del backend (ADR-06 de Taller 1).
  Consumirlo desde el frontend permitiría desacoplar despliegue de *release* también
  en este tier, pero **hoy no lo hace**, y adoptarlo convertiría un endpoint de
  diagnóstico en una dependencia de arranque de la UI. Es una decisión con
  consecuencias —qué se muestra si `/api/diagnostics` no responde— que merece su
  propio ADR antes de implementarse, no una nota en este documento.

`circuitBreakerFailureRate` vale `-1.0` mientras no haya llamadas suficientes para
calcularla (`minimum-number-of-calls: 3`) y pasa a un porcentaje real después; no es
un error. *(observado: `-1.0` recién arrancado el proceso, `0.0` tras varios logins.)*

`GET /actuator/health/liveness` y `/readiness` son públicos y los usa el
orquestador. El frontend **no los consulta**: no es su función monitorear el backend,
y hacerlo agregaría tráfico sin mejorar ninguna pantalla.

---

## 6. 🟡 PROPUESTO — pendiente de confirmación de Rol 1

> **Nada de esta sección existe en el código.** Son necesidades del tier de
> presentación, escritas en la forma en que el frontend las consumiría, para que
> Rol 1 pueda aceptarlas, modificarlas o rechazarlas. Se listan en orden de impacto
> sobre las pantallas.

### 6.1 CRUD de usuarios — `/api/users`

Registrado como **pendiente y bloqueado** en la tabla "Decisiones pendientes" de
`docs/DECISIONS.md` ("CRUD de Usuario (roles, soft delete, último ADMIN)"). Se
propone deliberadamente **espejando la forma de `/api/products`**: mismos verbos,
misma paginación, mismo cuerpo de error, mismos códigos. Si las dos formas coinciden,
el descriptor `src/resources/users.js` es una tabla de campos y nada más, y
`src/crud/` no se toca (ADR-F01).

> **Nombre de la ruta:** el encargo del taller la menciona como `/api/usuarios`. Aquí
> se propone `/api/users` por coherencia con `/api/products` y con el resto del
> código, que está en inglés. **Confirmar cuál se usa antes de que exista la
> implementación:** del lado del frontend el nombre vive en un solo sitio
> (`src/resources/users.js`), pero el costo del lado del backend no se estima aquí.

**Salida propuesta** (`UserResponse`) — espejo de `ProductResponse`:

```json
{
  "id": 7,
  "username": "maria123",
  "role": "USER",
  "active": true,
  "createdAt": "2026-08-20T18:04:11Z"
}
```

`passwordHash`, `failedAttempts` y `lockedUntil` **no deben exponerse**: son estado
interno de la política de bloqueo, no del recurso.

| Operación | Propuesta | Notas |
|---|---|---|
| `GET /api/users` | `PageResponse<UserResponse>`; `?username=` como filtro parcial, espejo de `?name=` | Solo activos, como en productos |
| `GET /api/users/{id}` | `UserResponse` o `404 user_not_found` | |
| `POST /api/users` | ¿existe? | **Ya hay `/api/auth/register`.** Duplicar la creación en dos rutas obligaría a mantener dos validaciones. La propuesta del frontend es **no crear este endpoint** y que la pantalla de alta use `register`. Se señala como pregunta abierta. |
| `PUT /api/users/{id}` | Cambio de `username` y/o `role` | Ver abajo |
| `DELETE /api/users/{id}` | `204`, borrado lógico | Ver abajo |

**Preguntas abiertas que el frontend necesita resueltas para dibujar la pantalla:**

1. **¿El cambio de rol va en `PUT /api/users/{id}` o en un endpoint propio?** El
   enunciado solo dice que un `ADMIN` puede cambiar roles. Si va en el `PUT` general,
   el formulario de edición incluye un selector de rol; si va aparte, es una acción
   separada en la fila. Cualquiera sirve; hay que saber cuál.

2. **El caso del último ADMIN.** `docs/DECISIONS.md` lo tiene abierto (punto 7 del
   checklist con Rol 2, sin respuesta). Cuando la operación se rechace, el frontend
   necesita **un `code` estable propio** —p. ej. `last_admin_protected`, `409` o
   `422`— para poder explicar por qué falló. Un `500` genérico o un mensaje libre no
   se pueden traducir a una UI útil. Aplica tanto a degradar el propio rol como a
   eliminar la cuenta.

3. **Cambiar el propio `username`.** ADR-002 dice que el `username` es mutable y que
   por eso el `subject` del JWT pasó a ser el ID. Si el frontend lo permite, el
   `username` que muestra —tomado del cuerpo de `/login` o de `/validate`— queda
   obsoleto en el mismo momento. ¿Se espera que el frontend fuerce una renovación de
   token tras el cambio, o el backend devuelve el usuario actualizado?

4. **Soft delete y login.** Está anotado en `DECISIONS.md` que hoy
   `AuthService.login()` usa `findByUsername()`, **que no filtra por `active`**: un
   usuario eliminado podría seguir iniciando sesión. No es una petición del frontend,
   pero sí determina si la pantalla de usuarios "elimina" de verdad. Se deja
   registrado aquí porque afecta lo que la UI puede prometer.

### 6.2 Restaurar un producto dado de baja

**Propuesta:** `POST /api/products/{id}/restore` → `200 OK` con el `ProductResponse`
reactivado.

Errores propuestos: `404 product_not_found` si el `id` no existe **o ya está activo**;
`422 business_rule_violation` si al reactivar se incumple alguna regla; `503`.

**Por qué se pide, con dos razones independientes:**

1. **La ventana de deshacer.** El `DELETE` de la tabla es una acción de una sola
   pulsación sobre una fila, y el patrón estándar es ofrecer "Deshacer" durante unos
   segundos. **Con el contrato actual eso es imposible de implementar honestamente:**
   no hay ninguna operación que ponga `active` de vuelta en `true`. `PUT` no sirve
   —`applyChangesFrom` ignora `active` a propósito, y además el producto ya responde
   `404`—. La única alternativa sería un diálogo de confirmación previo, que es peor
   para el usuario y sigue sin recuperar un borrado hecho por error hace un minuto.

2. **Cierra el problema práctico de ADR-009.** Como el nombre de un producto
   eliminado no se libera nunca, hoy un usuario que borra "Teclado mecánico" por
   error **no puede recrearlo**: el nombre está ocupado por un registro que no puede
   ver ni recuperar. Queda en un callejón sin salida cuya única salida es tocar la
   base de datos a mano. `restore` lo resolvería **sin revertir ADR-009**: el nombre
   sigue siendo globalmente único, y el producto original vuelve.

**Notas de forma de la propuesta:**

- **`POST` y no `PATCH`** deliberadamente: `CorsConfig` no permite `PATCH` (§1.1), así
  que un `PATCH` obligaría además a tocar configuración compartida de Rol 4.
- **Un sub-recurso `/restore` y no un campo `active` editable en el `PUT`**: mantiene
  la simetría con `deactivate()`, deja `active` fuera de `applyChangesFrom` —que es
  una decisión de dominio ya tomada y bien argumentada— y hace que la operación sea
  auditable como acción propia.
- **Costo:** requiere implementación, autorización y pruebas por parte de Rol 1; su
  tamaño debe estimarlo el responsable. Este documento no lo estima.
- **Autorización propuesta: `ADMIN`**, la misma que `DELETE`, por simetría con
  ADR-011.
- **Alcance:** si se acepta, el frontend necesita además poder **ver** los productos
  dados de baja para restaurarlos pasada la ventana de deshacer, lo que implica un
  filtro tipo `GET /api/products?active=false` o `?includeInactive=true`. Se plantea
  como **opcional y de segunda prioridad**: sin él, `restore` ya cubre el caso de
  deshacer inmediato, que es el que motiva la petición.

### 6.3 Exponer el rol del usuario autenticado

**Esta propuesta permite que la UI adapte la presentación según el rol.**

Hoy **ninguna respuesta del backend le dice al frontend qué rol tiene el usuario**:
`/login` devuelve `username` y los tokens; `/validate` devuelve `username` y
`expiresAt`; el JWT lleva `sub` (ID) y `username`, y **ningún *claim* de rol**. Pero
ADR-011 hace que `POST`/`PUT`/`DELETE` de productos sean exclusivos de `ADMIN`.

Sin el rol, al frontend solo le quedan dos opciones, ambas malas: mostrarle a todo
el mundo los botones de crear, editar y borrar y dejar que descubran por un `403` que
no pueden usarlos; o esconderlos siempre y dejar sin funcionalidad al `ADMIN`.

**Propuesta, en orden de preferencia:**

1. Agregar `"role": "ADMIN"` al cuerpo de **`/api/auth/login`** y de
   **`/api/auth/refresh`** (`TokenResponse`), y a **`/api/auth/validate`**
   (`ValidateResponse`). Es aditivo: ningún consumidor existente se rompe, igual que
   el `violations` de ADR-007.
2. Alternativa: un *claim* `role` dentro del JWT. Funciona, pero **obligaría al
   frontend a decodificar el token**, que es justo lo que §3.2 evita para no acoplarse
   a un formato que ya cambió una vez (ADR-002). Se prefiere la opción 1.

**En los dos casos, el rol que llega al frontend es solo para decidir qué se
muestra.** La autorización real la sigue haciendo el backend, y el frontend maneja el
`403` como caso posible de todas formas: un rol en el cliente es una comodidad de UI,
nunca un control de seguridad.

> Nota relacionada: `ValidateResponse` tampoco expone el `id` del usuario, aunque el
> JWT ya lo lleva como `subject` desde ADR-002. Si la pantalla de usuarios necesita
> identificar "yo" en la lista —para no ofrecer eliminarse a sí mismo—, hará falta
> también. Se menciona junto al rol porque afecta a las mismas respuestas de
> `/api/auth/**`.

### 6.4 Cabecera `Idempotency-Key` en mutaciones

**Propuesta:** El frontend enviará un UUID único en la cabecera `Idempotency-Key` en peticiones `POST`, `PUT` y `DELETE` para evitar duplicación de operaciones por reintentos o problemas de red.

⚠️ **Estado en el backend: no implementado hoy.** El backend actualmente no lee ni persiste esta cabecera. Enviarla desde el cliente es una declaración de intención y un mecanismo de *Safety* (Cap. 10), pero no ofrece garantías hasta que el servidor la procese. Se deja registrada como petición a Rol 1.

### 6.5 Mensaje de `name.must-be-unique` cuando el nombre pertenece a un producto eliminado

**Petición de revisión del `message` de la regla, dirigida a Rol 1.** No es una
capacidad implementada ni algo que el frontend vaya a resolver por su cuenta.

**El hecho, verificado:** la unicidad de `name` es **global y no se limita a los
productos activos** (ADR-009, `CONSTRAINT uq_products_name UNIQUE (name)`), y el
borrado es lógico. Un producto dado de baja **retiene su nombre para siempre**.

**Lo que ve el usuario:** al crear un producto puede recibir
`422 business_rule_violation` con
`{"rule":"name.must-be-unique","field":"name","message":"Ya existe un producto con ese nombre"}`
**mientras el listado no muestra ningún producto con ese nombre**, porque el que lo
ocupa está eliminado y ningún endpoint actual lo devuelve (§4.2, §4.3). El mensaje es
correcto y el usuario no tiene forma de entenderlo desde la UI.

**Lo que el frontend no va a hacer** (decisión ya tomada, ver §4.4): no reescribe, no
amplía ni interpreta el `message`. Muestra la violación tal como llega. Añadir aquí
"quizá pertenezca a un producto eliminado" sería meter en el cliente conocimiento
sobre el estado interno de los productos que ninguna respuesta le entrega, y que
dejaría de ser cierto si ADR-009 cambia.

**La petición:** si se decide que el usuario debe poder entender esta situación, esa
semántica tiene que venir **en el `message` de la regla del backend**
(`ProductNameMustBeUniqueRule`), que es el único punto que conoce el porqué. El
identificador `rule` (`name.must-be-unique`) debería permanecer estable aunque el
`message` cambie, porque forma parte del contrato estructurado y sirve para
diagnóstico y trazabilidad. Para mostrar la violación, el formulario utiliza `field`
para localizar el input y presenta el `message` entregado por el backend; no ramifica
ni incorpora comportamiento específico para esta regla.

Queda a criterio de Rol 1 aceptarla, rechazarla o resolverla por otra vía —por
ejemplo, la propuesta de restauración de §6.2, que ataca la causa en lugar del
mensaje—. Este documento no estima el costo de ninguna de las dos.

---

## 7. Resumen de estado

| # | Tema | Estado | Depende de |
|---|---|---|---|
| 1 | Autenticación (`/api/auth/**`) | ✅ Verificado y consumible hoy | — |
| 2 | Diagnóstico (`/api/diagnostics`) | ✅ Verificado y consumible hoy | — |
| 3 | Contrato de productos (`/api/products`) | ✅ Verificado en código | — |
| 4 | Acceso real a `/api/products` | ⚠️ **Bloqueado**: falta el filtro JWT y `@EnableMethodSecurity` (ADR-011) | Rol 2 |
| 5 | Cabecera `Authorization: Bearer` | 🟡 Propuesto — ningún endpoint la lee todavía | Rol 2 |
| 6 | Rol del usuario en la respuesta | 🟡 Propuesto (§6.3) | Rol 1 |
| 7 | `POST /api/products/{id}/restore` | 🟡 Propuesto (§6.2) | Rol 1 |
| 8 | CRUD de usuarios | 🟡 Propuesto (§6.1); ya registrado como pendiente por Rol 1 | Rol 1 / Rol 2 |
| 9 | Cabecera `Idempotency-Key` | 🟡 Propuesto (§6.4) — no honrado por el backend aún | Rol 1 |
| 10 | `message` de `name.must-be-unique` con nombre de producto eliminado | 🟡 Propuesto (§6.5) — petición de revisión; el frontend no amplía el mensaje | Rol 1 |

**Este documento se actualiza cuando cambia el código, no cuando cambia la pantalla.**
Si una sección ✅ deja de coincidir con el backend, es un defecto de este archivo.
