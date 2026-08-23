# Calidad e Integración

## 1. Objetivo

Este documento describe la estrategia de calidad e integración implementada para el sistema de autenticación y gestión de usuarios.

El objetivo de esta etapa fue verificar que los componentes desarrollados por el equipo funcionaran correctamente tanto de forma aislada como integrada, y establecer mecanismos automáticos para detectar regresiones.

Los principales aspectos evaluados fueron:

- Pruebas automatizadas.
- Cobertura de código.
- Integración con PostgreSQL.
- Autenticación y autorización.
- Integración entre componentes desplegados.
- Pruebas End-to-End de API.
- Rendimiento inferior a 2 segundos.
- Integración continua mediante GitHub Actions.

---

# 2. Estrategia de pruebas

Se utilizó una estrategia de pruebas por niveles.

```
                    ┌───────────────┐
                    │  API E2E      │
                    │ Sistema real  │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │ Integración   │
                    │ PostgreSQL    │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │ Unitarias /   │
                    │ Componentes   │
                    └───────────────┘
```

Cada nivel tiene una responsabilidad diferente.

### Pruebas unitarias y de componentes

Comprueban de manera rápida y aislada:

- Servicios.
- Reglas de negocio.
- Seguridad.
- Controladores.
- Validaciones.
- Conversión entre entidades y DTO.
- Comportamiento esperado ante diferentes condiciones.

### Pruebas de integración

Comprueban comportamientos que requieren infraestructura real, particularmente PostgreSQL.

Un caso importante es `LastAdminConcurrencyIT`, que valida una regla de negocio bajo concurrencia utilizando las características reales de PostgreSQL.

### Pruebas E2E de API

Comprueban el sistema desplegado atravesando varias capas:


Cliente de pruebas
        ↓
      nginx
        ↓
Spring Boot
        ↓
Spring Security / JWT
        ↓
Servicios
        ↓
Repositorios
        ↓
PostgreSQL


Esto permite verificar que componentes que funcionan correctamente de forma aislada también funcionan cuando se integran.

---

# 3. Baseline de pruebas

Antes de incorporar nuevas herramientas de calidad se estableció una baseline del proyecto.

Se identificaron dos grupos de pruebas.

## 3.1 Suite principal

La suite principal se ejecuta utilizando el ambiente de pruebas configurado por el proyecto.

Resultado inicial:


Tests ejecutados: 124
Failures: 0
Errors: 0
Resultado: PASS


## 3.2 Integración PostgreSQL

La prueba:

```text
LastAdminConcurrencyIT
```

requiere PostgreSQL real.

Se ejecutó utilizando:

- PostgreSQL 16.
- Java 21.
- Maven.
- Docker.

Resultado:

```text
Tests ejecutados: 1
Failures: 0
Errors: 0
Resultado: PASS
```

## 3.3 Resultado consolidado


Suite principal             124/124 PASS
PostgreSQL Integration        1/1 PASS
---------------------------------------
Total                       125/125 PASS

La separación de las suites evita modificar globalmente el datasource de pruebas que no requieren PostgreSQL.

---

# 4. Entorno reproducible

El proyecto requiere Java 21.

Para evitar diferencias entre los ambientes locales de los desarrolladores se utilizaron contenedores Docker con Java 21 para la ejecución y construcción del sistema.

Esto reduce problemas relacionados con:

- Versiones diferentes del JDK.
- Dependencias instaladas localmente.
- Configuraciones particulares de cada equipo.
- Diferencias en versiones de PostgreSQL.

El entorno utilizado para las pruebas incluye:


Java           21
PostgreSQL     16
Maven          Maven Wrapper / Maven 3.9.x
Docker         Contenedores


---

# 5. Cobertura de código con JaCoCo

Se incorporó JaCoCo al ciclo de construcción de Maven para medir automáticamente la cobertura generada por las pruebas.

JaCoCo genera reportes en:


backend/target/site/jacoco/


El reporte HTML principal puede encontrarse en:


backend/target/site/jacoco/index.html

La primera medición permitió identificar componentes con una cobertura significativamente menor al resto del sistema.

Uno de los principales hallazgos fue:


UserController: 8% de cobertura de instrucciones


Mientras otros controladores presentaban una cobertura considerablemente superior.

---

# 6. Mejora dirigida por cobertura

En lugar de crear pruebas únicamente para incrementar un porcentaje global, se utilizó el reporte de JaCoCo para localizar código relevante sin pruebas.

Se identificó `UserController` como un punto prioritario.

Se creó:


UserControllerTest.java


incluyendo pruebas para las operaciones principales del controlador:

