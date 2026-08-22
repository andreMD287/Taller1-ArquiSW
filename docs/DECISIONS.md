# Decisiones arquitectónicas — Rol 1 (Usuarios / Backend + Productos)

Taller 2 — Arquitectura de Software. Base teórica: Bass, Clements & Kazman,
*Software Architecture in Practice*, 4a ed., Cap. 8 (Modificabilidad).

Este archivo alimenta la columna **"Rationale and Assumptions"** del cuestionario
de tácticas de la Tabla 8.2. Cada entrada registra: la decisión, las alternativas
descartadas, la razón, y la táctica del Cap. 8 que la respalda.

---

## ADR-001 — Estructura de paquetes: *vertical slice* con capas internas

**Fecha:** 2026-08-18
**Estado:** Aceptada

### Decisión

El código nuevo de Taller 2 vive en un módulo autocontenido por feature, con las
cuatro capas anidadas dentro:

```
com.taller.auth.product.api             ← controllers REST, DTOs
com.taller.auth.product.application     ← servicios, orquestación, motor de reglas
com.taller.auth.product.domain          ← entidad Product, invariantes de negocio
com.taller.auth.product.infrastructure  ← ProductRepository (interfaz Spring Data)
```

El código de Taller 1 (`controller/`, `service/`, `repository/`, `model/`, `dto/`,
`exception/`, `config/`, `security/`) **no se toca ni se renombra**.

### Alternativas descartadas

1. **Seguir la convención actual de Taller 1** — poner `Product` en `model/`,
   `ProductController` en `controller/`, etc. Descartada porque agregar un
   atributo a `Producto` obligaría a tocar archivos dispersos en cinco paquetes
   distintos. La medida de respuesta del escenario de modificabilidad
   (*"se modifican ≤2 módulos"*) sería indefendible: no existirían módulos que
   contar, solo capas transversales.

2. **Renombrar todo el proyecto a `api/application/domain/infrastructure`** —
   descartada por costo de coordinación, no por mérito técnico. Implicaría
   refactorizar ~40 archivos que Rol 4 ya documentó como evidencia de los
   experimentos de disponibilidad de Taller 1, generaría conflictos de merge con
   Rol 2 trabajando en paralelo, y el commit de rename contaminaría la medición
   del ejercicio cronometrado.

### Razón

La estructura por capas técnicas maximiza la cohesión *por tipo de artefacto*
(todos los controllers juntos), pero el cambio que este taller necesita sostener
es *por feature* ("agregar un atributo a Producto"). Cuando el eje de cambio
esperado y el eje de la estructura no coinciden, cada cambio se dispersa. El
*vertical slice* alinea la estructura con el eje de cambio real y hace que el
escenario de modificabilidad sea **medible**, no solo argumentable.

La decisión respeta la restricción de la sección 2 del contexto (arquitectura en
capas `api/application/domain/infrastructure`): las cuatro capas siguen ahí, solo
que anidadas bajo una raíz de feature en vez de en la raíz del proyecto.

### Tácticas del Cap. 8 aplicadas

| Táctica | Cómo se materializa |
|---|---|
| **Increase semantic coherence** | Todo lo que cambia por la misma razón (una regla de negocio de producto) queda en el mismo módulo raíz. |
| **Encapsulate** | La capa `api` es la única superficie pública del módulo; `domain` e `infrastructure` no se exponen fuera de `product`. |
| **Restrict dependencies** | El módulo `product` no depende del módulo de usuarios salvo por la identidad del solicitante, que llega vía el `SecurityContext`, no por una llamada directa. |

### Costo aceptado

Dos convenciones de paquetes conviviendo en el mismo repositorio. Requiere
acuerdo explícito con Rol 2: la `@Entity` `Product` debe crearse en
`com.taller.auth.product.domain`, no en `com.taller.auth.model`.

---

## ADR-002 — El subject del JWT es el ID del usuario, no su username

**Fecha:** 2026-08-18
**Estado:** Aceptada — **implementada**

### Decisión

`TokenService.buildAccessToken()` emite el access token con
`subject = String.valueOf(userId)` y agrega el username como claim informativo
aparte:

```java
.subject(String.valueOf(userId))
.claim("username", username)
```

`AccessClaims` pasa de `(String username, Instant expiresAt)` a
`(Long userId, String username, Instant expiresAt)`. **Toda decisión de
autorización debe apoyarse en `userId`; `username` es solo para mostrar.**

### Contexto: un supuesto del enunciado que resultó falso

La sección 5 del contexto de trabajo afirmaba que *"el JWT usa el ID como
subject, no el username"* y pedía verificarlo antes de asumirlo. **La
verificación mostró lo contrario**: `TokenService.java:194` emitía
`.subject(username)`, y la tabla `refresh_tokens` (`V2__jwt.sql:11`) persiste una
columna `username`.

### Alternativas descartadas

1. **Agregar un claim `uid` y dejar `sub` como estaba** — aditivo y sin riesgo
   para los tests existentes, pero deja dos fuentes de identidad en el mismo
   token y `sub` seguiría quedando obsoleto tras un cambio de username. Deuda
   conceptual sin beneficio real una vez comprobado que el cambio limpio no
   rompía nada.

2. **No tocar nada y aceptar la ventana de inconsistencia** — al cambiar su
   username, el usuario quedaría deslogueado de facto hasta el siguiente refresh
   (hasta 900 s, el `access-ttl-seconds` configurado), y Rol 3 tendría que
   manejar ese caso en el frontend. Se traslada un problema del backend al
   frontend.

