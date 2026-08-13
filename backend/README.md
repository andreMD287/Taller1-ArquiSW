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

## Arranque

### Despliegue real: Docker Swarm (`stack.yml`)

```bash
./scripts/deploy.sh
```

Un solo comando, tanto para evaluar en un portátil de un solo nodo como para
la demo de alta disponibilidad en varios: inicializa el swarm si hace falta,
genera los secrets (`jwt_secret`, `postgres_password`,
`postgres_superuser_password`, `repmgr_password`) si no existen, construye
la imagen y despliega `stack.yml`. La API queda expuesta en
`http://localhost:8080`, balanceada por el *routing mesh* de Swarm entre las 3
réplicas del backend — **mismo archivo de despliegue** en 1 nodo o en N (ver
`stack.yml` para el detalle de por qué Swarm y no Kubernetes ni el
docker-compose de desarrollo).

El tier de datos son 3 nodos de Postgres (`postgres-1/2/3`, imagen
`bitnamilegacy/postgresql-repmgr`) con elección de líder y promoción
automática de un standby si el primario cae (Fase 4). El backend se conecta
con una URL JDBC multi-host (`POSTGRES_HOSTS`, `targetServerType=primary`):
el driver prueba los 3 nodos y sigue solo al que sea primario en cada
momento, sin que haga falta reiniciarlo tras un failover.

Para sumar nodos reales a la demo: `docker swarm join-token worker` en el
nodo donde corriste `deploy.sh`, y el comando que imprime en cada nodo nuevo.

### Desarrollo local: `docker-compose.yml`

```bash
docker compose up --build
```

Levanta `postgres`, `backend-1`, `backend-2` (misma imagen, distinto
`NODE_ID`) y `nginx` como balanceador delante de las dos réplicas, en
`http://localhost:8080`. Pensado para iterar en el backend sin depender de
Swarm; **no** es el despliegue que se evalúa (ver arriba).

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
| `NODE_ID` | `$HOSTNAME`, o `local` si tampoco hay hostname | Identifica el nodo/réplica en logs y métricas. En `stack.yml` no se fija a mano: cada tarea de Swarm resuelve su propio hostname templado (`backend-{{.Task.Slot}}`) y eso basta. |
| `POSTGRES_DB` | `authdb` | Nombre de la base |
| `POSTGRES_USER` | `auth` (docker) | Usuario de conexión a Postgres |
| `POSTGRES_PASSWORD` | `auth` (docker-compose) / secret `postgres_password` (Swarm) | Password de conexión a Postgres |
| `POSTGRES_HOSTS` | `postgres:5432` (docker-compose) / `postgres-1:5432,postgres-2:5432,postgres-3:5432` (Swarm) | Uno o varios `host:puerto`; el driver JDBC se conecta al que responda como primario (`targetServerType=primary`) y sigue al cluster tras un failover. |
| `SPRING_PROFILES_ACTIVE` | — | `docker` en compose y en Swarm, `test` para tests/desarrollo local con H2 |
| `JWT_SECRET` | secret `jwt_secret` (Swarm) / default de conveniencia (docker-compose) | Clave HMAC-SHA256 para firmar/verificar el access token. **Obligatoria** en el perfil `docker`: sin ella la app se niega a arrancar. En `stack.yml` viene de un Docker secret generado por `deploy.sh` (nunca de una variable de entorno plana); `docker-compose.yml` trae un default de conveniencia solo para desarrollo local. Mínimo 32 bytes. |
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

## Alta disponibilidad de Postgres (Fase 4, refuerzo)

Con la Fase 1 en pie, Postgres solo está en el camino crítico del 5% del
tráfico (`/login`), así que el objetivo de 99.99% se cumple **con o sin**
esta fase (ver el modelo en `scripts/availability-model.py`). Esto es
refuerzo: lleva el MTTR de Postgres de ~1h (intervención manual, el
escenario del enunciado original) a segundos.

3 nodos (`postgres-1/2/3`, `bitnamilegacy/postgresql-repmgr:16-debian-12`)
con `repmgrd` corriendo en cada uno: eligen un primario al arrancar
(`REPMGR_PRIMARY_HOST`) y promueven automáticamente un standby si el
primario deja de responder. Medido en vivo contra el stack real con
`scripts/chaos-db-failover.sh`: **~29s** desde que el primario cae hasta que
un standby queda aceptando escrituras — el backend sigue al nuevo primario
solo, gracias al `POSTGRES_HOSTS` multi-host, sin reiniciarse.