- Listar usuarios.
- Consultar usuario.
- Actualizar username.
- Cambiar contraseña.
- Cambiar rol.
- Desactivar usuario.

Después de incorporar las pruebas:


UserController
Antes:   8%
Después: 100%


La cobertura total del paquete de controladores también aumentó considerablemente.

Este proceso siguió el ciclo:


Medir
  ↓
Identificar hueco
  ↓
Agregar prueba relevante
  ↓
Ejecutar nuevamente
  ↓
Verificar mejora


---

# 7. Quality Gate

Además de generar un reporte, JaCoCo se configuró como un mecanismo automático de aceptación.

Los límites definidos son:

| Métrica | Mínimo |
|---|---:|
| Line Coverage | 80% |
| Branch Coverage | 70% |

Estos límites se evalúan durante la fase:


mvn verify


Si el proyecto cae por debajo de alguno de estos valores, Maven produce:


BUILD FAILURE


Si los criterios se cumplen:


All coverage checks have been met
BUILD SUCCESS


Esto evita que cambios posteriores reduzcan significativamente la cobertura sin ser detectados.

---

# 8. Integración del sistema

Para validar el comportamiento del backend desplegado se utilizó la arquitectura Docker del proyecto.

Los servicios levantados fueron:


auth-nginx
auth-postgres
backend-1
backend-2


La topología comprobada fue:


                 ┌─────────────┐
                 │   Cliente   │
                 └──────┬──────┘
                        │
                        ▼
                 ┌─────────────┐
                 │    nginx    │
                 │    :8080    │
                 └──────┬──────┘
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
       ┌─────────────┐     ┌─────────────┐
       │ backend-1   │     │ backend-2   │
       │ Spring Boot │     │ Spring Boot │
       └──────┬──────┘     └──────┬──────┘
              │                   │
              └─────────┬─────────┘
                        ▼
                 ┌─────────────┐
                 │ PostgreSQL  │
                 └─────────────┘


Se verificó mediante Docker que:


auth-postgres    healthy
backend-1        healthy
backend-2        healthy
auth-nginx       up


---

# 9. Health Checks

Se comprobaron los endpoints de disponibilidad del sistema.

Se verificaron:


/actuator/health/liveness
/actuator/health/readiness


Tanto a través de nginx como directamente sobre las instancias del backend.

Resultado:


Liveness backend-1     UP
Liveness backend-2     UP
Liveness nginx         UP
Readiness              UP


Esto permite comprobar tanto que los procesos están ejecutándose como que el sistema se encuentra preparado para recibir tráfico.

---

# 10. Pruebas End-to-End de API

Se implementó el script:


qa/api-e2e.ps1


Su objetivo es comprobar automáticamente el comportamiento del sistema desplegado.

La prueba atraviesa nginx y utiliza las instancias reales del backend y PostgreSQL.

## Escenarios cubiertos

### Registro

Se crea dinámicamente un usuario válido.

Resultado:


PASS: Registro de usuario


### Login

El usuario registrado inicia sesión y obtiene un access token JWT.

Resultado:


PASS: Login genera access token

### Identidad JWT

Se obtiene el identificador del usuario desde el JWT para continuar el flujo de prueba.

Resultado:


PASS: JWT contiene userId


### Acceso al propio recurso

Un usuario autenticado puede consultar su propia información.

Resultado esperado:


HTTP 200


Resultado:


PASS


### Restricción por rol

Un usuario con rol `USER` intenta listar todos los usuarios.

Resultado esperado:


HTTP 403 Forbidden


Resultado:


PASS


### Endpoint sin autenticación

Se intenta acceder a un endpoint protegido sin JWT.

Resultado esperado:


HTTP 401 Unauthorized


Resultado:


PASS


### Actualización

El usuario modifica su username mediante el endpoint correspondiente.

Resultado:


PASS


### Persistencia

Después de actualizar el usuario se realiza una nueva consulta para verificar que el cambio permanece almacenado.

Resultado:


PASS


## Resultado general E2E


PASS: Liveness
PASS: Readiness
PASS: Registro de usuario
PASS: Login genera access token
PASS: JWT contiene userId
PASS: USER accede a su propio recurso
PASS: USER no puede listar todos los usuarios
PASS: Endpoint protegido rechaza petición sin JWT
PASS: Actualización de usuario
PASS: Cambio persistido en base de datos

API E2E: ALL TESTS PASSED


---

# 11. Validación de seguridad

Las pruebas E2E también permitieron comprobar las reglas de autenticación y autorización.

| Escenario | Resultado esperado | Resultado |

