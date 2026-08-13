#!/bin/sh
# Hidrata variables de entorno desde Docker/Swarm secrets si existen como
# archivos montados en /run/secrets/<nombre>. Es lo que permite que el MISMO
# artefacto (misma imagen, mismo Dockerfile) use "docker secret" en Swarm
# o variables de entorno planas en docker-compose para desarrollo, sin que
# el codigo Java sepa cual de los dos esta corriendo (Cap. 5: repeatability).
set -eu

# tr -d '\r': un secret con CRLF colado (ej. generado en Windows/Git Bash)
# haria que el valor que arma este script no coincida byte a byte con el que
# lee otro contenedor del mismo secret, y la auth fallaria de una forma
# dificil de sospechar (el archivo "se ve igual"). Se normaliza a LF puro.
if [ -z "${JWT_SECRET:-}" ] && [ -f /run/secrets/jwt_secret ]; then
    JWT_SECRET="$(tr -d '\r' < /run/secrets/jwt_secret)"
    export JWT_SECRET
fi

if [ -z "${POSTGRES_PASSWORD:-}" ] && [ -f /run/secrets/postgres_password ]; then
    POSTGRES_PASSWORD="$(tr -d '\r' < /run/secrets/postgres_password)"
    export POSTGRES_PASSWORD
fi

exec java -jar app.jar
