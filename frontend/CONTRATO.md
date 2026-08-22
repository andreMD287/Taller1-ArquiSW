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
| ✅ **VERIFICADO** | Leído directamente del código del backend tal como está integrado en la rama `thomas`, es decir el estado que dejó el último merge de `origin/main` (hoy `2c5b7e8`) — que es el que trae la seguridad activa: `d22c8bc feat(security): habilita autenticacion JWT y autorizacion por roles` y `7904528 docs: registra decisiones de seguridad JWT y RBAC`. **La referencia vinculante es el código de la rama, no el hash**: un merge posterior lo desplaza sin invalidar este documento, y los hashes se citan solo para fechar qué entró. Las fuentes concretas se citan en cada sección. Si el código cambia y este documento no, **el documento está mal**. |
| 🟡 **PROPUESTO** | **No existe en el código.** Es una petición del frontend, pendiente de confirmación de Rol 1. Nada de esto puede darse por implementado. |
| ⚠️ **BLOQUEANTE / ABIERTO** | Verificado en el código, y hoy limita o impide que el frontend funcione. Requiere una decisión o el trabajo de algún rol. |

**Fuentes verificadas:** `backend/src/main/java/com/taller/auth/product/api/`
(`ProductController`, `ProductRequest`, `ProductResponse`, `PageResponse`),
`controller/AuthController.java`, `controller/DiagnosticsController.java`,
`dto/`, `exception/`, `config/SecurityConfig.java`, `config/CorsConfig.java`,
`security/RequestIdFilter.java`, `application.yml`,
`db/migration/V3__users_roles_products.sql`, `repository/UserRepository.java`,
`service/TokenService.java`, `service/AuthService.java`, y los tests
`ProductControllerTest`, `ErrorContractTest`, `TokenServiceTest` y `AuthServiceTest`.

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

### 1.5 Respuestas de seguridad: 401 y 403 — ✅ VERIFICADO (ejecutado)

**Las dos respuestas de seguridad NO tienen la misma forma.** No hay uniformidad
que asumir y este documento no la inventa: cada una nace en un sitio distinto del
backend y por eso trae campos distintos.

#### 401 — falta autenticación o el JWT no es válido

Lo produce el `authenticationEntryPoint` de `SecurityConfig`, que escribe el JSON
a mano. **No pasa por `GlobalExceptionHandler`**, así que NO es un `ErrorResponse`
completo: trae un único campo.

```
$ curl -i http://localhost:8080/api/products
HTTP/1.1 401
X-Request-Id: e5f9c365-4a75-40e9-a4f3-dabf95398172
Content-Type: application/json;charset=ISO-8859-1
{"code":"unauthorized"}
```

Idéntico con un `Bearer` ilegible o caducado: `JwtAuthenticationFilter` captura
`InvalidSessionException`, limpia el `SecurityContext` y deja seguir la petición,
que `.anyRequest().authenticated()` rechaza en el entry point.

Sin `message`, sin `kind`, sin `retryable`, sin `detail` y **sin `requestId` en el
cuerpo**: el único correlacionador es la cabecera `X-Request-Id`.

#### 403 — autenticado, pero sin el rol requerido

Lo produce `@PreAuthorize("hasRole('ADMIN')")` lanzando `AuthorizationDeniedException`,
que **sí** tiene `@ExceptionHandler` en `GlobalExceptionHandler`. Por eso llega un
`ErrorResponse` completo:

```
$ curl -i -X POST http://localhost:8080/api/products \
       -H "Authorization: Bearer <token de un USER>" -H 'Content-Type: application/json' \
       -d '{"name":"X","price":1.0,"stock":1}'
HTTP/1.1 403
X-Request-Id: e837eef7-e679-4766-be03-0551980786c1
Content-Type: application/json
{"code":"access_denied","kind":"EXPECTED","message":"No tiene permisos para realizar esta operacion",
 "retryable":false,"requestId":"e837eef7-e679-4766-be03-0551980786c1"}
```