| Login válido | Éxito | PASS |
| Usuario consulta su recurso | 200 | PASS |
| Usuario sin JWT consulta recurso protegido | 401 | PASS |
| USER intenta listar usuarios | 403 | PASS |
| USER intenta consultar recurso ajeno | 403 | PASS |
| Actualización de recurso propio | Éxito | PASS |

Esto verifica en ejecución real la integración entre:


JWT
+
Spring Security
+
@PreAuthorize
+
UserSecurity
+
UserController
+
UserService


---

# 12. Pruebas de rendimiento

El requisito establecido para el sistema fue:


Tiempo de respuesta < 2 segundos


Para comprobarlo se utilizó k6.

El script se encuentra en:


qa/performance.js


## Configuración de carga

La prueba utilizó:


Usuarios virtuales: 10
Duración:           30 segundos


Durante la prueba se realizaron solicitudes sobre:

- Readiness.
- Endpoint autenticado de usuario.

El flujo autenticado incluye JWT y atraviesa nginx hacia las instancias del backend.

---

# 13. Quality Gates de rendimiento

Se definieron tres criterios automáticos:


p95 HTTP < 2000 ms
HTTP error rate < 1%
Checks > 99%


El uso de percentil 95 evita depender únicamente del promedio.

El criterio:


p95 < 2000 ms


significa que al menos el 95% de las solicitudes debe responder por debajo del límite arquitectónico de 2 segundos.

---

# 14. Resultados de rendimiento

Resultados obtenidos:

| Métrica | Resultado |

| Virtual Users | 10 |
| Duración | 30 s |
| Requests HTTP | 538 |
| Iteraciones | 268 |
| Checks | 806 |
| Checks exitosos | 100% |
| Error rate | 0.00% |
| Tiempo promedio | 65.79 ms |
| Mediana | 23.31 ms |
| p90 | 83.22 ms |
| **p95** | **177.84 ms** |
| Máximo | 1.38 s |

Resultado del quality gate:


checks
PASS rate > 0.99
Resultado: 100%

http_req_duration
PASS p(95) < 2000
Resultado: 177.84 ms

http_req_failed
PASS rate < 0.01
Resultado: 0.00%
```

Por lo tanto:


REQUISITO DE RENDIMIENTO < 2 s: PASS
```

El p95 obtenido se encuentra ampliamente por debajo del límite de 2000 ms.

Incluso la solicitud HTTP más lenta observada durante esta ejecución, con un máximo de 1.38 s, permaneció por debajo de 2 segundos.

---

# 15. Integración continua

Se incorporó GitHub Actions para ejecutar automáticamente controles de calidad cuando se producen cambios en el repositorio.

El workflow se encuentra en:


.github/workflows/backend-ci.yml


Se configuraron dos jobs independientes.

## 15.1 Tests and Coverage

Este job:

1. Obtiene el repositorio.
2. Configura Java 21.
3. Configura Maven Wrapper.
4. Ejecuta la suite principal.
5. Genera cobertura JaCoCo.
6. Ejecuta los quality gates.
7. Publica el reporte JaCoCo como artifact.

Flujo:


Push / Pull Request
        ↓
     Java 21
        ↓
      Maven
        ↓
      Tests
        ↓
      JaCoCo
        ↓
   Quality Gate
        ↓
    PASS / FAIL


## 15.2 PostgreSQL Integration Test

El segundo job crea un servicio PostgreSQL 16 dentro del runner de GitHub Actions.

Posteriormente ejecuta:


LastAdminConcurrencyIT


Esto permite validar automáticamente la prueba que requiere comportamiento real de PostgreSQL sin depender de una base instalada en el computador del desarrollador.

## Resultado

Ambos jobs fueron ejecutados satisfactoriamente:


Tests and Coverage             PASS
PostgreSQL Integration Test    PASS


Por lo tanto, la validación de calidad ya no depende exclusivamente de ejecución manual.

---

# 16. Matriz de trazabilidad de calidad

| ID | Requisito / Prueba | Criterio | Resultado |

| QA-01 | Suite principal | Sin errores | PASS |
| QA-02 | Concurrencia PostgreSQL | Sin errores | PASS |
| QA-03 | Cobertura de líneas | ≥ 80% | PASS |
| QA-04 | Cobertura de ramas | ≥ 70% | PASS |
| QA-05 | Registro E2E | Operación exitosa | PASS |
| QA-06 | Login / JWT | Token generado | PASS |
| QA-07 | Acceso propio | HTTP 200 | PASS |
| QA-08 | Acceso sin autenticación | HTTP 401 | PASS |
| QA-09 | Acceso sin autorización | HTTP 403 | PASS |
| QA-10 | Actualización CRUD | Operación exitosa | PASS |
| QA-11 | Persistencia | Cambio recuperable | PASS |
| QA-12 | Liveness | UP | PASS |
| QA-13 | Readiness | UP | PASS |
| QA-14 | Rendimiento | p95 < 2000 ms | PASS |
| QA-15 | Errores bajo carga | < 1% | PASS |
| QA-16 | Checks k6 | > 99% | PASS |
| QA-17 | CI tests + cobertura | Build exitoso | PASS |
| QA-18 | CI PostgreSQL | Build exitoso | PASS |