3. **Prohibir el cambio de username** — revierte una regla de negocio ya cerrada.

### Razón

El username es un atributo **mutable** del perfil; el ID es **inmutable**. Usar
un valor mutable como identificador de sesión acopla la vigencia del token a un
dato que el propio usuario puede cambiar. Con el ID como subject, "cambiar de
username" deja de ser un evento que invalida sesiones y pasa a ser un `UPDATE`
corriente.

### Táctica del Cap. 8 aplicada

**Defer binding / restrict dependencies:** el token deja de depender de un dato
mutable del perfil. El módulo de usuarios puede cambiar el username sin
coordinarse con el subsistema de sesiones — se eliminó una dependencia entre dos
módulos que antes cambiaban juntos.

### Costo real medido

Menor de lo estimado. Se modificaron **2 archivos**:

- `backend/src/main/java/com/taller/auth/service/TokenService.java` (producción)
- `backend/src/test/java/com/taller/auth/unit/AuthServiceTest.java:143`
  (una línea: el constructor de `AccessClaims` ganó un parámetro)

`StatelessAccessTokenIT` y el resto de `TokenServiceTest` **no requirieron
cambios**, porque el accesor `username()` se conservó. No hubo que renegociar
nada con Rol 4: la evidencia de disponibilidad de Taller 1 sigue intacta.

**Verificación:** `./mvnw test` → 48 tests, 0 fallos, `BUILD SUCCESS`.

### Compatibilidad hacia atrás

Un token emitido con el formato anterior (subject = username) produce
`NumberFormatException` al parsearse. Como esa excepción hereda de
`IllegalArgumentException`, ya la captura el bloque existente de
`validateAccessToken` y se traduce a `InvalidSessionException` (401), no a un 500.
Cubierto por el test
`unTokenDelFormatoAnteriorConUsernameEnElSubjectSeRechazaComoSesionInvalida`.

---

## ADR-003 — Motor de reglas por descubrimiento automático de beans

**Fecha:** 2026-08-18
**Estado:** Aceptada — **implementada**

### Decisión

Las reglas de negocio de producto se modelan como una interfaz y un conjunto
abierto de implementaciones que Spring descubre solo:

```java
public interface ProductRule {
    Optional<RuleViolation> check(Product product);
}
```

`ProductRuleEngine` recibe `List<ProductRule>` por inyección de constructor. El
contenedor de DI inyecta **todos** los beans que implementen la interfaz.
Agregar una regla = crear una clase `@Component` que la implemente. **No se
edita ningún archivo existente.**

Ubicación: `com.taller.auth.product.application.rules`. Las reglas viven en
`application` y no en `domain` porque algunas necesitarán consultar el
repositorio (unicidad de nombre) y `domain` no debe depender de
`infrastructure`.

### Alternativas descartadas

1. **Chain of Responsibility explícita** — cada regla referencia a la siguiente
   y la cadena se arma en una `@Configuration`. Descartada porque agregar una
   regla obliga a modificar el archivo que construye la cadena: rompe
   open/closed justo en el punto que el escenario de modificabilidad mide. Su
   ventaja real (cortocircuitar la cadena) es contraproducente aquí, porque
   ADR-004 decidió acumular todas las violaciones, no detenerse en la primera.

2. **Strategy con registro explícito** (`Map<RuleId, ProductRule>` o enum) —
   descartada por la misma razón: el registro central es un archivo de
   modificación obligada y un punto de conflicto de merge. Su ventaja (catálogo
   auditable de reglas en un solo sitio) se recuperó por otra vía, sin el costo:
   ver `ProductRuleEngine.activeRuleNames()`.

### Razón

Es la única de las tres alternativas en la que agregar una regla cuesta
**1 archivo nuevo y 0 archivos modificados**. Eso es lo que permite que el
ejercicio cronometrado quede dentro de la medida de respuesta de ≤2 módulos: el
atributo nuevo en la entidad es un módulo, la regla nueva es el otro, y no hay
un tercer archivo de registro que tocar.

### Tácticas del Cap. 8 aplicadas

| Táctica | Cómo se materializa |
|---|---|
| **Defer binding** | El binding entre el motor y sus reglas se resuelve al arrancar el contenedor de DI, no al compilar. `ProductRuleEngine` no nombra a ninguna regla concreta. |
| **Increase semantic coherence** | Una regla = una clase. Cada regla cambia por una sola razón. |
| **Encapsulate** | `ProductRuleEngine` es la única superficie que el servicio consume; las reglas concretas no se referencian desde fuera del paquete. |

### Costo aceptado y su mitigación

El conjunto de reglas activas no está escrito en ningún archivo — hay que
recorrer el classpath para saber qué reglas existen. Se mitiga con
`ProductRuleEngine.activeRuleNames()`, que permite preguntárselo al sistema en
ejecución, siguiendo el precedente de `DiagnosticsController`, que ya expone los
feature toggles del mismo modo.

### Evidencia

- `ProductRuleDiscoveryTest.springDescubreLasReglasSinRegistroExplicitoDeNadie`
- `ProductRuleDiscoveryTest.unaReglaNuevaEnElClasspathQuedaActivaSinTocarNingunArchivoExistente`
  — el ejercicio cronometrado en miniatura, ejecutado como test.
- `ProductRuleEngineTest.unaReglaNuevaSeAplicaSinModificarElMotor`

**Verificación:** `./mvnw test` → 62 tests, 0 fallos, `BUILD SUCCESS`.

---

