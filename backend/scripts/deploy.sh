#!/usr/bin/env bash
# Despliegue de un solo comando, tanto para el evaluador (1 nodo) como para
# la demo de alta disponibilidad (N nodos ya unidos al mismo swarm): el
# MISMO stack.yml, sin pasos manuales adicionales (Cap. 5: repeatability).
set -euo pipefail

cd "$(dirname "$0")/.."

STACK_NAME="${STACK_NAME:-auth}"
SECRETS_DIR="$(mktemp -d)"
trap 'rm -rf "$SECRETS_DIR"' EXIT

echo "[deploy] inicializando Swarm (si este nodo ya es parte de uno, se ignora el error)..."
docker swarm init >/dev/null 2>&1 || echo "[deploy] swarm ya activo en este nodo, sigue."

random_value() {
    # tr -d '\r' es defensivo: en algunos entornos (Git Bash/MSYS en Windows,
    # por ejemplo) la salida de openssl/base64 trae CRLF en vez de LF. Un
    # secret con un \r colado hace que el password que arma el backend NO
    # coincida byte a byte con el que Postgres realmente configuro -mismo
    # contenido de archivo, distinto valor una vez parseado- y la auth falla
    # en un lugar dificil de sospechar. Se normaliza a LF puro antes de que
    # el valor se convierta en secret.
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -d '\r'
    else
        head -c 48 /dev/urandom | base64 | tr -d '\r'
    fi
}

# idempotente: si el secret ya existe (ej. un redeploy) se reutiliza en vez
# de regenerarlo, porque cambiar JWT_SECRET invalidaria todos los access
# tokens vigentes de golpe.
ensure_secret() {
    local name="$1"
    if docker secret inspect "$name" >/dev/null 2>&1; then
        echo "[deploy] secret '$name' ya existe, se reutiliza."
        return
    fi
    random_value > "$SECRETS_DIR/$name"
    docker secret create "$name" "$SECRETS_DIR/$name" >/dev/null
    echo "[deploy] secret '$name' generado."
}

ensure_secret jwt_secret
ensure_secret postgres_password
# Fase 4: superusuario de Postgres y usuario interno de repmgr, para el
# cluster de 3 nodos (postgres-1/2/3) con eleccion de lider automatica.
ensure_secret postgres_superuser_password
ensure_secret repmgr_password

echo "[deploy] construyendo auth-backend:latest..."
docker build -t auth-backend:latest .

echo "[deploy] desplegando el stack '$STACK_NAME'..."
docker stack deploy -c stack.yml "$STACK_NAME"

echo ""
echo "[deploy] listo. La API queda expuesta en http://localhost:8080 (routing mesh de Swarm)."
echo "[deploy] estado del stack: docker stack services $STACK_NAME"
echo "[deploy] para sumar nodos a este swarm: 'docker swarm join-token worker' en este host,"
echo "         y correr el comando resultante en cada nodo nuevo."