---

# 17. Cómo reproducir las pruebas

## Suite principal y Quality Gate

Desde `backend`:

```bash
./mvnw "-Dtest=!LastAdminConcurrencyIT" verify
```

En Windows también puede utilizarse Maven mediante Docker con Java 21.

## Prueba PostgreSQL

Debe existir una instancia PostgreSQL configurada para el perfil de integración.

La prueba específica es:

```bash
./mvnw -Dtest=LastAdminConcurrencyIT test
```

## Levantar arquitectura Docker

Desde:


backend/


ejecutar:


docker compose up --build


Verificar:


docker compose ps


Los servicios esperados son:


auth-postgres
backend-1
backend-2
auth-nginx


## API E2E

Desde la raíz del proyecto:

```powershell
.\qa\api-e2e.ps1
```

Resultado esperado:

```text
API E2E: ALL TESTS PASSED
```

## Performance

Con la arquitectura levantada:

```powershell
docker run --rm `
  -v "${PWD}\qa:/scripts" `
  grafana/k6 run /scripts/performance.js
```

Los thresholds deben aparecer como aprobados.

---

# 18. Relación con atributos de calidad

La estrategia implementada no se limita a pruebas funcionales. También aporta evidencia sobre diferentes atributos de calidad arquitectónica.

## Rendimiento

Se valida mediante k6 y un quality gate:

```text
p95 < 2000 ms
```

Resultado obtenido:

```text
177.84 ms
```

## Seguridad

Se verifican:

- Autenticación JWT.
- Endpoints protegidos.
- HTTP 401.
- HTTP 403.
- Restricciones por rol.
- Restricciones por identidad.

## Disponibilidad

Se utilizan:

```text
liveness
readiness
```

y dos instancias del backend detrás de nginx.

## Modificabilidad / mantenibilidad

La separación entre pruebas unitarias, integración, E2E y rendimiento permite localizar fallos en diferentes niveles sin depender exclusivamente de pruebas manuales.

## Testabilidad

El proyecto cuenta con:

- Suite automatizada.
- JaCoCo.
- Quality gates.
- E2E reproducible.
- Performance reproducible.
- CI.

## Confiabilidad

Los cambios son sometidos automáticamente a pruebas y quality gates antes de considerarse válidos dentro del flujo de integración continua.

---

# 19. Relación con la arquitectura 4+1

Las pruebas implementadas aportan evidencia sobre diferentes vistas del modelo 4+1.

### Vista lógica

Las pruebas unitarias y de componentes validan las responsabilidades de:

```text
Controllers
Services
Security
Rules
Repositories
DTOs
```

### Vista de desarrollo

La estructura de paquetes, Maven, JaCoCo y GitHub Actions permite validar continuamente la organización e integración del código.

### Vista de procesos

Las pruebas de concurrencia y rendimiento permiten observar el comportamiento del sistema durante ejecución simultánea.

### Vista física

Docker Compose permite validar el despliegue con:

```text
nginx
backend-1
backend-2
PostgreSQL
```

### +1 Escenarios

Las pruebas E2E representan escenarios funcionales reales:

```text
Registro
Login
Autenticación
Autorización
Consulta
Actualización
Persistencia
```

De esta manera, las pruebas sirven también como evidencia de que las distintas vistas arquitectónicas funcionan conjuntamente.

---

# 20. Conclusión

La estrategia implementada permite evaluar el sistema desde diferentes niveles y automatizar criterios de aceptación relacionados con calidad.

El estado final validado es:

```text
Tests                         125/125 PASS
PostgreSQL Integration       PASS
JaCoCo                       PASS
Line Quality Gate >= 80%     PASS
Branch Quality Gate >= 70%   PASS
API E2E                      PASS
JWT / Seguridad              PASS
Persistencia                 PASS
Liveness / Readiness         PASS
Performance p95              177.84 ms
Performance < 2 s            PASS
HTTP Error Rate              0.00%
GitHub Actions               PASS
```

La incorporación de pruebas automatizadas, métricas de cobertura, quality gates, pruebas E2E, pruebas de rendimiento e integración continua permite detectar regresiones tempranamente y proporciona evidencia reproducible del cumplimiento de los requisitos de calidad e integración del sistema.