## ADR-004 (parcial) — El motor acumula violaciones, no falla al primer error

**Fecha:** 2026-08-18
**Estado:** Aceptada — **implementada**

### Decisión

`ProductRule.check()` **no lanza excepciones**: devuelve
`Optional<RuleViolation>`. `ProductRuleEngine.validate()` evalúa todas las
reglas y devuelve `List<RuleViolation>`, vacía si el producto es válido.

### Alternativa descartada

**Fail-fast** (`void validate(Product)` que lanza en la primera violación). Más
simple de escribir, pero el frontend recibiría un error a la vez y el usuario
tendría que corregir el formulario de a un campo por envío.

### Razón

Dos motivos concretos, no estéticos:

1. **Consistencia con lo que el sistema ya hace.**
   `GlobalExceptionHandler.java:39-42` ya concatena todos los errores de Bean
   Validation en un solo mensaje. Un motor fail-fast se comportaría distinto que
   la validación estructural que corre justo antes, para el mismo formulario.
2. **Desacopla el motor del manejo de excepciones.** Al devolver una lista en
   vez de lanzar, el motor no queda atado a una estrategia de excepciones que
   todavía está abierta (ADR-007). El servicio que llama decide qué hacer.

### Táctica del Cap. 8 aplicada

**Restrict dependencies:** `RuleViolation` no conoce HTTP — no lleva status code
ni nada de la capa web. El motor de reglas puede reusarse desde un endpoint,
un job por lotes o un test sin arrastrar la capa de presentación.

### Evidencia

`ProductRuleEngineTest.acumulaTodasLasViolacionesEnVezDeDetenerseEnLaPrimera`

---

## ADR-004 (resto) — Cada validación vive en la capa que le corresponde por naturaleza

**Fecha:** 2026-08-18
**Estado:** Aceptada

### Decisión

El criterio para decidir dónde va una validación es **la naturaleza del dato**,
no la conveniencia de implementación:

| Tipo de validación | Dónde vive | Ejemplos |
|---|---|---|
| **Estructural** — el dato está o no está, y tiene o no la forma correcta | Bean Validation en el DTO de entrada (capa `api`) | `@NotNull`, `@NotBlank`, `@Size`, formato |
| **Semántica de negocio** — el dato existe y está bien formado, pero la regla del negocio lo rechaza | Motor de reglas (`product.application.rules`) | `precio > 0`, `stock ≥ 0`, unicidad de nombre |
| **Invariante inviolable** — no debe poder existir en la base, venga por donde venga | Constraint de BD (Rol 2) | `UNIQUE(name)`, `CHECK (stock >= 0)` |

Consecuencia concreta: **`precio > 0` NO lleva `@Positive` en el DTO**. Vive solo
en `PriceMustBePositiveRule`. `precio == null` sí es Bean Validation, y la regla
lo ignora explícitamente (ver `PriceMustBePositiveRule.check()`).

### Alternativas descartadas

1. **Defensa en profundidad: `@Positive` en el DTO *y* regla en el motor.**
   Rechazo más temprano y barato, pero crea dos fuentes de verdad para la misma
   regla. Cambiar "el precio debe ser > 0" a "el precio debe ser ≥ 0"
   obligaría a tocar dos módulos — exactamente lo que la medida de respuesta del
   escenario de modificabilidad penaliza. El beneficio de rendimiento es
   despreciable frente a ese costo.

2. **Todo en Bean Validation con validadores custom.** Un solo mecanismo, pero
   las reglas que necesitan consultar el repositorio (unicidad de nombre)
   quedarían forzadas dentro de anotaciones: incómodas de testear, difíciles de
   combinar con feature toggles, y arrastran el contexto de persistencia a la
   capa de presentación.

### Razón

La distinción no es estética, es sobre **qué cambia junto**. Una regla de negocio
cambia cuando cambia el negocio; una validación estructural cambia cuando cambia
el contrato de la API. Son ejes de cambio distintos y por lo tanto deben vivir en
módulos distintos. Que `precio > 0` sea hoy expresable con `@Positive` es una
coincidencia sintáctica: mañana el negocio podría permitir productos gratuitos en
promoción, y eso es un cambio de regla, no de contrato.

La duplicación con la BD es el único caso donde sí se repite a propósito, y la
razón es distinta: el backend produce el **mensaje** útil para el usuario, la
constraint garantiza el **invariante** aunque una ruta de código futura se salte
el motor. Es la diferencia entre "validar" y "no poder violar".

### Táctica del Cap. 8 aplicada

**Increase semantic coherence:** cada módulo agrupa validaciones que cambian por
la misma razón. **Restrict dependencies:** la capa `api` no necesita conocer
ninguna regla de negocio para hacer su trabajo.

---

## ADR-005 — Feature toggles por `@ConditionalOnProperty`

**Fecha:** 2026-08-18
**Estado:** Aceptada — **implementada**

### Decisión

Una regla en despliegue progresivo se anota con:

```java
@Component
@ConditionalOnProperty(name = "features.rules.<nombre>", havingValue = "true")
public class MiReglaNueva implements ProductRule { ... }
```

y se declara bajo el bloque `features.rules` de `application.yml`, que extiende
la convención `features:` **ya existente** en el proyecto (`features.new-dashboard`,
leído en `DiagnosticsController.java:30`).

**Las reglas centrales no son toggleables.** `precio > 0` y `stock ≥ 0` son
invariantes del negocio, no funcionalidad en despliegue progresivo. Un toggle que
permita apagar "el stock no puede ser negativo" es un agujero de safety
disfrazado de flexibilidad.

