# Guía de uso

Este documento es la guía práctica: qué hace la aplicación, cómo levantarla, cómo usar
cada endpoint, y cómo reproducir los experimentos de disponibilidad. Para el *por qué* de
cada decisión —tácticas, ADRs, el modelo de disponibilidad— ver
[`docs/documentacion-arquitectura.md`](docs/documentacion-arquitectura.md).

## Qué hace la aplicación

Un backend de autenticación de usuarios: registro, login, validación de sesión, renovación
de sesión y logout, construido como ejercicio del taller para demostrar **99.99% de
disponibilidad** con una arquitectura de 3 tiers. Nada más — no hay recuperación de
contraseña, segundo factor, ni roles. El sistema es deliberadamente pobre en funciones y
rico en propiedades de disponibilidad y desplegabilidad, que es lo que se está evaluando.

La sesión se maneja con un **par de tokens**: un token de acceso (JWT, vida corta, se
verifica en memoria sin tocar la base de datos) y un refresh token (opaco, vida larga, sí
persistido y revocable). El detalle de por qué está en la sección "Sesiones sin estado
(JWT)" del `README.md` y en el ADR-08 del documento de arquitectura.

## Cómo se levanta — dos comandos

Requiere Docker Desktop (o Docker Engine + `docker compose`) corriendo, con soporte de
Swarm (viene incluido en cualquier instalación estándar de Docker, no hay que instalar
nada aparte).

```bash
git clone <este-repositorio>   # o descomprime el .zip entregado
cd Taller1-ArquiSW/backend
./scripts/deploy.sh
```

Eso es todo. `deploy.sh`:

1. Inicializa un Swarm de un solo nodo en tu máquina (`docker swarm init`; si ya eres
   parte de uno, lo ignora y sigue).
2. Genera 4 secrets aleatorios (`jwt_secret`, `postgres_password`,
   `postgres_superuser_password`, `repmgr_password`) — no hay que configurar nada a mano,
   ni pegar una clave en ningún archivo.
3. Construye la imagen del backend.
4. Despliega `stack.yml`: 3 réplicas del backend detrás del *routing mesh* de Swarm, y un
   cluster de 3 nodos de PostgreSQL con failover automático (`repmgr`).

Al terminar, la API queda expuesta en `http://localhost:8080`. Verifica que todo esté
arriba con:

```bash
docker stack services auth
```

Deberías ver `auth_backend` en `3/3` y `auth_postgres-1/2/3` en `1/1` cada uno. La primera
vez puede tardar un poco más (~1-2 min) porque Postgres tiene que clonar los dos nodos
standby desde el primario.

**El mismo `stack.yml` funciona igual con 1 nodo o con varios.** Para sumar más nodos a la
demo de alta disponibilidad:

```bash
docker swarm join-token worker   # corre esto en la máquina donde hiciste deploy.sh
# y pega el comando que imprime en cada nodo nuevo
```

### Alternativa para desarrollo local (sin Swarm)

Si solo quieres iterar en el backend sin el cluster de Postgres:

```bash
docker compose up --build
```

Levanta una versión más simple (2 réplicas de backend, un nginx que balancea entre ellas,
un solo Postgres). **No** incluye el tier de presentación y **no** es el despliegue que
demuestra la disponibilidad de la sección 11 del documento de arquitectura — para eso usa
`deploy.sh`, que además publica la aplicación web en `http://localhost`.

Para correr solo el backend, sin Docker en absoluto, contra una base en memoria:

```bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=test
```

### Apagar todo

```bash
docker stack rm auth
```

## Endpoints — con `curl`

Todos los ejemplos asumen la API en `http://localhost:8080`.

### Registrar un usuario

```bash
curl -s -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"maria123","password":"unaClaveSegura1"}'
```

```json
{"username":"maria123"}
```

### Iniciar sesión

```bash
curl -s -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"maria123","password":"unaClaveSegura1"}'
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
  "refreshToken": "a1b2c3...",
  "username": "maria123",
  "accessTokenExpiresAt": "2026-08-12T21:15:00Z",
  "refreshTokenExpiresAt": "2026-08-19T21:00:00Z"
}
```

Guarda `accessToken` (para validar/usar la sesión) y `refreshToken` (para renovarla). El
`accessToken` expira en 15 minutos por defecto — es corto a propósito, ver ADR-08.

### Validar una sesión

```bash
TOKEN="pega-aqui-el-accessToken"
curl -s -X POST http://localhost:8080/api/auth/validate \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\"}"
```

```json
{"username":"maria123","expiresAt":"2026-08-12T21:15:00Z"}
```

Esta llamada **nunca toca la base de datos** — se verifica la firma del JWT en memoria.
Puedes comprobarlo apagando Postgres (`docker service scale auth_postgres-1=0
auth_postgres-2=0 auth_postgres-3=0`) y repitiendo esta misma llamada: sigue respondiendo
`200`.

### Renovar la sesión (sin volver a pedir usuario/contraseña)

```bash
REFRESH="pega-aqui-el-refreshToken"
curl -s -X POST http://localhost:8080/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}"
```

