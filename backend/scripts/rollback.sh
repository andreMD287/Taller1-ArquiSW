#!/usr/bin/env bash
# Vuelve a una imagen anterior por tag, un nodo a la vez (mismo criterio de
# seguridad que rolling-upgrade.sh: nunca sin al menos un nodo sano).
# Uso: ./rollback.sh [tag]   (por defecto usa el tag "previous" que deja
# rolling-upgrade.sh como respaldo antes de cada actualizacion).
set -euo pipefail

TAG="${1:-previous}"
IMAGE="auth-backend:$TAG"

echo "[rollback] verificando que $IMAGE exista..."
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "[rollback] ERROR: no existe la imagen $IMAGE. No hay a que volver." >&2
    exit 1
fi

echo "[rollback] retagueando $IMAGE -> auth-backend:latest..."
docker tag "$IMAGE" auth-backend:latest

echo "[rollback] recreando backend-1 con la imagen restaurada..."
docker compose up -d --no-deps --no-build backend-1
sleep 5

echo "[rollback] recreando backend-2 con la imagen restaurada..."
docker compose up -d --no-deps --no-build backend-2

echo "[rollback] completado. Verifica con: curl http://localhost:8080/actuator/health/readiness"