`detail` y `violations` van **ausentes**, no en `null` (`@JsonInclude(NON_NULL)`).

**Advertencia — hay una segunda forma posible de 403.** `SecurityConfig` también
declara un `accessDeniedHandler` que escribe el JSON mínimo
`{"code":"access_denied"}`. Se dispara si la denegación ocurre en la cadena de
filtros en vez de en el método. Con los matchers actuales (`.anyRequest().authenticated()`)
un usuario autenticado no cae por ahí para `/api/products`, así que **no se ha
observado en ejecución**; queda registrado porque el código lo permite. Es decir:
**dos respuestas con el mismo `code` y cuerpos distintos**.

#### Qué se le exige, por tanto, al cliente HTTP

1. **Seguir tolerando cuerpo vacío o JSON parcial.** Ya no es el caso actual, pero
   sí sigue siendo posible: el handler mínimo de arriba, un `204`, un proxy que
   devuelva HTML, un cuerpo truncado. Un `await response.json()` incondicional
   convertiría un rechazo previsto en un fallo del frontend. `platform/errors.js`
   lee texto y solo parsea si el texto es JSON válido; si no lo es, **no fabrica un
   `code`**. Cubierto por la prueba "403 sin cuerpo (robustez, no el caso actual)"
   de `tests/platform.test.js`, conservada exactamente con ese propósito.
2. **No exigir campos que el backend puede no mandar.** El 401 vigente no trae
   `message`, `kind` ni `requestId` en el cuerpo, y el modelo interno los normaliza
   a `null` sin inventarlos (prueba `app 36`; `app 37` cubre los `403` parciales o no parseables).
3. **`X-Request-Id` llega siempre.** `RequestIdFilter` corre con
   `HIGHEST_PRECEDENCE`, antes de la cadena de seguridad, así que la cabecera está
   incluso cuando el cuerpo no dice nada. Es el hilo con los logs del backend.
4. **`category` (frontend) y `code` (backend) siguen siendo espacios de nombres
   distintos.** `category` la decide `platform/errors.js` a partir del status para
   que la UI no ramifique sobre números HTTP; `code` es siempre del backend y nunca
   se fabrica. Que hoy el backend sí mande `code` en ambas respuestas no las funde:
   un 403 sin cuerpo sigue dando `code: null` y `category: "forbidden"`.
5. **Un `403` no significa "la sesión es inválida".** No se refresca y no se cierra
   sesión: significa que **esta operación** excede el rol. Un `401`, en cambio, sí
   devuelve al login.

#### Nota de disponibilidad

El 403 de `@PreAuthorize` trae `kind: "EXPECTED"`, así que la regla única de
`platform/metrics.js` lo cuenta como **disponible** — correctamente: negarle a un
USER una escritura de ADMIN es el sistema cumpliendo su especificación, no una
caída. Un 403 *sin* `kind` seguiría contando como no disponible.

#### Renovación reactiva ante un 401 — ✅ RESUELTO

Cuando una petición que **salió con `Authorization: Bearer`** recibe un `401`,
`platform/http.js` pide **una** renovación al proveedor de sesión y reintenta la
petición **una** sola vez, con el token nuevo.

Los dos `code` posibles cuentan por igual —`invalid_session` y `unauthorized`—
porque solo se distinguen por **dónde nacen**, no por lo que significan para el
cliente: `invalid_session` sale de un controlador de `/api/auth/**`, y
`unauthorized` del entry point de `SecurityConfig`, que es el que llega en
cualquier endpoint protegido. Un access token caducado contra `/api/products`
produce SIEMPRE el segundo, porque `JwtAuthenticationFilter` captura
`InvalidSessionException`, limpia el `SecurityContext` y deja seguir la petición,
que muere en `.anyRequest().authenticated()` sin alcanzar nunca un controlador.

