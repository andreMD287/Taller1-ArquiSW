# Prompts de Claude Code — Rol 3 (Frontend), por commit

Registro de los encargos con los que se construye el tier de presentación, uno por
commit. Sirve para que el trabajo sea reproducible y auditable: cada entrada dice
sobre qué código opera, qué debe producir y qué no debe tocar.

> **Nota sobre este archivo.** No existía en el repositorio al momento de escribir
> esta versión —no estaba en disco, ni en el índice, ni en ningún commit de ninguna
> rama—, así que se crea aquí con el prompt del commit 3 ya sincronizado con el
> estado real del código tras el merge de `origin/main` en `thomas` (`cce0957`).
> Los commits 1 y 2 se resumen para dar contexto; su prompt original no se
> reconstruye porque no se conserva.

## Estado

| # | Commit | Estado |
|---|---|---|
| 1 | `docs: contrato de API consumido por el frontend y ADR-F01 (estructura del tier de presentacion)` (`4847dff`) | Hecho |
| 2 | `feat: configuracion externa y cliente HTTP unico con timeout, correlacion y medicion` (`09301f5`) | Hecho |
| 3 | `feat: sesion con refresh silencioso, cola de refresh y eventos de sesion` (`e292902`) | Hecho — prompt abajo |
| 4 | `docs: registra ADR-F02 (cliente HTTP unico) y ADR-F03 (timeout, presupuesto y degradacion)` | **Listo para guardar — sin commit todavía** |

Lo que el commit 2 dejó en pie y que el commit 3 debe respetar:

- `frontend/config.js` — configuración externa (`apiBaseUrl`, `requestTimeoutMs`,
  `latencyBudgetMs`, `pageSize`) y `resolveUrl()`.
- `frontend/src/platform/http.js` — **único** archivo que llama a `fetch()`. Ya
  expone `get/post/put/del`, `configureAuthProvider()`, `configureHttp()`,
  `resetHttpConfig()` y `HttpError`.
- `frontend/src/platform/errors.js` — modelo interno único de error, con `category`,
  `fromResponse()`, `fromTransportFailure()` y `fromClientFailure()`.
- `frontend/src/platform/metrics.js` — una muestra por intento HTTP, regla única de
  `available`.
- `frontend/tests/` — arnés propio sin dependencias (23 pruebas), ejecutable en
  navegador sirviendo el repo por HTTP.

---

## Commit 3 — Sesión, refresh silencioso y eventos

**Mensaje:** `feat: sesion con refresh silencioso, cola de refresh y eventos de sesion`

