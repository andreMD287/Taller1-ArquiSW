# ---- Etapa de build ----
# Multietapa: la imagen final no carga JDK, Maven ni el codigo fuente, solo
# el jar. Mismo Dockerfile para todos los entornos (Cap. 5: repeatability).
FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /app

# capa de dependencias separada del codigo: si solo cambia src/, Docker
# reutiliza la cache de este RUN y no vuelve a bajar el mundo de Maven Central.
COPY mvnw .
COPY .mvn .mvn
COPY pom.xml .
RUN chmod +x mvnw && ./mvnw -q dependency:go-offline

COPY src src
RUN ./mvnw -q -DskipTests package

# ---- Etapa de runtime ----
FROM eclipse-temurin:21-jre-jammy
WORKDIR /app

# curl solo para el HEALTHCHECK; no hace falta JDK ni Maven en produccion.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# usuario no root: si alguien compromete el proceso, no hereda privilegios
# del host ni del contenedor.
RUN groupadd -r auth && useradd -r -g auth -d /app auth

COPY --from=build /app/target/auth-0.0.1-SNAPSHOT.jar app.jar
COPY docker-entrypoint.sh docker-entrypoint.sh
RUN chown auth:auth app.jar docker-entrypoint.sh && chmod +x docker-entrypoint.sh
USER auth

EXPOSE 8080

# El HEALTHCHECK apunta a LIVENESS, nunca a readiness: si dependiera del
# tier de datos, Docker (y en Swarm, el orquestador) reiniciaria contenedores
# sanos cuando Postgres cae, exactamente la cascada que DataTierHealthIndicator
# evita a proposito.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/actuator/health/liveness || exit 1

# docker-entrypoint.sh hidrata JWT_SECRET/POSTGRES_PASSWORD desde Docker
# secrets cuando estan montados (Swarm) y cae en las variables de entorno
# planas cuando no (docker-compose de desarrollo).
ENTRYPOINT ["./docker-entrypoint.sh"]