**El frontend NO puede distinguir un token vencido de uno ilegible.** El filtro
trata ambos igual y los dos llegan como `unauthorized`. El cliente no decodifica
el JWT para averiguarlo: pide un refresh y deja que el backend decida. Si el
token era irrecuperable, la renovación fallará y **ese** error es el que se
propaga.

**Un `401` sobre una petición SIN `Authorization` no dispara nada.** Se propaga
tal cual, con su `requestId` de cabecera, sin tocar la sesión: no había sesión
que renovar. No basta con mirar el parámetro `auth`, porque una llamada a un
endpoint protegido hecha sin sesión conserva el valor por defecto `auth:true` y
aun así sale sin token. `http.js` captura, justo después de construir las
cabeceras, si esa petición concreta llevó `Authorization`, y no vuelve a
preguntarle al proveedor: entre la salida y la respuesta puede haber ocurrido un
login, un logout o un refresh, y consultarlo después respondería por el estado
de *ahora*, no por el de esa petición.

Garantías del reintento:

| Garantía | Cómo se sostiene |
|---|---|
| Exactamente un refresh y un reintento | El reintento va con `retryAuth:false`, así que un segundo `401` se propaga sin volver a entrar en el ciclo |
| Token nuevo en el reintento | Se reconstruyen las cabeceras; `http.js` no manipula el token, lo pide con `getToken()` |
| Una muestra de métricas por intento | Son dos peticiones HTTP reales; ocultar una falsearía la disponibilidad medida |
| El error del refresh se propaga tal cual | Un `503` de la renovación llega al llamador como `503` con **su** `requestId`, no disfrazado del `401` que lo destapó |
| Refresh concurrentes coordinados en un solo sitio | `session.js` es el único dueño de la promesa de renovación. Si diez peticiones reciben `401` a la vez, hay **un** canje del refresh token. `http.js` pide renovar; no coordina |

Un `403` nunca refresca (§1.5, punto 5): no dice que la sesión sea inválida.

---

## 2. Autorización de productos — ✅ VERIFICADO

**Verificado leyendo `config/SecurityConfig.java`, `security/JwtAuthenticationFilter.java`,
`product/api/ProductController.java` y `test/.../integration/ProductSecurityIT.java`,
y ejercitando el backend en local.**

Lo que antes figuraba aquí como bloqueante —filtro JWT ausente, `@EnableMethodSecurity`
ausente, `/api/products` rechazando a todo el mundo, `@PreAuthorize` inertes— **quedó
superado**: esas piezas llegaron juntas, como ADR-011 exigía. Estado vigente:

| Pieza | Estado |
|---|---|
| `JwtAuthenticationFilter` | Registrado con `addFilterBefore(..., UsernamePasswordAuthenticationFilter.class)`. Valida el access token con `TokenService`. |
| Claim `role` | Firmado en el JWT y traducido a la authority `ROLE_USER` o `ROLE_ADMIN`. |
| `@EnableMethodSecurity` | **Activo** en `SecurityConfig`, junto a `@EnableWebSecurity`. |
| `@PreAuthorize("hasRole('ADMIN')")` | **Se aplica**: ya no es una anotación ignorada en silencio. |

| Operación | Requisito | Verificado en |
|---|---|---|
| `GET /api/products`, `GET /api/products/{id}` | Autenticado (cualquier rol) | `ProductSecurityIT.usuarioAutenticadoPuedeConsultarProductos` |
| `POST /api/products` | **ADMIN** | `usuarioNormalNoPuedeCrearProductos` / `adminPuedeCrearProductos` |
| `PUT /api/products/{id}` | **ADMIN** | `@PreAuthorize` en `ProductController` |
| `DELETE /api/products/{id}` | **ADMIN** | `usuarioNormalNoPuedeEliminarProductos` / `adminPuedeEliminarProductos` |
| Sin token o token inválido | 401 | `listadoSinJwtEsRechazado` / `jwtInvalidoEsRechazado` |