Responde con un par de tokens **nuevo** (el `refreshToken` usado queda invalidado: es
rotación de un solo uso, ver ADR-08). Guarda el par nuevo.

### Cerrar sesión

```bash
curl -s -X POST http://localhost:8080/api/auth/logout \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}"
```

Responde `200 {"revoked":true}` si pudo revocar el refresh token, o `202
{"revoked":false,"note":"..."}` si el tier de datos no respondía en ese momento — el
`accessToken` ya emitido sigue siendo válido hasta que expira por su cuenta (máximo 15
min), incluso si el logout quedó en `revoked:false`.

### Diagnóstico y salud

```bash
curl -s http://localhost:8080/api/diagnostics                       # circuit breaker, política de bloqueo, feature toggles
curl -s http://localhost:8080/actuator/health/liveness               # ¿el proceso sigue vivo? nunca consulta Postgres
curl -s http://localhost:8080/actuator/health/readiness              # ¿puede recibir tráfico? sí consulta Postgres
curl -s http://localhost:8080/actuator/prometheus                    # métricas, incluye errors.<kind>
```

## Cómo se reproducen los experimentos

Todos los scripts viven en `scripts/` y se corren desde `backend/`, con el stack ya
desplegado (`./scripts/deploy.sh`).

### Sonda de disponibilidad

```bash
./scripts/probe.sh 120          # mide durante 120 segundos
```

Envía tráfico con una mezcla realista (5% `/login`, 95% `/validate`, configurable con
`LOGIN_RATIO=10 ./scripts/probe.sh 120`), clasifica cada respuesta según la taxonomía
`FaultKind` (una contraseña mala no cuenta como fallo), e imprime disponibilidad
observada, ventanas de caída, MTBF/MTTR y percentiles de latencia. Deja un CSV crudo en
`results/probe-<timestamp>.csv`.

### Matar una réplica y ver la recuperación

En una terminal:

```bash
./scripts/probe.sh 60
```

En otra, en paralelo:

```bash
./scripts/chaos.sh
```

`chaos.sh` mata una tarea del backend (Swarm la reprograma sola) y después apaga y revive
los 3 nodos de Postgres a la vez. Compara el CSV de `probe.sh` contra el log en
`results/chaos-<timestamp>.log` (mismo reloj — timestamps en epoch) para ver exactamente
qué pasaba en el sistema en cada momento de la sonda.

### Failover del primario de Postgres (Fase 4)

```bash
./scripts/chaos-db-failover.sh
```

Identifica el primario actual del cluster `repmgr`, lo apaga de forma sostenida, y
cronometra hasta que un standby es promovido. Imprime el MTTR real y lo deja en el log.
Al final reincorpora al viejo primario de forma segura (vaciando su volumen para evitar
split-brain — ver ADR-11 del documento de arquitectura). Puedes correr `probe.sh` en
paralelo para ver el efecto sobre `/login` durante el failover (`/validate` no debería
verse afectado en absoluto).

### Rolling upgrade sin downtime

```bash
./scripts/probe.sh 120 &        # sonda de fondo
./scripts/rolling-upgrade.sh    # reconstruye la imagen y actualiza el servicio
```

Actualiza las 3 réplicas una a la vez (`start-first`, con rollback automático si el
healthcheck falla) e imprime el *cycle time* total. La sonda de fondo debería terminar con
0 muestras fallidas.

### Rollback

```bash
./scripts/rollback.sh
```

Vuelve el servicio `backend` a su versión anterior en un comando.

### El modelo de disponibilidad

```bash
python3 scripts/availability-model.py
```

Corre con valores por defecto documentados (no requiere Docker ni una corrida previa).
Para alimentarlo con los MTTR que acabas de medir:

```bash
python3 scripts/availability-model.py --replica-mttr-seconds 28 --db-mttr-seconds 29
```

O directamente desde el CSV de una sonda:

```bash
python3 scripts/availability-model.py --probe-csv results/probe-<timestamp>.csv
```

Imprime la disponibilidad proyectada a un año y compara contra el objetivo de 99.99%, con
la fuente de cada parámetro (medido o asumido, nunca puesto a ojo) explícita en la salida.

## Tests automatizados

```bash
./mvnw test
```

Corre en verde sin Docker (perfil `test`, base en memoria H2), en segundos. Incluye la
prueba de que `/api/auth/validate` sigue respondiendo `200` con el `DataSource` cerrado a
mitad del test (`StatelessAccessTokenIT`) — el criterio de terminado de la Fase 1.

## Variables de entorno relevantes

Ver la tabla completa en `README.md`. Las que más importan para operar el sistema:

| Variable | Qué hace |
|---|---|
| `JWT_TTL_SECONDS` | Vida del token de acceso (default 900 = 15 min) |
| `JWT_REFRESH_TTL_SECONDS` | Vida del refresh token (default 604800 = 7 días) |
| `STACK_NAME` | Nombre del stack de Swarm, si no quieres usar `auth` (afecta a todos los scripts) |

Ninguna variable de secretos (`JWT_SECRET`, contraseñas de Postgres) se configura a mano
en un despliegue con `deploy.sh`: se generan automáticamente como Docker secrets.