```text
Soy Rol 3 (frontend) del repositorio Taller1-ArquiSW. Implementa únicamente el
tercer commit: la gestión de sesión del tier de presentación.

Antes de modificar nada, lee el código real que ya existe. No asumas contexto:

- frontend/config.js
- frontend/src/platform/http.js
- frontend/src/platform/errors.js
- frontend/src/platform/metrics.js
- frontend/tests/**
- frontend/CONTRATO.md (secciones 1.5, 2, 3.2, 3.3, 3.4, 3.5 y 6.3)
- docs/DECISIONS-FRONTEND.md (ADR-F01)

Trabaja únicamente dentro de frontend/**. No modifiques backend/**, docs/**,
frontend/app.js, frontend/index.html ni frontend/styles.css. No implementes
todavía el motor CRUD, la caché, el debounce ni las pantallas de recursos.

## 1. Crea frontend/src/platform/session.js

Es un archivo NUEVO en esa ruta exacta. El cliente HTTP ya existe: se AJUSTA
frontend/src/platform/http.js, no se vuelve a crear.

Dirección de dependencias, que no se negocia:

- http.js NUNCA importa session.js. Ese es el ciclo que ADR-F01 y el propio
  comentario de http.js prohíben.
- session.js SÍ puede importar el API público de http.js.
- La comunicación en sentido contrario va por el proveedor inyectado que ya
  existe: configureAuthProvider(). Reutilízalo, no lo reemplaces.

Extiende el contrato del proveedor inyectado para que http.js pueda pedir una
renovación y notificar eventos sin conocer el módulo de sesión. Hoy el proveedor
solo declara getToken(). El contrato completo pasa a ser, en términos de
capacidades y sin nombrar a quien las implementa:

- getToken()      -> string | null. El access token vigente, o null.
- refresh()       -> Promise. Solicita una renovación. Ver "resultado del
                     refresh" más abajo: NO devuelve un booleano.
- notify(event)   -> void. Informa un evento observado por el transporte.

Documenta esa forma en http.js. Las tres son opcionales: si el proveedor no
declara alguna, http.js debe seguir funcionando (sin autorización, sin reintento
tras 401, o sin notificar).

PROPIETARIO ÚNICO DE LA PROMESA DE REFRESH

La única promesa de refresh en vuelo vive en session.js. No en http.js.

- session.refresh() es IDEMPOTENTE mientras haya una renovación en curso: todas
  las llamadas concurrentes reciben EXACTAMENTE la misma promesa, no una nueva.
- Esa misma coordinación cubre las tres fuentes posibles de renovación:
    1. la renovación proactiva disparada por el temporizador;
    2. la renovación que pide http.js tras un 401 invalid_session;
    3. una renovación manual futura.
- http.js NO debe tener una segunda cola ni una segunda variable refreshPromise.
  Solamente llama a la capacidad refresh() del proveedor y espera su resultado.
- La razón es concreta y no es de estilo: el refresh token es de UN SOLO USO y
  rota al canjearse (CONTRATO §3.4). Dos promesas distintas —una proactiva y una
  reactiva— consumirían el mismo refresh token a la vez y la segunda recibiría
  401 invalid_session, cerrando una sesión perfectamente válida.
- El estado de "refresh en vuelo" se limpia en un bloque finally, tanto si la
  renovación termina bien como si falla. Si quedara colgado, ningún refresh
  posterior podría ejecutarse.

PROTECCIÓN DE LA REFERENCIA refreshPromise

Limpiar en finally no basta por sí solo: hay una carrera entre una renovación
que termina tarde y otra que ya empezó.

- Cada ejecución REAL de refresh guarda su promesa en una variable LOCAL y
  además en refreshPromise.
- En el finally, solo puede hacer refreshPromise = null si la referencia actual
  SIGUE SIENDO EXACTAMENTE la promesa que está terminando (comparación por
  identidad con la variable local).
- Un finally tardío NUNCA debe borrar la referencia de una renovación más nueva.
  Si lo hiciera, la renovación nueva dejaría de ser compartida y una llamada
  posterior arrancaría un segundo canje del mismo refresh token.
- clear() invalida la generación actual, pero NO puede fingir que canceló una
  petición que sigue viajando por la red. Lo honesto es descartar su resultado,
  no pretender que no ocurrió.
- Si después de un clear() o de un login nuevo comienza otra renovación, la
  promesa antigua puede terminar igualmente, pero al hacerlo:
    - no escribe estado;
    - no programa temporizadores;
    - no emite eventos atribuidos a la sesión nueva;
    - no borra la referencia de la promesa nueva.

IDENTIDAD ESTRICTA DE LA PROMESA COMPARTIDA

El requisito es observable, no de estilo de escritura:

    session.refresh() === session.refresh()

debe ser true mientras haya una renovación en vuelo.

Ojo con declarar session.refresh() como función async: una función async ADOPTA
el resultado de la promesa que devuelve, pero envuelve todo en una promesa
NUEVA en cada invocación, así que la comparación de identidad fallaría aunque el
POST /api/auth/refresh siguiera siendo uno solo. Si necesitas async por
legibilidad, sepáralo: una función interna async que hace el trabajo, y un
refresh() no-async que devuelve la referencia guardada. No se exige una forma
concreta; se exige la identidad.

RESULTADO DEL REFRESH

provider.refresh() no devuelve un booleano: un booleano pierde la causa del
fallo y obliga a quien llama a inventar un error.

- Si la renovación tiene ÉXITO, la promesa se resuelve DESPUÉS de haber guardado
  completamente el par nuevo. Cuando http.js reintenta, getToken() ya devuelve el
  access token nuevo; no hay ventana en la que el reintento use el token viejo.
- Si FALLA, la promesa RECHAZA con el HttpError original de la llamada a
  /api/auth/refresh, sin envolverlo ni sustituirlo.
- Gracias a eso http.js puede propagar el error REAL del refresh —por ejemplo un
  503 data_unavailable con su propio requestId— en vez de devolver el 401
  original de la petición que lo disparó o fabricar un error nuevo. Quien
  depure el incidente necesita el requestId de la llamada que de verdad falló.

## 2. Llamadas de autenticación

/api/auth/login, /api/auth/refresh y /api/auth/logout deben invocarse con
{auth:false, retryAuth:false}:

- auth:false para no enviar el access token en operaciones que no lo usan (el
  backend recibe los tokens en el CUERPO, ver CONTRATO §3.3-§3.5).
- retryAuth:false para que un 401 en esas llamadas no dispare un refresh, que a
  su vez fallaría y volvería a intentarlo: recursión.

Las solicitudes normales usan por defecto retryAuth:true.

## 3. Ajusta http.js

Agrega la opción retryAuth (por defecto true) a las opciones admitidas, junto a
las que ya existen (query, body, signal, headers, auth).

Ante una respuesta 401 con code invalid_session:

- Si la petición lleva retryAuth:false, NO refresques y NO reintentes: propaga el
  error tal cual.
- Si lleva retryAuth:true, llama a provider.refresh() y espera su resultado.
- http.js NO coordina nada: no mantiene una promesa compartida, ni una cola, ni
  una variable refreshPromise, ni cuenta renovaciones en vuelo. Si diez
  peticiones reciben 401 a la vez, las diez llaman a provider.refresh() y es
  session.js quien garantiza que eso sea UN SOLO POST /api/auth/refresh
  devolviéndoles la misma promesa. Duplicar la coordinación en los dos módulos
  es precisamente lo que provocaría dos canjes del mismo refresh token.
- Si provider.refresh() RESUELVE, reintenta la solicitud original UNA SOLA VEZ,
  con el token nuevo, y con retryAuth:false para que un segundo 401 no vuelva a
  entrar en el ciclo.
- Si provider.refresh() RECHAZA, propaga ESE error, no el 401 original. Un 503
  data_unavailable durante el refresh debe llegar al llamador como 503 con su
  propio requestId; presentarlo como el 401 inicial escondería la causa real.
- No implementes un bucle automático de reintentos. Un intento, y ya.

Ante un 403 de cualquier petición, llama a provider.notify() con el evento
correspondiente (ver "eventos" más abajo) y propaga el error. No refresques y no
cierres sesión: un 403 no significa que la sesión sea inválida (CONTRATO §1.5).
http.js no sabe qué es una sesión; solo informa lo que observó.

Cada intento HTTP —el original y el reintento— sigue registrando su propia
muestra en metrics.js: son dos peticiones reales y ocultar una falsearía la
medición.

## 4. Comportamiento de session.js

API pública mínima: login(), logout(), refresh(), restore(), getToken(), role(),
isAuthenticated(), clear(), subscribe(listener), configureSession() y
resetSessionConfig().

### 4.1 Persistencia y restauración

La sesión se persiste en localStorage, coherente con ADR-F01 y con el contrato
actual (CORS con allowCredentials=false: no hay cookies, el token viaja en el
cliente, CONTRATO §1.1).

- Guarda UN ÚNICO registro JSON, bajo una clave con nombre propio del frontend
  (por ejemplo "taller1.session"). NO uses claves independientes por token: si
  la escritura del access token y la del refresh token pueden intercalarse, una
  interrupción deja un access token nuevo junto a un refresh token viejo, y el
  siguiente refresh falla con 401 sobre una sesión que era válida.
- El registro mínimo contiene:
    accessToken
    refreshToken
    username
    accessTokenExpiresAt
    refreshTokenExpiresAt   (si viene en la respuesta)
    una versión de esquema  (para poder migrar o descartar registros antiguos)
- La escritura del par renovado se hace como UNA SOLA sustitución del registro
  completo, nunca campo a campo.
- NO persistas el rol y no confíes en un rol persistido: role() se calcula
  SIEMPRE desde el access token actual. Un rol guardado quedaría obsoleto en
  cuanto un ADMIN cambie el rol del usuario, y el token nuevo ya trae el vigente.

RESTAURACIÓN EXPLÍCITA: restore()

IMPORTAR session.js NO DEBE TENER EFECTOS. Al importar el módulo no se lee
localStorage, no se crean temporizadores y no se inicia ninguna petición. La
restauración empieza únicamente cuando alguien llama a restore().

La razón es concreta: las pruebas importan el módulo ANTES de poder inyectarle
su almacenamiento con configureSession(). Si el import hidratara por su cuenta,
leería el localStorage real del navegador de quien ejecuta las pruebas y
programaría temporizadores fuera de control antes de que el seam exista. Con
restore() explícito, el orden queda en manos de quien llama: primero
configureSession(), después restore().

restore() es IDEMPOTENTE mientras una restauración esté en curso: las llamadas
concurrentes reciben la misma promesa.

restore() devuelve una promesa. Una promesa RESUELVE o RECHAZA, nunca las dos
cosas, así que la regla es tajante:

- RESUELVE, indicando el estado resultante, únicamente cuando NO hubo un error
  HTTP ni de transporte.
- RECHAZA con el HttpError cuando el refresh que ella misma inició falló. No lo
  envuelve, no lo sustituye y no lo duplica: rechaza con EXACTAMENTE ese objeto.

Ojo con la expresión "permanece sin autenticación" que aparece más abajo:
describe el ESTADO INTERNO en el que queda el módulo después del fallo. NO
significa que la promesa resuelva. El estado y el resultado de la promesa son dos
cosas distintas y aquí se decide cada una por separado.

Comportamiento:

- Lee y valida defensivamente el registro versionado. JSON corrupto, versión de
  esquema desconocida, campos obligatorios ausentes o fechas inválidas provocan
  una LIMPIEZA SEGURA, nunca una excepción. Un registro roto no puede impedir
  que la aplicación cargue.

CASOS QUE RESUELVEN

- Registro ausente o inválido: limpia cualquier residuo y RESUELVE sin
  autenticación.
- Tokens vencidos sin posibilidad de refresh —refreshTokenExpiresAt presente y ya
  vencido—: NO intentes renovar, porque no tiene sentido gastar una petición que
  el backend rechazará con 401 invalid_session. Limpia el registro y RESUELVE sin
  autenticación.
- Access token VIGENTE: restaura el estado, programa la renovación proactiva y
  RESUELVE como autenticada. No llama a /api/auth/refresh.
- Refresh EXITOSO: guarda el par nuevo, programa el temporizador y RESUELVE como
  autenticada.

EL CASO QUE RENUEVA

Si el access token YA VENCIÓ pero el refresh token todavía puede utilizarse:

- restaura solo la información necesaria para renovar;
- getToken() sigue devolviendo null y isAuthenticated() sigue devolviendo false
  MIENTRAS se renueva: no se envía un access token vencido;
- llama a la MISMA función refresh() compartida de la sección 1, no a una copia
  de su lógica.

CASOS QUE RECHAZAN

Si ese refresh falla, restore() RECHAZA con el mismo HttpError. Antes de
rechazar, deja el estado interno así:

- 401 invalid_session: limpia el registro, permanece sin autenticación y emite
  session:expired.
- 503 data_unavailable: conserva la información necesaria para un reintento
  manual, permanece sin autenticación y emite system:degraded.
- Timeout, error de red u otro error: conserva la información necesaria,
  permanece sin autenticación y NO lo presenta como sesión expirada.

En los tres casos la promesa rechaza; quien llamó a restore() decide qué mostrar
—una pantalla de login, un aviso de sistema degradado— con el error en la mano.

- NO llames a /api/auth/validate. Este commit puede restaurar y renovar con la
  información ya persistida; una llamada de más en cada arranque no aporta nada
  que accessTokenExpiresAt no diga ya.

getToken() devuelve null cuando el access token ya expiró.
isAuthenticated() devuelve true solo cuando hay un access token no vencido.

clear() borra memoria, localStorage, el temporizador pendiente y el estado de
refresh en vuelo, de forma segura (sin lanzar si localStorage no está
disponible). Lo que clear() NO puede hacer es cancelar una petición HTTP ya
iniciada, salvo que se implemente explícitamente con AbortController; si decides
implementarlo, documenta el comportamiento, y si no, documenta que una respuesta
tardía puede llegar después de limpiar (ver 4.6, carreras).

### 4.2 Renovación proactiva

Programa la renovación con 60 segundos de margen antes de accessTokenExpiresAt,
usando EXCLUSIVAMENTE el accessTokenExpiresAt de /login o de /refresh. No uses el
expiresAt de /validate: proviene del claim exp del JWT y tiene precisión de
segundos, mientras que el de /login conserva microsegundos (CONTRATO §3.3). Una
sola fuente evita comparar dos valores que no son idénticos para el mismo token.

Si el margen ya pasó —access token TODAVÍA VIGENTE pero con menos de 60 segundos
restantes— renueva de inmediato en vez de programar un temporizador con retardo
negativo. Esto aplica solo a ese caso. Un access token YA VENCIDO no se maneja
aquí: lo maneja restore() como se describe en 4.1.

Al limpiar o reemplazar la sesión, cancela el temporizador pendiente. Un
temporizador huérfano dispararía un refresh después de cerrar sesión.

### 4.3 Resultado del refresh y reacción a cada fallo

refresh() devuelve la promesa compartida descrita en la sección 1: resuelve
después de haber guardado el par nuevo, y rechaza con el HttpError original.

- Falla con 401 invalid_session: limpia el estado y emite session:expired. Es
  también lo que ocurre si la cuenta fue desactivada, porque /refresh consulta
  findByIdAndActiveTrue y responde invalid_session (CONTRATO §3.4). No inventes
  un código propio como user_inactive: el backend no lo entrega.
- Falla con 503 data_unavailable: NO es una sesión expirada. Conserva el estado
  local, emite system:degraded y PROPAGA el mismo error. Convertir una caída del
  tier de datos en un cierre de sesión sería un fallo del frontend, no del
  backend.
- Otros fallos (timeout, error de red, 500): se propagan igualmente, conservando
  el estado local y SIN presentarlos como sesión expirada. Solo el 401
  invalid_session cierra la sesión.

### 4.4 Qué hacer tras un 503: no crear un bucle

Un 503 durante el refresh NO programa inmediatamente otro refresh. Concretamente:

- Se cancela el temporizador proactivo que ya se consumió; no se reemplaza por
  otro.
- Se conserva el par local, para permitir un reintento posterior manual o
  provocado por otra interacción del usuario.
- NO se crea un intervalo, ni un bucle, ni un reintento automático con espera.
  Un cliente que reintenta solo contra un backend caído multiplica la carga
  justo cuando menos puede soportarla.
- La interfaz futura podrá ofrecer reintentos MANUALES, con el máximo de dos
  intentos que fija el plan.
- Un login nuevo, un refresh exitoso o la restauración explícita de una sesión
  pueden volver a programar el temporizador proactivo.

### 4.5 Eventos

API de suscripción independiente del DOM:

- subscribe(listener) registra el listener y DEVUELVE una función unsubscribe().
- Los eventos son objetos planos con esta forma mínima:
      { type, requestId, error }
- Tipos requeridos:
      session:expired     el refresh falló con 401 invalid_session
      session:forbidden   una petición recibió 403
      system:degraded     el refresh falló con 503 data_unavailable
- requestId es null cuando no existe.
- error conserva el modelo normalizado de errors.js cuando está disponible.
- Un listener que LANCE una excepción no debe impedir que los demás reciban el
  evento ni cambiar el resultado de la operación HTTP en curso. Aísla cada
  invocación.
- NO dependas de window, CustomEvent ni document: el mismo módulo debe funcionar
  en el arnés de pruebas, que no tiene DOM.

Quién emite qué:

- session.js emite los eventos que dependen del RESULTADO de un refresh:
  session:expired y system:degraded.
- http.js emite el 403 de CUALQUIER petición —tenga o no que ver con la sesión—
  llamando a provider.notify(). Así el 403 se informa aunque el módulo de sesión
  no esté involucrado, y sin que http.js importe session.js. El requestId del
  403 vacío llega en la cabecera X-Request-Id (CONTRATO §1.5) y debe conservarse
  en el evento.
- La inversión de dependencia se mantiene: http.js nunca importa session.js.

### 4.6 Generaciones de sesión: logout(), login() y carreras

- logout() CAPTURA el refresh token que va a enviar ANTES de limpiar nada.
- La llamada remota usa {auth:false, retryAuth:false}.
- En un bloque finally limpia SIEMPRE la sesión local: para el 200, para el 202
  best-effort (CONTRATO §3.5) y también si la llamada remota falla por completo.
  Dejar tokens locales tras un logout fallido es peor que no haber llamado.
- Si había un refresh EN VUELO cuando se hizo logout, su resultado tardío NO
  debe volver a guardar tokens: resucitaría una sesión que el usuario acaba de
  cerrar.
- Resuélvelo con una generación o identificador de estado: cada login(),
  restore() o clear() incrementa la generación; al terminar un refresh se compara
  la generación capturada al iniciarlo con la actual, y si no coinciden el
  resultado se descarta sin escribir nada.

LOGIN NUEVO DURANTE UN REFRESH EN VUELO

La misma protección aplica —y es más fácil de pasar por alto que el logout,
porque aquí sí queda una sesión válida que se puede corromper:

- login() inicia una NUEVA generación de sesión.
- Si había un refresh anterior en vuelo, su respuesta tardía NO puede
  sobrescribir nada de la sesión nueva: ni los tokens, ni el username, ni la
  expiración, ni el rol derivado, ni el temporizador programado. Un par de tokens
  a medias —el access de un login y el refresh de la operación anterior— dejaría
  la sesión rota en la siguiente renovación.
- Los eventos producidos por esa operación obsoleta tampoco se atribuyen a la
  sesión nueva: un session:expired de la generación anterior no puede cerrar la
  sesión que el usuario acaba de abrir.
- El finally del refresh viejo no puede limpiar la referencia de un refresh
  nuevo (ver "protección de la referencia refreshPromise" en la sección 1).

### 4.7 role()

- Decodifica de forma segura el claim role del access token actual. El claim
  existe y está firmado (CONTRATO §3.2).
- Devuelve únicamente 'ADMIN', 'USER' o null. Token mal formado, claim ausente o
  cualquier otro valor: null.
- Decodificar el payload NO valida la firma y NO concede permisos: sirve solo
  para adaptar la presentación. La autorización real es exclusiva del backend, y
  el frontend maneja el 403 igual. Documenta esto expresamente en el archivo.
- Recalcúlalo después de cada refresh: el backend consulta el usuario activo y
  emite el token nuevo con el rol VIGENTE, así que un cambio de rol se refleja en
  la siguiente renovación (CONTRATO §3.4).

ROLE() Y EXPIRACIÓN

role() decodifica EXACTAMENTE el token que devolvería getToken(), no un token
guardado por otra vía:

- Si no hay un access token vigente, role() devuelve null.
- Un access token VENCIDO nunca puede producir 'ADMIN' ni 'USER' para la
  presentación, aunque su claim role diga ADMIN: getToken() ya devuelve null para
  ese token, y role() debe seguirlo.
- Mientras restore() está renovando un access token vencido, role() devuelve
  null, igual que isAuthenticated() devuelve false.
- Después de un refresh exitoso, el rol se calcula desde el token NUEVO.

Esto no es autorización —eso lo decide el backend— pero mantiene coherente la
interfaz: si isAuthenticated() es false, no pueden aparecer controles propios de
una sesión autenticada. Una UI que muestre botones de ADMIN mientras la sesión no
está autenticada es un defecto de presentación aunque el backend los rechace
después con 403.

### 4.8 Seam de pruebas

Para que las pruebas sobre temporizadores y almacenamiento sean EJECUTABLES y no
afirmaciones indirectas, expón un seam mínimo —configureSession() y
resetSessionConfig(), o una interfaz equivalente— que permita inyectar:

- el reloj actual (por defecto Date.now);
- setTimeout (por defecto globalThis.setTimeout);
- clearTimeout (por defecto globalThis.clearTimeout);
- el almacenamiento (por defecto globalThis.localStorage).

Los valores reales por defecto NO cambian: el seam solo los sustituye cuando una
prueba lo pide, igual que configureHttp() hace con el timeout. No introduzcas
npm ni ninguna dependencia para esto.

## 5. Pruebas

Amplía el arnés que YA existe en frontend/tests/. No introduzcas npm, ni un
framework, ni bundler, ni ninguna toolchain nueva: ADR-F01 lo descarta y el arnés
actual no lo necesita. Sustituye globalThis.fetch de forma controlada, como ya se
hace.

Usa el seam de la sección 4.8 para controlar reloj, temporizadores y
almacenamiento: ninguna prueba debe esperar en tiempo real ni tocar el
localStorage del navegador de quien las ejecuta.

Cubre como mínimo estos 34 casos:

Sesión y rol
 1. Login guarda los dos tokens, la expiración y el rol.
 2. role() devuelve 'ADMIN' y 'USER' correctamente.
 3. Token mal formado, claim ausente o rol desconocido produce null.
 4. Refresh actualiza los dos tokens, la expiración y el rol.
 5. Access token VENCIDO cuyo claim dice role: ADMIN: isAuthenticated() es
    false, getToken() es null y role() es null. El rol de un token muerto no
    puede pintar controles de administrador.

Coordinación del refresh
 6. Dos 401 invalid_session concurrentes provocan un SOLO POST
    /api/auth/refresh.
 7. UN REFRESH PROACTIVO EN VUELO más DOS peticiones que reciben 401 mientras
    aquel no ha terminado comparten un ÚNICO POST /api/auth/refresh. Esta es la
    prueba que demuestra que la promesa tiene un solo propietario: si http.js
    mantuviera su propia cola, habría dos canjes del mismo refresh token.
 8. IDENTIDAD ESTRICTA: mientras hay una renovación en vuelo,
    session.refresh() === session.refresh() es true. No basta con contar las
    peticiones: hay que comprobar que es literalmente la misma promesa.
 9. Cada petición original se reintenta como máximo una vez.
10. El reintento se emite con retryAuth:false.
11. Login, refresh y logout no llevan cabecera Authorization.
12. Un fallo del propio refresh no entra en recursión.
13. Tras un refresh fallido, el estado de "refresh en vuelo" queda limpio y un
    refresh posterior sí se ejecuta.

Propagación de errores
14. Refresh con 401 invalid_session limpia la sesión y emite session:expired.
15. Refresh con 503 NO se presenta como sesión expirada, conserva la sesión y el
    llamador recibe el 503 —con el requestId del refresh—, no el 401 original.
16. Un 503 durante el refresh no programa otro refresh automáticamente: tras
    fallar no queda ningún temporizador pendiente.
17. Un 403 vacío emite session:forbidden, conserva la sesión y conserva el
    requestId de la cabecera.

Persistencia y restauración
18. Importar session.js NO produce efectos: sin lecturas de almacenamiento, sin
    temporizadores y sin peticiones hasta llamar a restore(). La configuración
    de almacenamiento y reloj se instala con configureSession() ANTES de
    restore().
19. restore() con access token VIGENTE: restaura, programa el temporizador y NO
    llama a /api/auth/refresh. La promesa RESUELVE como autenticada.
20. restore() con access token VENCIDO y refresh vigente: llama UNA SOLA VEZ a
    /api/auth/refresh, y antes de que esa llamada termine isAuthenticated() es
    false y getToken() devuelve null.
21. restore() con refreshTokenExpiresAt ya vencido: limpia el registro y RESUELVE
    sin sesión, SIN hacer ninguna llamada HTTP.
22. restore() sin registro, con JSON corrupto, versión desconocida o campos
    ausentes: limpieza segura y RESOLUCIÓN sin sesión, sin lanzar.
23. restore() es idempotente mientras está en curso: dos llamadas concurrentes
    comparten la misma promesa y una sola renovación.
24. restore() cuyo refresh falla con 503: la promesa RECHAZA con EXACTAMENTE el
    mismo HttpError (identidad del objeto, no una copia); conserva el registro
    necesario para un reintento manual; isAuthenticated() sigue siendo false;
    emite system:degraded con el requestId; y NO programa otro refresh
    automático.
25. restore() cuyo refresh falla con 401 invalid_session: la promesa RECHAZA con
    EXACTAMENTE el mismo HttpError; limpia el registro; isAuthenticated() sigue
    siendo false; y emite session:expired.
26. Sustitución ATÓMICA del par: tras un refresh, el almacenamiento contiene un
    registro con los dos tokens nuevos; en ningún momento queda un access token
    nuevo junto a un refresh token viejo.

Eventos
27. subscribe() recibe los eventos; la función unsubscribe() devuelta deja de
    recibirlos.
28. Un listener que lanza no impide que los demás reciban el evento ni cambia el
    resultado de la operación HTTP.

Generaciones, logout y temporizadores
29. Logout limpia el estado local incluso si el backend falla.
30. Un refresh en vuelo que termina DESPUÉS de un logout no vuelve a guardar
    tokens.
31. Refresh en vuelo + login nuevo + resolución tardía del refresh anterior: el
    par entregado por el LOGIN NUEVO permanece completo e intacto, incluidos
    username, expiración, rol derivado y temporizador.
32. Refresh viejo en vuelo, sesión nueva, segundo refresh en vuelo: cuando
    termina el viejo, su finally NO borra la referencia compartida del nuevo, y
    el nuevo sigue siendo compartido.
33. Un fallo tardío del refresh de una generación anterior no emite
    session:expired ni system:degraded sobre la sesión nueva.
34. No quedan temporizadores pendientes al limpiar o reemplazar la sesión,
    comprobado con el clearTimeout inyectado, no por inspección visual.

Ejecuta las pruebas en navegador (sirviendo el repositorio por HTTP) y muestra el
total. Las 23 pruebas del commit 2 deben seguir pasando: el total final es 23 más
todas las pruebas de sesión que realmente implementes (34 como mínimo según la
lista de arriba, más las que hagan falta para cubrir tu diseño).

## 6. Verificaciones finales

Ejecuta y muestra:

    grep -rn --include='*.js' "fetch(" frontend/src/
    grep -n "session" frontend/src/platform/http.js
    grep -rn "import" frontend/src/platform/http.js
    git diff --check
    git status --short

Esperado: fetch( solo en http.js; http.js sin ningún import de session.js (una
mención en comentario sobre el proveedor es aceptable si no crea dependencia);
sin errores de whitespace; solo archivos de frontend/** modificados.

Muestra el diff completo y explica: cómo evitaste el ciclo entre HTTP y sesión;
dónde vive la única promesa de refresh y por qué no puede haber una segunda en
http.js; por qué un 503 durante el refresh no cierra la sesión ni programa otro
refresh; y cómo garantizas que la sustitución del par de tokens sea atómica.

No hagas el commit. Déjalo listo con el mensaje:
feat: sesion con refresh silencioso, cola de refresh y eventos de sesion
```