**Alcance de esa evidencia:** `ProductSecurityIT` afirma **códigos de estado**, no
cuerpos. Ninguna de sus pruebas comprueba que el 403 pase por
`GlobalExceptionHandler`. Las formas de cuerpo documentadas en §1.5 se obtuvieron
ejecutando el backend en local, no de esas pruebas — y se marcan como observadas,
no como garantizadas por la suite del backend.

**Lo que el frontend hace con esto — y lo que NO.** La interfaz oculta las acciones
de escritura a quien no es ADMIN (`descriptor.permits.write`, resuelto por
`app.js#can`). Eso es **adaptación visual, no seguridad**: el backend vuelve a
comprobar el rol en cada petición. Ocultar el botón ahorra un rechazo previsible;
no protege nada frente a una llamada directa al API. Por eso el manejo del `403`
sigue existiendo aunque la UI creyera que la operación era imposible: un rol
obsoleto en pantalla, otra pestaña o un cambio de rol en servidor bastan para que
llegue.

### 2.1 Cómo se envía el token — ✅ VERIFICADO

`Authorization: Bearer <accessToken>`, que es lo que lee `JwtAuthenticationFilter`
(`request.getHeader(HttpHeaders.AUTHORIZATION)`, prefijo `"Bearer "`). Lo que antes
era una suposición pendiente de confirmar con Rol 2 está ahora leído en el código.

Sigue siendo cierto que `/api/auth/**` recibe los tokens **en el cuerpo**
(`{"token": ...}`, `{"refreshToken": ...}`) y no por cabecera: son endpoints
`permitAll()` y no pasan por el filtro.

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

El usuario nace con rol `USER` y `active = true` (`User`, `V3`). **La respuesta de
`register` no incluye el rol**; el rol sí viaja, firmado, dentro del `accessToken`
que devuelve `/login` — ver §3.2 y §6.3.

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

**Contenido del JWT** (`TokenService.buildAccessToken`, firmado con HS256):

| *Claim* | Contenido |
|---|---|
| `sub` | **ID numérico e inmutable** del usuario (ADR-002) |
| `username` | nombre de usuario vigente al emitir el token; es mutable |
| `role` | **`ADMIN` o `USER`** |
| `jti`, `iss`, `iat`, `exp` | identificador del token, emisor, emisión y expiración |

**El `role` es un *claim* firmado y está presente desde el merge de `origin/main`.**
No es opcional para el backend: `validateAccessToken` **rechaza** con
`401 invalid_session` un token sin `role` o con un valor que no sea `ADMIN` ni `USER`
(pruebas `validateAccessTokenRechazaJwtSinRole` y
`validateAccessTokenRechazaJwtConRoleInvalido`).

**Lo que el frontend puede y no puede hacer con eso:**

- `TokenResponse` —el cuerpo de `/login` y `/refresh`— **todavía no tiene una
  propiedad JSON `role`**. El rol no llega como campo de la respuesta.
- Mientras eso siga así, el frontend **puede decodificar localmente el *payload* del
  access token** para leer `role` y adaptar la presentación (mostrar u ocultar los
  botones de crear, editar y borrar).
- **Decodificar el *payload* no es validar el token.** No comprueba la firma, no
  concede permiso alguno y no debe usarse como frontera de seguridad: cualquiera
  puede fabricar un JSON con `"role":"ADMIN"`, y el backend lo rechazaría igual.
  **La autorización real es responsabilidad exclusiva del backend.**
- Solo se aceptan como rol de UI los valores exactos `ADMIN` y `USER`. Ante un token
  mal formado, sin el *claim* o con cualquier otro valor, el frontend trata el rol
  como **desconocido (`null`)** y elige la presentación más restrictiva.
- El `username` que se muestra se sigue tomando del **cuerpo de la respuesta**, no
  del token.

Errores: `401 invalid_credentials`, `423 account_locked`, `400 validation_error`,
`503 data_unavailable`.

