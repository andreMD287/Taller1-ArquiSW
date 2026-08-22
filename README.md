# Sistema de autenticación de usuarios y gestión de productos

Trabajo del curso de **Arquitectura de Software**, sobre *Software Architecture in
Practice* (Bass, Clements & Kazman, 4.ª ed.).

| | |
|---|---|
| **Taller 1** | Disponibilidad (Cap. 4) y desplegabilidad (Cap. 5) sobre una arquitectura de 3 tiers |
| **Taller 2** | Extensión a gestión de productos, con modificabilidad (Cap. 8), safety, rendimiento y eficiencia energética |

---

## 📄 Documentación

| Documento | Qué contiene |
|---|---|
| **[Documento de arquitectura](backend/docs/documentacion-arquitectura.md)** | **El entregable principal.** Escenarios de calidad, las cuatro vistas arquitectónicas, 12 ADR, taxonomía de fallas, tácticas de los Cap. 4 y 5, análisis cuantitativo de disponibilidad y plan de experimentos |
| [Decisiones de Taller 2](docs/DECISIONS.md) | ADR de modificabilidad: estructura de módulos, motor de reglas, validaciones, *feature toggles*, DTOs y manejo de excepciones |
| [Ejercicio de modificabilidad](docs/EJERCICIO-MODIFICABILIDAD.md) | Guion reproducible que verifica el escenario ESC-M1 cronometrando el costo real de agregar un atributo y su regla |
| [Guía de uso](backend/GUIA-DE-USO.md) | Cómo levantar el sistema, usar cada endpoint y reproducir los experimentos |
| [Detalle del backend](backend/README.md) | Arranque, endpoints y estructura del tier de lógica |
| [Evidencia cruda](backend/docs/evidencia/) | CSV y logs de las corridas de caos y de las sondas de disponibilidad |

---

## Arquitectura

Tres tiers, cada uno un servicio desplegado y replicado, más la base de datos como
recurso externo:

```
   ┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
   │  TIER 1 — Presentación │  HTTP  │  TIER 2 — Lógica       │        │  TIER 3 — Datos        │
   │  servicio  web  (×2)   │ ┄┄┄┄▶ │  servicio backend (×3) │ ┄┄┄┄▶ │  acceso a datos        │
   │  nginx + app modular   │ ◀┄┄┄┄ │  Spring Boot           │ ◀┄┄┄┄ │  repositorios,         │
   │  (platform/crud/recur.)│        │  servicios y reglas    │        │  entidades, @Transact. │
   └────────────────────────┘ FRONT. └────────────────────────┘        └───────────┬────────────┘
                               REMOTA 1                                            │ JDBC
                                                                       FRONTERA    │ REMOTA 2
                                                                                   ▼
                                                                        ┌────────────────────────┐
                                                                        │  PostgreSQL (×3)       │
                                                                        │  repmgr, failover      │
                                                                        │  automático            │
                                                                        └────────────────────────┘
```

- El **tier de presentación** es un servicio desplegado, no el navegador del usuario:
  sirve la aplicación y hace de proxy inverso de `/api`, de modo que el navegador
  ve un solo origen y no hay CORS. La aplicación separa presentación, coordinación y
  estado igual que un MVC, pero el corte no está en carpetas por rol técnico: está en
  **plataforma** (transporte y sesión), **motor genérico de CRUD** (los componentes de
  vista y su coordinación) y **descriptores declarativos** de cada recurso, con un
  único punto de composición. Ver `docs/DECISIONS-FRONTEND.md` (ADR-F01, ADR-F02).
- El **tier de datos** es el módulo de acceso a datos —repositorios, entidades y
  transacciones—, no el motor de base de datos. PostgreSQL es el recurso externo que
  ese tier encapsula.
- Las **líneas punteadas** son las fronteras remotas: procesos independientes que se
  comunican por red y que pueden fallar de formas que un monolito nunca enfrenta.

**Resultado medido:** 99.999980 % de disponibilidad proyectada, con un MTTR de failover
de base de datos de **29 s** verificado en dos corridas independientes.

---

## Arranque

```bash
cd backend
./scripts/deploy.sh
```

Un solo comando: inicializa el swarm si hace falta, genera los *secrets*, construye las
dos imágenes y despliega el stack. Funciona igual en un portátil de un nodo que en un
cluster de varios.

| | |
|---|---|
| **http://localhost** | La aplicación web — entrada normal para un usuario |
| **http://localhost:8080** | La API directa — para sondas, scripts de caos y `curl` |

Para desarrollo del backend sin Docker, contra una base en memoria:

```bash
cd backend && ./mvnw spring-boot:run -Dspring-boot.run.profiles=test
```

---

## Estructura del repositorio

```
frontend/                 Tier de presentación — módulos ES nativos, sin build
  index.html                shell único (login, sesión, degradación, CRUD)
  config.js                 enlace con el entorno (base de API, timeouts)
  src/app.js                punto ÚNICO de composición
  src/platform/             transporte, sesión, errores y métricas
                              http.js es el único que llama a fetch()
                              session.js es el único dueño del estado de sesión
  src/crud/                 motor genérico y componentes de vista (tabla, formulario, paginador)
  src/resources/            descriptores declarativos por recurso (datos, sin lógica)
  tests/                    suite propia, ejecutada en navegador real
  nginx.conf                servidor web + proxy inverso /api
  Dockerfile

backend/                  Tiers de lógica y de datos — Spring Boot
  src/main/java/com/taller/auth/
    controller/ service/    tier de lógica (autenticación)
    repository/ model/      tier de datos  (autenticación)
    product/                módulo de productos (vertical slice)
    exception/              banda transversal de excepciones
  src/main/resources/db/    migraciones Flyway
  stack.yml                 despliegue real (Docker Swarm)
  scripts/                  deploy, rollback, rolling upgrade, caos, sondas
  docs/                     documento de arquitectura y evidencia

docs/DECISIONS.md         ADR de Taller 2
```

---

## Pruebas

```bash
cd backend && ./mvnw test
```