### Alternativas descartadas

1. **Librería de toggles (Togglz / FF4J)** — permite cambiar toggles en caliente
   y trae consola de administración. Descartada por desproporción: dependencia
   nueva, tabla nueva (trabajo adicional para Rol 2) y una consola que habría que
   asegurar, todo para un alcance donde reiniciar el servicio es aceptable.

2. **`if (toggleEnabled)` dentro del cuerpo de la regla** — trivial de escribir,
   pero la regla se instancia y se evalúa aunque esté apagada, y mezcla la
   decisión de despliegue con la lógica de negocio en la misma clase.

### Razón

Con `@ConditionalOnProperty`, una regla apagada **no llega a ser un bean**: no
aparece en la lista que Spring inyecta, no se evalúa, y su coste en ejecución es
literalmente cero. Eso también aporta al atributo de **eficiencia energética**
que trabaja Rol 4: código deshabilitado que no se ejecuta no consume ciclos.

El toggle se resuelve al arrancar, leyendo configuración. El mismo artefacto
compilado se comporta distinto según el entorno, sin recompilar ni redesplegar
imagen — que es la definición de *deferred binding* a tiempo de configuración.

### Táctica del Cap. 8 aplicada

**Defer binding (configuration-time):** la decisión de qué reglas están activas
se traslada del tiempo de compilación al tiempo de arranque.

### Evidencia

- `ProductRuleDiscoveryTest.unaReglaConToggleApagadoNiSiquieraLlegaASerBean`
- `ProductRuleDiscoveryTest.laMismaReglaSeActivaSoloCambiandoUnaPropiedadSinRecompilar`

**Verificación:** `./mvnw test` → 64 tests, 0 fallos, `BUILD SUCCESS`.

---

## ADR-006 — DTOs como records con mapeo manual explícito

**Fecha:** 2026-08-18
**Estado:** Aceptada — **implementada**

### Decisión

`ProductRequest` y `ProductResponse` son records en `product.api`, y
`ProductMapper` es una clase de utilidad sin estado con métodos estáticos. La
entidad `Product` **nunca** se expone por HTTP.

### Alternativas descartadas

1. **MapStruct** — genera los mappers en compilación y, si los nombres
   coinciden, agregar un campo se mapea solo: un archivo menos que tocar en el
   ejercicio cronometrado. Descartada por dos costos que superan ese ahorro:
   introduce un annotation processor en el build, que es territorio de Rol 4, y
   convierte el mapeo en código generado que no aparece en el repositorio —
   justo lo que hay que poder mostrar al sustentar.

2. **Exponer la entidad directamente** — acoplaría el contrato público de la API
   al esquema físico de base de datos que gobierna Rol 2. Cualquier cambio suyo
   de columnas se propagaría al frontend de Rol 3.

### Razón

El desacople DTO/entidad es lo que permite que Rol 2 cambie el mapeo físico,
agregue columnas de auditoría o cambie la estrategia de soft-delete sin que Rol 3
se entere. El mapeo manual cuesta unas pocas líneas por entidad y las mantiene
visibles y depurables.

### Táctica del Cap. 8 aplicada

**Encapsulate** + **use an intermediary:** el mapper es el intermediario que
absorbe los cambios de forma entre el dominio y el contrato público, de modo que
un cambio en un lado no se propaga automáticamente al otro.

### Costo aceptado

Agregar un atributo a `Product` obliga a tocar también `ProductMapper` y los dos
records. Está contado explícitamente en el guion del ejercicio cronometrado y
anotado como comentario en la cabecera de `ProductMapper`.

### Evidencia

`ProductMapperTest`, incluido `applyToNoTocaCreatedAtNiActive`, que verifica que
una actualización no pueda reescribir la fecha de creación ni resucitar un
producto dado de baja.

---

## ADR-007 — Excepción de negocio que hereda de `AppException`, con violaciones estructuradas y 422

**Fecha:** 2026-08-18
**Estado:** Aceptada — **implementada**

### Decisión

- `BusinessRuleViolationException extends AppException`, código
  `business_rule_violation`, `FaultKind.EXPECTED`, **HTTP 422**, no reintentable.
- Transporta `List<FieldViolation>`, un record compartido en `com.taller.auth.dto`
  con `(rule, field, message)`.
- `ErrorResponse` gana un campo `violations` con
  `@JsonInclude(JsonInclude.Include.NON_NULL)` y conserva su constructor de 6
  argumentos.
- `GlobalExceptionHandler` gana un `@ExceptionHandler` más específico que el de
  `AppException`. Sigue siendo el único lugar donde una excepción se convierte en
  respuesta HTTP, como declara su propio comentario de cabecera.

### El motivo que descarta la alternativa "obvia"

`application.yml` lista `com.taller.auth.exception.AppException` en
`ignore-exceptions` **tanto del circuit breaker como del retry** de Resilience4j.
Una excepción de negocio que heredara directamente de `RuntimeException` sería
contada por Resilience4j como falla del tier de datos: **un usuario tecleando
precios inválidos podría llegar a abrir el circuit breaker y degradar el servicio
para todos los demás.** Heredar de `AppException` es lo que la clasifica como
EXPECTED (Cap. 4) y la mantiene fuera del cálculo de disponibilidad de Rol 4.

Está protegido por el test
`ErrorContractTest.laExcepcionDeNegocioHeredaDeAppExceptionParaQuedarFueraDelCircuitBreaker`.

### Alternativas descartadas