⚠️ **Un usuario desactivado no puede iniciar sesión.** `AuthService.login()` consulta
`findByUsernameAndActiveTrue`, así que un usuario con `active = false` es tratado
exactamente igual que uno inexistente: **`401 invalid_credentials`**, sin ninguna
señal que permita distinguir los dos casos (prueba
`loginConUsuarioInactivoEsRechazadoComoCredencialesInvalidas`). Es deliberado —no
revelar qué cuentas existen— y tiene una consecuencia para la UI: **el frontend no
puede decir "tu cuenta fue desactivada"**, porque el backend no se lo dice y
**no debe inventar un código como `user_inactive`** que la API no entrega.

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

**`ValidateResponse` contiene únicamente `username` y `expiresAt`**: no devuelve el
rol ni el ID del usuario, aunque el token que se le entrega sí los lleva como
*claims* (§3.2). Para conocer el rol, el frontend decodifica el *payload* del access
token que ya tiene; no necesita esta llamada — ver §6.3.

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

⚠️ **Cada `/refresh` puede traer un rol distinto.** `TokenService.refresh` no se
limita a rotar el token: consulta el usuario con `findByIdAndActiveTrue` y emite el
access token nuevo con el **`username` y el `role` vigentes en ese momento** (prueba
`refreshUsaUsernameYRoleActualesDelUsuario`). Un cambio de rol hecho por un `ADMIN`
se refleja en la UI en la siguiente renovación, sin volver a pedir credenciales. Por
eso el frontend debe **recalcular el rol después de guardar el par nuevo**, no
conservar el que leyó al iniciar sesión.

⚠️ **Un usuario desactivado no puede renovar.** Si la cuenta pasó a `active = false`
después de haber iniciado sesión, `findByIdAndActiveTrue` no la encuentra y el
refresh responde **`401 invalid_session`** (prueba
`refreshRechazaUsuarioInactivoONoEncontrado`). Es indistinguible de un refresh token
expirado o ya usado, y también aquí **el frontend no debe inventar un código propio**.
La reacción es la misma en todos los casos: **limpiar la sesión local y volver al
login**. El access token que ya tenga en memoria seguirá siendo criptográficamente
válido hasta que expire (≤ 15 min); es la ventana de revocación aceptada en ADR-08.

Errores: `401 invalid_session` (refresh token inexistente, expirado o ya usado, **o
usuario desactivado**), `400 validation_error`, `503 data_unavailable`.

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

## 4. Productos — ✅ VERIFICADO (contrato y acceso, §2)

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
backend.** *(deducido del código. Ahora que el endpoint es accesible (§2) se podría
ejercitar de punta a punta; aquí sigue marcado como deducido porque no se ha hecho.)*

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

