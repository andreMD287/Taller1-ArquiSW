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

## ADR-009 (ABIERTA) — Alcance de la unicidad de nombre frente al borrado lógico

**Estado:** Pendiente de decisión de Rol 1.

Rol 2 confirmó que pondrá `UNIQUE` sobre `name` en la migración, y su
`existsByName` no filtra por `active`. Ambas cosas son coherentes entre sí, pero
juntas implican una consecuencia que todavía nadie decidió a propósito: **el
nombre de un producto dado de baja queda bloqueado para siempre.** Lo mismo
aplicará a `username` cuando `User` tenga `active`.

| Opción | Implicación en BD (Rol 2) | Implicación en la regla (Rol 1) |
|---|---|---|
| **Nombres quemados** — un nombre usado nunca se libera | `UNIQUE (name)` global, que es lo que Rol 2 ya planeó | La regla usa `existsByName` |
| **Nombre reutilizable** — solo los activos compiten | `CREATE UNIQUE INDEX ... ON products(name) WHERE active` (índice parcial de Postgres) | La regla usa `existsByNameAndActiveTrue` |

**Por qué hay que decidirlo antes de que Rol 2 escriba la migración:** si la regla
del backend y la constraint de la base expresan alcances distintos, la validación
diría que el nombre está libre y el `INSERT` reventaría igual con
`DataIntegrityViolationException`. Las dos capas tienen que decir lo mismo, igual
que con `stock >= 0`.

Separación de responsabilidades: **la semántica es de Rol 1** (qué significa
"único"), **el mecanismo es de Rol 2** (constraint global vs. índice parcial).

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
