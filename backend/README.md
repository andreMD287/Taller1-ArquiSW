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
| POST | `/api/auth/login` | `{username, password}` | 200 `{accessToken, refreshToken, username, accessTokenExpiresAt, refreshTokenExpiresAt}` |
| POST | `/api/auth/refresh` | `{refreshToken}` | 200: mismo formato que `/login` (rota el refresh token) |
| POST | `/api/auth/validate` | `{token}` (access token) | 200 `{username, expiresAt}` — verificación en memoria, nunca toca la BD |
| POST | `/api/auth/logout` | `{refreshToken}` | 200 `{revoked:true}` o 202 `{revoked:false, note}` si la BD no responde |
| GET | `/api/diagnostics` | — | 200: estado del circuit breaker, política de bloqueo, feature toggles |
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
| `JWT_SECRET` | — (ver abajo) | Clave HMAC-SHA256 para firmar/verificar el access token. **Obligatoria** en el perfil `docker`: sin ella la app se niega a arrancar. `docker-compose.yml` trae un default de conveniencia solo para que el evaluador no tenga que configurar nada; en cualquier despliegue real, expórtala antes de levantar el stack. Mínimo 32 bytes. |
| `JWT_TTL_SECONDS` | `900` (15 min) | TTL del access token. Corto a propósito: acota la ventana de un token robado, dado que un JWT no se puede revocar antes de expirar. |
| `JWT_REFRESH_TTL_SECONDS` | `604800` (7 días) | TTL del refresh token, que sí es revocable vía `/logout` porque vive en la BD. |

Feature toggles (por configuración, no por variable de entorno directa, pero
sobreescribibles igual que cualquier propiedad Spring):

| Propiedad | Default | Efecto |
|---|---|---|
| `features.new-dashboard` | `false` | Reservado para demostrar activación sin recompilar |

## Sesiones sin estado (JWT)

`validate` ya no consulta Postgres: el access token es un JWT firmado
(HMAC-SHA256) y se verifica enteramente en memoria (firma + expiración). Esto
saca al tier de datos del camino crítico del ~95% de las peticiones (todo lo
que no es `/login` o `/refresh`). El refresh token, en cambio, es opaco, de
vida larga y sí se persiste: es la única pieza revocable, y solo se usa en el
5% del tráfico restante. Con `docker compose stop postgres`, `/api/auth/validate`
con un token vigente sigue respondiendo 200 (ver `StatelessAccessTokenIT`).

**Trade-off aceptado:** un JWT no se puede revocar antes de expirar sin volver
a introducir estado compartido entre réplicas (una lista de revocación en
Redis reintroduce el mismo problema con otro nombre). Se acepta una ventana de
revocación de hasta `JWT_TTL_SECONDS` (15 min por defecto) a cambio de esa
independencia del tier de datos.

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