2. **El caso del último ADMIN.** Aquí hay que separar dos cosas que es fácil
   confundir, porque una ya existe y la otra no:

   **(a) El contrato de error — ✅ VERIFICADO en código.** Ya no hace falta pedirlo:
   `exception/LastAdminException.java` lo fija, y el frontend puede programar contra
   él desde ya. Leído directamente de la clase:

   | Campo | Valor |
   |---|---|
   | `code` | `last_admin_protected` |
   | HTTP | `409 Conflict` |
   | `kind` | `EXPECTED` — no cuenta contra la disponibilidad (ADR-007) |
   | `retryable` | `false` — reintentar daría exactamente lo mismo |
   | `message` | `"No se puede desactivar ni quitar el rol al ultimo administrador activo"` |

   Hereda de `AppException`, así que `GlobalExceptionHandler` la traduce a un
   `ErrorResponse` completo con su `requestId`, igual que cualquier otro error de
   negocio. Es exactamente el `code` estable que esta sección venía pidiendo: la
   pregunta queda **respondida**.

   **(b) La protección en sí — ⚠️ PENDIENTE, no implementada.** Que el contrato esté
   definido **no significa que la regla se aplique**. Verificado por búsqueda sobre
   el código integrado:

   - `LastAdminException` **no se lanza ni se construye en ningún sitio**: la única
     aparición en todo `backend/src/` es su propia declaración.
   - `UserRepository.findActiveByRoleForUpdate(Role)` existe con
     `@Lock(PESSIMISTIC_WRITE)` —el interlock que haría segura la comprobación frente
     a dos operaciones concurrentes— pero **nadie la invoca**. Lo mismo vale para
     `countByRoleAndActiveTrue`.
   - **No existe operación administrativa de usuarios** que pudiera aplicar la regla:
     no hay servicio de usuarios, no hay endpoint fuera de `/api/auth/**` y
     `/api/diagnostics`, y en código productivo nadie llama a `User.setRole()` ni
     desactiva una cuenta.
   - **No hay pruebas** de la invariancia: ninguna prueba del backend menciona la
     regla, y no existe ninguna prueba concurrente —no aparece `ExecutorService`,
     `CountDownLatch` ni `CompletableFuture` en toda la suite— que demuestre que dos
     operaciones simultáneas no pueden dejar el sistema sin administradores.

   Es decir: hoy son **piezas preparatorias**, no comportamiento ejecutable. Cuando
   exista el CRUD de usuarios (esta misma §6.1, aún propuesta), la regla tendrá que
   implementarse y probarse; el frontend no la replica ni la anticipa —§4.1— y se
   limitará a mostrar el `message` del `409 last_admin_protected` si algún día llega.

   **Aplica tanto a degradar el propio rol como a eliminar la cuenta**, según dice el
   mensaje de la excepción.

3. **Cambiar el propio `username`.** ADR-002 dice que el `username` es mutable y que
   por eso el `subject` del JWT pasó a ser el ID. Si el frontend lo permite, el
   `username` que muestra —tomado del cuerpo de `/login` o de `/validate`— queda
   obsoleto en el mismo momento. ¿Se espera que el frontend fuerce una renovación de
   token tras el cambio, o el backend devuelve el usuario actualizado?

4. ~~**Soft delete y login.**~~ **RESUELTO** en el merge de `origin/main`. Lo que
   estaba anotado en `DECISIONS.md` —que `AuthService.login()` usaba
   `findByUsername()` sin filtrar por `active`, y por tanto un usuario eliminado
   podría seguir iniciando sesión— **ya no es cierto**: `login()` usa
   `findByUsernameAndActiveTrue` y `refresh` usa `findByIdAndActiveTrue` (§3.2, §3.4).
   La pantalla de usuarios sí "elimina" de verdad: la cuenta desactivada no puede
   iniciar sesión ni renovar. Queda una consecuencia para la UI, no un bloqueo: el
   rechazo es indistinguible de unas credenciales incorrectas o de una sesión
   vencida, así que **no se puede mostrar un mensaje específico de "cuenta
   desactivada"** salvo que Rol 1 decida entregar un `code` propio, cosa que hoy no
   hace y que tampoco es evidente que convenga (revelaría qué cuentas existen).

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

### 6.3 Exponer el rol en el cuerpo de las respuestas de `/api/auth/**`

**Esta propuesta permite que la UI adapte la presentación según el rol.**

**Ya no es bloqueante.** El merge de `origin/main` agregó un *claim* `role` firmado al
access token (§3.2), así que el frontend **ya puede** saber si el usuario es `ADMIN` o
`USER` decodificando el *payload* del token que tiene, y ADR-011 —`POST`/`PUT`/`DELETE`
de productos exclusivos de `ADMIN`— deja de obligar a elegir entre mostrarle a todo el
mundo botones que darán `403` o esconderlos también al administrador.

**Lo que sigue faltando, y por qué se mantiene la petición:**

- `TokenResponse` (`/login`, `/refresh`) **no tiene una propiedad `role`**.
- `ValidateResponse` (`/validate`) sigue siendo solo `username` y `expiresAt`.

Mientras eso siga así, leer el rol obliga al frontend a **depender del formato interno
del token** —partirlo por puntos, decodificar base64url, buscar un *claim*—. Ese
formato ya cambió una vez (ADR-002 movió el `subject` de `username` a ID) y volverá a
cambiar sin que el contrato HTTP lo refleje. Es acoplamiento real, aunque hoy no
impida trabajar.