1. **Concatenar las violaciones en el campo `detail` que ya existe** — cero
   cambios a `ErrorResponse` e idéntico a como `GlobalExceptionHandler:39-42`
   reporta hoy los errores de Bean Validation. Descartada porque Rol 3 recibiría
   un string y perdería el `field` de cada violación: no podría resaltar los
   inputs del formulario sin parsear texto.

2. **Formato de error separado solo para validación** — dos formatos de error en
   la misma API obligan a Rol 3 a implementar dos rutas de manejo.

### Por qué 422 y no 400

La petición está bien formada y es sintácticamente válida — de eso ya se encargó
Bean Validation, que responde 400. Lo que falla es su semántica de negocio. Los
dos códigos separan las dos clases de validación de ADR-004, y esa separación es
visible desde el cliente.

### Por qué `FieldViolation` vive en `com.taller.auth.dto` y no en el módulo de productos

`ErrorResponse` lo referencia. Si viviera en `product/`, la capa compartida
dependería del módulo de productos y se invertiría la dirección de las
dependencias que fija ADR-001. El módulo de productos traduce sus `RuleViolation`
a `FieldViolation` al lanzar la excepción; la duplicación de forma es el precio
de que el contrato público no quede atado a un tipo interno.

### Táctica del Cap. 8 aplicada

**Restrict dependencies** (la dirección de las dependencias se mantiene hacia lo
compartido, nunca hacia el módulo de features) + **use an intermediary** (el
manejador global es el único punto de traducción excepción → HTTP).

### Compatibilidad

El cambio a `ErrorResponse` es aditivo y verificado como tal:
`ErrorContractTest.unErrorSinViolacionesNoSerializaLaClaveViolations` falla si
alguna respuesta de error de Taller 1 cambiara de forma.

**Verificación:** `./mvnw test` → 71 tests, 0 fallos, `BUILD SUCCESS`.

---

## Nota abierta — granularidad de "módulo" en el escenario de modificabilidad

El ejercicio "agregar un atributo + una regla a `Producto`" toca, como mínimo,
tres paquetes: `product/domain` (el atributo), `product/api` (los dos records y
el mapper) y `product/application/rules` (la regla). Si "módulo" significa
*paquete de capa*, la medida de respuesta de ≤2 módulos **no se cumple**, y no
hay diseño razonable que la cumpla: un atributo que no aparece en la API no le
sirve a nadie.

La salida no es cambiar el diseño sino **fijar la granularidad de "módulo"** al
redactar el escenario de 6 partes. El propio enunciado ya la insinúa cuando dice
*"no requiere tocar el frontend ni el módulo de usuarios"*: ahí "módulo" es del
tamaño de **frontend / usuarios / productos**, no de un paquete de capa. Con esa
lectura el ejercicio toca **1 módulo** y la afirmación interesante —que no se
toca ni el módulo de usuarios ni el frontend— queda demostrada.

**Pendiente de cerrar** al redactar el entregable 3.

---

## Decisiones pendientes

| # | Tema | Estado |
|---|---|---|
| ADR-008 | Unicidad de producto por nombre — **revisable**: si más adelante se agrega un SKU/código propio, la unicidad debería moverse a ese campo | Registrada, revisable |
| ADR-009 | **Alcance** de la unicidad de nombre: ¿se libera el nombre de un producto eliminado? | **Abierta — decisión de Rol 1** |
| — | `ProductService` y controllers REST de Producto | **Bloqueado**: requiere `ProductRepository` de Rol 2 |
| — | CRUD de Usuario (roles, soft delete, último ADMIN) | **Bloqueado**: requiere `role`/`active` en `User` y la taxonomía de roles de Rol 2 |

---

## ADR-009 — El nombre de un producto eliminado NO se reutiliza

**Fecha:** 2026-08-18
**Estado:** Aceptada

### Decisión

La unicidad de `name` es **global**, no restringida a los productos activos. Un
nombre usado queda ocupado para siempre, aunque el producto se dé de baja.

- Base de datos: `CONSTRAINT uq_products_name UNIQUE (name)`, tal como ya quedó
  en `V3__users_roles_products.sql`.
- Regla de negocio: usa `existsByName` / `existsByNameAndIdNot`, las firmas que
  Rol 2 ya entregó.

### Alternativa descartada

**Liberar el nombre al eliminar** — habría requerido un índice único parcial de
Postgres (`CREATE UNIQUE INDEX ... ON products(name) WHERE active`) en una
migración V4, más cambiar las firmas del repositorio a
`existsByNameAndActiveTrue`. Es más natural para el usuario final, pero cuesta
una migración adicional y una ronda más de coordinación, y el beneficio es
marginal en el alcance del taller.

### Razón

Además del costo, mantener la unicidad global evita que dos productos distintos
compartan el mismo nombre en momentos distintos del historial, lo que haría
ambiguos los reportes y las referencias históricas — que es precisamente lo que
el borrado lógico existe para preservar.

### Consecuencia registrada

Es una decisión **reversible y barata**: si más adelante resulta molesto, se
resuelve con una V4 y un cambio de firma. Y si se implementa el SKU de ADR-008,
la unicidad se movería a ese campo y el problema desaparece.

### Coordinación

**No se requiere V4.** El esquema publicado en V3 ya expresa esta decisión.

---

## ADR-010 — El primer ADMIN se crea por seed en migración Flyway

**Fecha:** 2026-08-18
**Estado:** Aceptada — **pendiente de implementación por Rol 2**

### El problema que resuelve