---

## Commit 4 — ADR-F02 y ADR-F03

**Mensaje:** `docs: registra ADR-F02 (cliente HTTP unico) y ADR-F03 (timeout, presupuesto y degradacion)`

**Estado:** los archivos están escritos pero **todavía sin commit**; el índice está
vacío. Se describe aquí como listo para guardar, no como versionado.

**Objetivo.** Registrar como decisiones de arquitectura dos cosas que ya están
implementadas y verificadas en el código, no proponerlas. ADR-F02 documenta el
cliente HTTP único y la inversión de dependencia con la sesión; ADR-F03 documenta
por qué el timeout y el presupuesto de latencia son valores distintos, cómo se
mide, cómo se clasifica la disponibilidad y qué degradación existe hoy.

**Archivos modificados**

- `docs/DECISIONS-FRONTEND.md` — se añaden ADR-F02 y ADR-F03 después de ADR-F01,
  con su mismo formato (Fecha, Estado, Contexto, Decisión, Alternativas
  descartadas, Razón, Tácticas aplicadas, Costo aceptado).
- `docs/prompts-claude-code-rol3-por-commit.md` — esta entrada y la tabla de
  estado.
- `frontend/config.js` — **corrección exclusivamente documental**: su comentario de
  cabecera explicaba de forma incorrecta la relación entre el timeout y el
  presupuesto de latencia (afirmaba que igualarlos dejaría el contador de
  incumplimientos en cero, cuando el código sí registra una muestra por cada
  timeout). Se reescribió ese párrafo para que no contradiga a ADR-F03. **No
  cambiaron los valores exportados ni el comportamiento**: `requestTimeoutMs: 5000`
  y `latencyBudgetMs: 2000` siguen exactamente igual, y no se modificó ninguna
  línea ejecutable.

