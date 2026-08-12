# auth — backend del taller de arquitectura

Sistema de autenticación de usuarios construido como ejercicio del taller de
Arquitectura de Software, sobre *Software Architecture in Practice* (Bass,
Clements & Kazman, 4.ª ed.), capítulos 3 (escenarios), 4 (disponibilidad) y 5
(desplegabilidad). El detalle de decisiones, tácticas y mediciones está en
[`docs/documentacion-arquitectura.md`](docs/documentacion-arquitectura.md).

## Arquitectura en 3 tiers

```
┌───────────────┐   HTTP/JSON    ┌───────────────────────────────┐   JDBC/TCP    ┌──────────────┐
│  Tier 1        │ ┄┄┄┄┄┄┄┄┄┄┄▶ │  Tier 2 — nginx + 2 réplicas   │ ┄┄┄┄┄┄┄┄┄┄┄▶ │  Tier 3       │
│  Presentación  │ ◀┄┄┄┄┄┄┄┄┄┄┄ │  backend-1 / backend-2         │ ◀┄┄┄┄┄┄┄┄┄┄┄ │  PostgreSQL   │
│  (cliente web) │  FRONTERA 1   │  (Spring Boot, este repo)      │  FRONTERA 2   │  + repository │
└───────────────┘   REMOTA      └───────────────────────────────┘   REMOTA      └──────────────┘
```

Las dos líneas punteadas (`┄┄┄`) son las **fronteras remotas**: procesos
independientes que se comunican por red y que, por lo tanto, pueden fallar de
formas que un monolito nunca tiene que enfrentar (timeout, conexión rechazada,
nodo caído). Todo el trabajo de disponibilidad (Cap. 4) existe por esas dos
líneas.

## Arranque en un comando

```bash
docker compose up --build
```

Esto levanta `postgres`, `backend-1`, `backend-2` (misma imagen, distinto
`NODE_ID`) y `nginx` como balanceador delante de las dos réplicas. La API
queda expuesta en:

```
http://localhost:8080
```

Para correr solo el backend en desarrollo, sin Docker, contra H2:

```bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=test
```

## Tests

```bash
./mvnw test
```

Corre en verde sin Docker: usa el perfil `test` (H2 en memoria). Incluye
tests unitarios (`src/test/java/.../unit`) y de integración con contexto de
Spring real (`.../integration`, sufijo `IT`, incluido en `mvnw test` vía la
configuración de Surefire en `pom.xml` — no hace falta `mvnw verify`).

## Endpoints

Todos bajo `/api/auth`, salvo diagnóstico y salud:

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| POST | `/api/auth/register` | `{username, password}` | 201 `{username}` |
| POST | `/api/auth/login` | `{username, password}` | 200 `{token, username, expiresAt}` |
| POST | `/api/auth/validate` | `{token}` | 200 `{username, expiresAt, degraded}` |
| POST | `/api/auth/logout` | `{token}` | 204 |
| GET | `/api/diagnostics` | — | 200: estado del circuit breaker, sesiones en caché, política de bloqueo, feature toggles |
| GET | `/actuator/health/liveness` | — | ¿el proceso sigue vivo? **nunca** consulta Postgres |
| GET | `/actuator/health/readiness` | — | ¿puede recibir tráfico? incluye el estado del tier de datos |
| GET | `/actuator/metrics`, `/actuator/prometheus` | — | métricas (incluye `errors.<kind>`) |

Errores: cuerpo único `{code, kind, message, retryable, requestId, detail}`.
`kind` es uno de `EXPECTED`/`FAULT`/`ERROR`/`FAILURE` — ver sección 7 de la
documentación de arquitectura para la taxonomía completa y el catálogo de
códigos.

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `NODE_ID` | `local` | Identifica el nodo en logs/métricas (relevante con 2+ réplicas) |
| `POSTGRES_DB` | `authdb` | Nombre de la base |
| `POSTGRES_USER` | `auth` (docker) | Usuario de conexión a Postgres |
| `POSTGRES_PASSWORD` | `auth` (docker) | Password de conexión a Postgres |
| `SPRING_PROFILES_ACTIVE` | — | `docker` en compose, `test` para tests/desarrollo local con H2 |

Feature toggles (por configuración, no por variable de entorno directa, pero
sobreescribibles igual que cualquier propiedad Spring):

| Propiedad | Default | Efecto |
|---|---|---|
| `features.session-cache` | `true` | Habilita la caché local de sesiones (Graceful Degradation) |
| `features.new-dashboard` | `false` | Reservado para demostrar activación sin recompilar |

## Scripts (`scripts/`)

- `probe.sh [segundos]` — sonda de disponibilidad a través de nginx; calcula
  disponibilidad observada, MTBF/MTTR y percentiles de latencia, y deja un
  CSV crudo.
- `chaos-kill.sh` — mata `backend-1`, lo revive, y luego apaga Postgres, para
  correr en paralelo con `probe.sh` durante la demo.
- `rolling-upgrade.sh` — actualiza `backend-1`, espera su `readiness`, y solo
  entonces actualiza `backend-2`. Imprime el cycle time total.
- `rollback.sh [tag]` — vuelve a la imagen etiquetada anterior (por defecto
  `previous`, que `rolling-upgrade.sh` deja como respaldo automático).

## Distinción de examen: liveness vs. readiness

`liveness` **nunca** consulta la base de datos: si lo hiciera, una caída de
Postgres reiniciaría en cascada nodos del tier de lógica que están
perfectamente sanos. Solo `readiness` mira las dependencias — ver
`DataTierHealthIndicator` y el comentario en `application.yml`
(`management.endpoint.health.group.readiness.include`).