`V3` agrega `role VARCHAR(20) NOT NULL DEFAULT 'USER'` y el constructor de `User`
asigna `Role.USER`. No existe ningún seed de administrador. Como la regla ya
cerrada dice que **solo un `ADMIN` puede cambiar roles**, el sistema arrancaba
con cero admins y **sin ninguna forma de salir de ese estado**. De paso, el
interlock del último ADMIN estaba protegiendo un conjunto vacío:
`countByRoleAndActiveTrue(ADMIN)` devolvía 0 siempre.

Es un problema de arranque que no aparecía en ninguno de los dos checklists.

### Decisión

Una migración Flyway inserta el administrador inicial, con hash BCrypt fijo y
contraseña que debe cambiarse en el primer uso.

### Alternativas descartadas

1. **Promover por SQL manual** (`UPDATE users SET role='ADMIN'` tras el primer
   registro) — cero código, pero no es reproducible ni queda en el repositorio:
   Rol 4 tendría que documentarlo como paso manual de despliegue, y un despliegue
   limpio en Swarm quedaría sin administrador hasta que alguien se acordara.

2. **Bootstrap por configuración al arrancar** — una propiedad
   `app.bootstrap.admin-username` que promueva al usuario si no hay ningún ADMIN.
   Descartada porque agrega lógica de arranque con estado y un camino de
   escalada de privilegios gobernado por una variable de entorno.

### Razón

El seed en migración es determinista, versionado y reproducible: viaja con el
código, se aplica igual en cualquier entorno y queda auditable en el historial de
Flyway. Es la misma razón por la que el esquema entero es migración y no un paso
manual (Cap. 5, *repeatability*).

### Coordinación

🔗 **Rol 2** implementa el seed en la próxima migración. Debe usar un hash BCrypt
generado, nunca una contraseña en claro, y la credencial inicial debe
documentarse para Rol 4 como paso obligatorio de puesta en marcha.

---

## ADR-011 — Autorización de productos: leer autenticado, escribir ADMIN

**Fecha:** 2026-08-18
**Estado:** Aceptada — **implementada (inerte hasta que Rol 2 entregue)**

### Decisión

`GET /api/products` y `GET /api/products/{id}` requieren estar autenticado.
`POST`, `PUT` y `DELETE` llevan `@PreAuthorize("hasRole('ADMIN')")`.

El enunciado no especificaba nada sobre autorización de productos — solo decía
que un `ADMIN` puede cambiar roles de otros usuarios.

### Alternativas descartadas

1. **Todo requiere ADMIN** — más restrictivo, pero un `USER` normal no podría ni
   ver el catálogo, lo que deja a Rol 3 sin pantalla para usuarios no
   administradores.
2. **Lectura pública sin autenticación** — cómoda para demos y para el harness de
   carga de Rol 4, pero expone el catálogo completo sin credenciales.

### ⚠️ Riesgo abierto: las anotaciones están inertes

Los `@PreAuthorize` **no se están aplicando todavía**. Faltan dos piezas de Rol 2:

1. **`@EnableMethodSecurity` en `SecurityConfig`.** Sin ella, Spring **ignora las
   anotaciones en silencio** — no fallan, simplemente no se aplican.
2. **Un filtro que traduzca el JWT a un `Authentication` con authorities.** Sin
   él, `.anyRequest().authenticated()` hace que los endpoints respondan 403 a
   todos.

**El orden importa y es peligroso:** hoy los endpoints están cerrados por
completo. Si llega solo la pieza 2 sin la 1, quedarían **abiertos a cualquier
usuario autenticado**, incluidos `POST`, `PUT` y `DELETE`. Las dos tienen que
llegar juntas. Está advertido en la cabecera de `ProductController`.

---

## ADR-012 — `ProductService` detrás del circuit breaker `dataTier`

**Fecha:** 2026-08-18
**Estado:** Aceptada — **implementada**

### Decisión

Las cinco operaciones de `ProductService` llevan
`@CircuitBreaker(name = "dataTier", fallbackMethod = ...)`, con el mismo patrón
de fallback que `AuthService` y `TokenService`: si la causa es un `AppException`
se relanza tal cual, y cualquier otra cosa se convierte en
`DataUnavailableException`.

### Alternativas descartadas

1. **No ponerlo** — menos código, pero ante una caída de Postgres los endpoints
   de producto darían 500 mientras el resto del sistema degrada a 503. Las
   métricas por `FaultKind` que Rol 4 usa para calcular disponibilidad contarían
   los dos casos de forma distinta sin ninguna razón de fondo.
2. **Solo en las lecturas** — coherente con la nota de `application.yml` de que un
   INSERT no idempotente no debe vivir detrás del *retry*, pero esa nota aplica a
   `@Retry`, no a `@CircuitBreaker`. Abrir el circuito ante un tier de datos caído
   es igual de correcto para escrituras.

### Razón

La uniformidad es el punto: el modelo de disponibilidad de Rol 4 asume que todo
acceso al tier de datos pasa por el mismo circuit breaker. Un módulo que se salte
esa convención no rompe nada visible en desarrollo, pero introduce un agujero en
las mediciones.

`ignore-exceptions: AppException` en `application.yml` es lo que impide que una
violación de regla de negocio cuente como falla del tier de datos — misma
mecánica que sostiene ADR-007.

### Nota pendiente

No se agregó `@Retry(name = "dataTier")` a las lecturas idempotentes
(`search`, `findActiveById`), aunque la configuración existe y estaría
justificada. Queda como mejora disponible si Rol 4 la considera necesaria para
sus mediciones.