Un commit `docs:` puede tocar un comentario dentro de código cuando el cambio no
altera el comportamiento y elimina una contradicción con el ADR que se registra;
dejar la contradicción para otro commit sería publicar un ADR que el propio
código desmiente.

No se toca `backend/**`, `docs/DECISIONS.md`, `frontend/CONTRATO.md`,
`frontend/src/**`, `frontend/tests/**`, `frontend/app.js`, `frontend/index.html`
ni `frontend/styles.css`.

**ADR añadidos**

| ADR | Título | Estado |
|---|---|---|
| ADR-F02 | Cliente HTTP único y sesión por inversión de dependencia | Aceptada |
| ADR-F03 | Timeout distinto del presupuesto de latencia y degradación controlada | Aceptada |

**Verificaciones hechas antes de escribir una sola línea**

Una decisión no se documenta como aceptada si no está implementada, así que las
precondiciones se comprobaron contra el código, no contra el recuerdo:

- Los cinco módulos y el arnés existen y están versionados.
- `http.js` implementa `retryAuth` (`http.js:336`).
- `session.js` usa `configureAuthProvider()` (`session.js:237`).
- `http.js` no importa `session.js`: sus tres imports son `config.js`,
  `metrics.js` y `errors.js` (`http.js:41-43`).
- La única promesa compartida de refresh vive en `session.js` (`session.js:175`);
  en `http.js` la palabra `refreshPromise` solo aparece en un comentario que
  explica que allí NO está.
- Las pruebas se ejecutaron en navegador real, sirviendo el repositorio por HTTP:
  **71 pasaron, 0 fallaron, 71 en total**.

También se comprobó lo que **no** está migrado, para no documentarlo como hecho:
`frontend/app.js` sigue llamando a `fetch()` con una URL absoluta
(`app.js:14-15`) y `frontend/index.html:46` sigue cargándolo. La invariante del
cliente único se enuncia por eso sobre `frontend/src/**`, y el legado queda
declarado como deuda con fecha de vencimiento.

**Mensaje previsto**

```text
docs: registra ADR-F02 (cliente HTTP unico) y ADR-F03 (timeout, presupuesto y degradacion)
```