**Propuesta:** agregar `"role": "ADMIN"` al cuerpo de **`/api/auth/login`** y
**`/api/auth/refresh`** (`TokenResponse`), y a **`/api/auth/validate`**
(`ValidateResponse`). Es aditivo —ningún consumidor existente se rompe, igual que el
`violations` de ADR-007— y permitiría al frontend dejar de decodificar el token.

**Prioridad: mejora del contrato, no impedimento.** Se registra para que Rol 1 decida
con la información completa; el frontend no queda esperándola.

**En cualquiera de los dos caminos, el rol que llega al cliente es solo para decidir
qué se muestra.** La autorización real la sigue haciendo el backend, el frontend
maneja el `403` como caso posible de todas formas (§1.5), y un rol en el cliente
—venga de un campo JSON o de un *claim* decodificado— es **una comodidad de
presentación, nunca un control de seguridad**.

> Nota relacionada: `ValidateResponse` tampoco expone el `id` del usuario, aunque el
> JWT lo lleva como `subject` desde ADR-002. Si la pantalla de usuarios necesita
> identificar "yo" en la lista —para no ofrecer eliminarse a sí mismo—, aplica lo
> mismo: hoy se puede leer del token, y exponerlo en el cuerpo reduciría el
> acoplamiento. Se menciona junto al rol porque afecta a las mismas respuestas de
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
| 4 | Acceso real a `/api/products` | ✅ **Desbloqueado**: `JwtAuthenticationFilter` y `@EnableMethodSecurity` ya están activos; leer exige autenticación y escribir exige ADMIN (§2, ADR-011) | — |
| 4b | Refresh reactivo ante un access token caducado en `/api/products` | ✅ **Resuelto**: un `401` sobre una petición con `Bearer` —`invalid_session` o `unauthorized`— dispara un único refresh y un único reintento; sin `Bearer` se propaga tal cual (§1.5) | — |
| 5 | Cabecera `Authorization: Bearer` | ✅ Verificado: es la que lee `JwtAuthenticationFilter` (§2.1) | — |
| 6 | Rol del usuario | ✅ Disponible como *claim* firmado en el access token (§3.2). 🟡 Sigue propuesto exponerlo en el cuerpo de las respuestas (§6.3), como mejora no bloqueante | Rol 1 |
| 6b | Usuarios desactivados no inician sesión ni renuevan | ✅ Verificado tras el merge (§3.2, §3.4). Cierra la pregunta 4 de §6.1 | — |
| 7 | `POST /api/products/{id}/restore` | 🟡 Propuesto (§6.2) | Rol 1 |
| 8 | CRUD de usuarios | 🟡 Propuesto (§6.1); ya registrado como pendiente por Rol 1 | Rol 1 / Rol 2 |
| 8b | Código de error del último ADMIN | ✅ Verificado: `LastAdminException` fija `last_admin_protected`, `409`, `EXPECTED`, no reintentable (§6.1). Cierra la pregunta 2 de §6.1 | — |
| 8c | Protección del último ADMIN en ejecución | ⚠️ **Pendiente**: la excepción no se lanza, `findActiveByRoleForUpdate` no se invoca, no hay operación administrativa que aplique la regla ni pruebas —tampoco concurrentes— (§6.1) | Rol 1 / Rol 2 |
| 9 | Cabecera `Idempotency-Key` | 🟡 Propuesto (§6.4) — no honrado por el backend aún | Rol 1 |
| 10 | `message` de `name.must-be-unique` con nombre de producto eliminado | 🟡 Propuesto (§6.5) — petición de revisión; el frontend no amplía el mensaje | Rol 1 |

**Este documento se actualiza cuando cambia el código, no cuando cambia la pantalla.**
Si una sección ✅ deja de coincidir con el backend, es un defecto de este archivo.