**Hallazgo real (no un caso hipotético) al construir esto:** revivir al
viejo primario con su volumen intacto **no** lo hace reincorporarse como
standby — Bitnami reusa el `PGDATA` existente tal cual, con su rol de
primario todavía marcado en el WAL, sin comprobar si alguien más fue
promovido mientras estuvo caído. Eso produce **split-brain** (dos nodos
aceptando escrituras a la vez), confirmado en vivo con `psql` directo a cada
nodo. La única manera segura de reincorporarlo es borrar su volumen para
forzar un re-clonado limpio (`pg_basebackup`) desde el primario real; es
justo lo que hace `chaos-db-failover.sh` después de medir el failover, y por
eso `docker kill` no sirve para este experimento (`restart_policy` revive el
mismo contenedor con el mismo disco antes de que `repmgrd` llegue a
promover a nadie — hay que apagarlo con `docker service scale =0`).

**Limitación conocida, documentada a propósito y no resuelta en este MVP:**
los volúmenes de Swarm son locales al nodo. Si el nodo que corría al
primario **muere de verdad** (no solo el contenedor) y no es el manager, ese
slot pierde su disco y hace falta re-aprovisionarlo a mano — ese caso sigue
pareciéndose al escenario original de ~1h, no a los ~30s medidos aquí.
Cubrirlo de verdad pide almacenamiento distribuido (NFS/EBS/CSI), fuera del
alcance de un MVP de taller.

## Scripts (`scripts/`)

Para el stack en Swarm (`stack.yml`):

- `deploy.sh` — despliegue de un comando: swarm init, secrets, build, `stack
  deploy`. Ver "Arranque" arriba.
- `rolling-upgrade.sh` — construye una imagen nueva y hace `docker service
  update` sobre `auth_backend`; Swarm decide el orden (`update_config` en
  `stack.yml`: 1 réplica a la vez, `start-first`, rollback automático si el
  healthcheck de liveness falla). Imprime el cycle time total.
- `rollback.sh` — `docker service rollback auth_backend`: vuelve a la última
  versión estable en un comando, sin reetiquetar imágenes a mano.
- `probe.sh [segundos]` — sonda de disponibilidad a través del routing mesh
  de Swarm (`localhost:8080`). Mezcla realista de tráfico (5% `/login`, 95%
  `/validate`, configurable con `LOGIN_RATIO`); clasifica cada muestra con la
  taxonomía del proyecto (`FaultKind`) — un error `EXPECTED` no cuenta como
  fallo, solo `FAULT`/`FAILURE` y la ausencia total de respuesta. Imprime
  disponibilidad global y por operación, ventanas de caída con su duración,
  MTBF/MTTR observados y percentiles de latencia; deja el CSV crudo en
  `results/probe-<timestamp>.csv`.
- `chaos.sh` — mata una tarea de `auth_backend` (Swarm la reprograma sola,
  sin intervención manual) y luego apaga/revive el tier de datos **completo**
  (los 3 nodos de Postgres a la vez, no solo el primario). Pensado para
  correr en paralelo con `probe.sh`; deja un log con marcas de tiempo en
  `results/chaos-<timestamp>.log` para correlacionar las dos corridas.
- `chaos-db-failover.sh` (Fase 4) — identifica el primario actual del
  cluster repmgr, lo apaga (`docker service scale =0`, no `docker kill`: ver
  la sección de HA de Postgres arriba), cronometra hasta que un standby es
  promovido, y lo reincorpora de forma segura (vaciando su volumen para
  forzar un re-clonado limpio, evitando split-brain). Imprime el MTTR real
  del failover.
- `availability-model.py` — el modelo analítico (bloques serie/paralelo) que
  produce el número que se entrega: 99.99% de disponibilidad son ~52.6
  min/año de caída, algo que no se puede demostrar por observación directa en
  una demo corta. Toma como entrada el MTTR medido (a mano, o directo de un
  CSV de `probe.sh` con `--probe-csv`), lo combina con el número de réplicas
  y la mezcla de tráfico, y proyecta la disponibilidad anual. Cada parámetro
  que no viene medido es una asunción explícita y documentada en el propio
  script (`DEFAULTS_DOC`), nunca un número puesto a ojo. Solo librería
  estándar de Python 3.

Para el `docker-compose.yml` de desarrollo local:

- `chaos-kill.sh` — mata `backend-1`, lo revive, y luego apaga Postgres (vía
  `docker compose`), para correr en paralelo con `probe.sh` apuntando a
  `localhost:8080` igual que en Swarm.

## Distinción de examen: liveness vs. readiness

`liveness` **nunca** consulta la base de datos: si lo hiciera, una caída de
Postgres reiniciaría en cascada nodos del tier de lógica que están
perfectamente sanos. Solo `readiness` mira las dependencias — ver
`DataTierHealthIndicator` y el comentario en `application.yml`
(`management.endpoint.health.group.readiness.include`).