---

## Nota — tope de tamaño de página

Se agregó a `application.yml`:

```yaml
spring.data.web.pageable.default-page-size: 20
spring.data.web.pageable.max-page-size: 100
```

Sin ese tope, un cliente puede pedir `?size=100000` y hacer que **una sola
petición incumpla el objetivo de rendimiento de <2s**. El valor por defecto de
Spring (2000) es demasiado alto para las consultas de listado de este sistema.

⚠️ Comunicado a Rol 4 por ser cambio en configuración compartida.

---

## Nota sobre ADR-004 — costo asumido del `CHECK (price > 0)`

Rol 2 confirmó que reforzará también `price > 0` como constraint en la migración,
además de `stock >= 0` y la unicidad de nombre.

Es defensa en profundidad y no se revierte, pero se registra el costo: la
justificación de ADR-004 para ubicar `precio > 0` en el motor de reglas y no en
Bean Validation fue precisamente que **es una regla de negocio que podría
cambiar** (productos gratuitos en promoción). Con un `CHECK` en base de datos,
ese cambio futuro pasa a requerir además una migración de Flyway.

Con `stock >= 0` no hay tensión alguna: ese sí es un invariante permanente, y
duplicarlo en la base es puro beneficio.

---

## Pendientes con Rol 2 al momento de la pausa

Confirmado por Rol 2:

- Trabaja sobre `product/domain/Product.java`, sin crear otra entidad.
- `ProductRepository` es su primera entrega, para desbloquear `ProductService`.
- Refuerza en Postgres: `CHECK (stock >= 0)`, `CHECK (price > 0)`, `UNIQUE(name)`.
- Filtrado de soft-delete por **métodos explícitos**, no `@Where` (cierra el
  punto 3 del checklist **solo para `Product`**).

Sin respuesta todavía:

1. **Soft-delete en `User`** — el punto 3 se respondió solo para `Product`. Hoy
   `AuthService.login()` usa `findByUsername()`, que no filtra: cuando `User`
   tenga `active`, **un usuario eliminado podrá seguir iniciando sesión**. Falta
   decidir entre `findByUsernameAndActiveTrue` o el chequeo en el service.
2. **Firma explícita de la búsqueda paginada**, que también debe filtrar activos:
   `Page<Product> findByNameContainingIgnoreCaseAndActiveTrue(String, Pageable)`.
3. **Punto 7 del checklist** — mecanismo anti-condición-de-carrera del último
   ADMIN. "Validación transaccional" con `READ_COMMITTED` no impide que dos
   admins eliminándose a la vez dejen el sistema en 0.
4. **`role` y `active` en `User`**, taxonomía de roles, filtro JWT y
   `@EnableMethodSecurity`. Sin los dos últimos, los `@PreAuthorize` que se
   escriban **se ignoran en silencio**.

Riesgo asumido por la elección de métodos explícitos: `ProductRepository` hereda
de `JpaRepository` los métodos `findAll()`, `findById()` y `findAll(Pageable)`,
que **no filtran por `active`**. El filtro no es estructural — depende de la
disciplina de quien llama. Se cubrirá con un test cuando exista el repositorio.

## ADR-011 — Autenticación JWT y autorización basada en roles

**Estado:** Aceptada

### Contexto

El sistema ya manejaba access tokens JWT para autenticación y refresh tokens persistidos para renovación y revocación. Para el Taller 2 se requiere además controlar el acceso a operaciones del CRUD según el rol del usuario.

Los roles definidos son:

- `USER`
- `ADMIN`

Los endpoints de lectura de productos requieren que el usuario esté autenticado, mientras que las operaciones de creación, modificación y eliminación requieren rol `ADMIN`.

También se mantiene como restricción arquitectónica que la validación frecuente del access token no vuelva a introducir PostgreSQL en el camino crítico.

### Decisión

El access token JWT incluye los siguientes claims:

- `sub`: ID inmutable del usuario.
- `username`: nombre actual del usuario.
- `role`: `USER` o `ADMIN`.

`TokenService.validateAccessToken()` valida la firma, expiración y claims completamente en memoria.

Se incorporó `JwtAuthenticationFilter`, que:

1. lee el encabezado `Authorization: Bearer <token>`;
2. valida el JWT mediante `TokenService`;
3. obtiene el rol firmado en el token;
4. lo transforma en una authority de Spring Security:
   - `USER` → `ROLE_USER`
   - `ADMIN` → `ROLE_ADMIN`;
5. registra el `Authentication` en el `SecurityContext`.

Se habilitó `@EnableMethodSecurity` en la misma entrega que el filtro JWT, evitando un estado intermedio donde los `@PreAuthorize` pudieran ser ignorados.

Las operaciones sensibles del módulo de productos utilizan:

```java
@PreAuthorize("hasRole('ADMIN')")
---

## ADR-014 — Autorización de usuarios: endpoints separados por privilegio

**Fecha:** 2026-08-22
**Estado:** Aceptada — **implementada**

### Decisión

| Operación | Quién puede |
|---|---|
| `GET /api/users` | Solo ADMIN |
| `GET /api/users/{id}` | El propio usuario o ADMIN |
| `PUT /api/users/{id}` (username) | El propio usuario o ADMIN |
| `PATCH /api/users/{id}/password` | **Solo el propio usuario** |
| `PATCH /api/users/{id}/role` | Solo ADMIN |
| `DELETE /api/users/{id}` | El propio usuario o ADMIN |

El rol y la contraseña viajan en **endpoints propios**, no como campos del `PUT`.

### Razón de los endpoints separados

Si `role` y `password` fueran campos del mismo cuerpo que `username`, la
autorización del `PUT` tendría que depender de **qué campos trae la petición**:
*"puedes editarte a ti mismo, salvo estos dos"*. Ese condicional es exactamente
donde se cuelan las escaladas de privilegio — basta olvidar una rama, o que
alguien agregue un campo nuevo sin revisar la condición, para que un usuario se
promueva a ADMIN. Separados, cada endpoint tiene **una regla sin ramas**.

### Por qué un ADMIN no puede cambiar la contraseña de otro

Se descartó el *reset administrativo*. Un ADMIN que puede fijar la clave de
cualquiera puede suplantar a cualquiera, y eso destruye el no repudio de todo el
sistema: ninguna acción registrada sería atribuible con certeza a su dueño. El
costo aceptado es que no hay recuperación de contraseña olvidada; eso exige un
flujo aparte (correo, token de un solo uso) que queda fuera de alcance.

Se exige la contraseña vigente **aunque el usuario ya esté autenticado**, y no es
redundante: acota el daño de un token robado. Con la sesión secuestrada un
atacante puede leer y editar el perfil, pero no puede quedarse con la cuenta.

### Por qué el listado es solo ADMIN

El directorio completo de cuentas es material de partida para ataques dirigidos.
Un USER normal consulta su propio perfil por `GET /users/{id}`.

### Mecanismo del "self"

`@PreAuthorize("@userSecurity.isSelf(#id) or hasRole('ADMIN')")`, con
`UserSecurity` como bean en vez de comparar dentro del SpEL
(`authentication.principal == #id`). Dos razones: el principal lo pone
`JwtAuthenticationFilter` y es un `Long`, así que un cambio de tipo haría que la
comparación en SpEL diera `false` **en silencio**; y como bean la regla se puede
probar. Falla cerrado ante cualquier duda.

**Evidencia:** `UserSecurityTest`, incluido
`unPrincipalDeOtroTipoNoSeInterpretaComoCoincidencia`.

### Táctica del Cap. 8 aplicada

**Restrict dependencies** + **increase semantic coherence**: cada endpoint
concentra una única regla de autorización, y cambiar la política de un privilegio
no obliga a releer las demás.

---

## ADR-015 — Interlock del último ADMIN con bloqueo pesimista

**Fecha:** 2026-08-22
**Estado:** Aceptada — **implementada**

### Decisión

Las dos operaciones que pueden reducir el número de administradores —dar de baja
a un ADMIN y degradarlo a USER— ejecutan, **dentro de una sola `@Transactional`**:

1. `userRepository.findActiveByRoleForUpdate(Role.ADMIN)` — `SELECT ... FOR UPDATE`
2. verificar que quede al menos otro ADMIN activo distinto del que sale
3. mutar y guardar

Las operaciones que **no** pueden reducir admins (dar de baja a un USER, promover
USER→ADMIN) no toman el bloqueo: serializa operaciones y no hay invariante que
proteger.

### Por qué un `count` no basta

Con el aislamiento por defecto (`READ_COMMITTED`), dos transacciones que dan de
baja a dos administradores distintos leerían ambas *"hay 2 admins"*, ambas
concluirían que pueden proceder, y el sistema terminaría en **0**. Es la condición
de carrera del Cap. 9: dos decisiones correctas por separado, incorrectas juntas.

El `SELECT ... FOR UPDATE` bloquea las filas de todos los admins activos. La
segunda transacción espera; cuando la primera confirma, la segunda relee y ya ve
un solo admin, así que se rechaza.

### Por qué bloquear filas es suficiente

Un `SELECT FOR UPDATE` no impide inserciones fantasma. Aquí no hace falta: un
`INSERT` solo puede **agregar** administradores, nunca reducirlos a cero. El único
caso peligroso es la modificación concurrente de filas existentes, y eso sí lo
cubre el bloqueo. No se necesita `SERIALIZABLE`.

### Por qué el invariante importa

Si se violara, **no habría salida por la interfaz**: solo un ADMIN puede asignar
el rol ADMIN, así que recuperarlo exigiría editar la base de datos a mano. Es la
definición de un *interlock* del Cap. 10 — un estado al que el sistema no debe
poder llegar por ninguna secuencia de operaciones legítimas.

### Código HTTP

**409 Conflict**, no 422. La petición es válida y el estado del recurso es
correcto; lo que impide la operación es el estado **global** del sistema en ese
momento. La misma petición será válida en cuanto exista otro ADMIN activo.

### Evidencia

- `UserServiceTest.darDeBajaAlUltimoAdminActivoEsRechazado`
- `UserServiceTest.degradarAlUltimoAdminAUserEsRechazado`
- `UserServiceTest.elInterlockUsaElBloqueoPesimistaYNoUnConteo` — falla si alguien
  sustituye el bloqueo por `countByRoleAndActiveTrue`
- `UserServiceTest.darDeBajaAUnUserNoTomaElBloqueo` y
  `promoverUnUserAAdminNoTomaElBloqueo` — el bloqueo se toma solo cuando hace falta

**Verificación:** `./mvnw test` → 121 tests, 0 fallos, `BUILD SUCCESS`.

### Pendiente de Rol 2

El test de **concurrencia real** (dos transacciones simultáneas contra Postgres)
lo monta Rol 2. Los tests de arriba verifican la lógica y el uso del mecanismo,
no el comportamiento del motor bajo contención.
