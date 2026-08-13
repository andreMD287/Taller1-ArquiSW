#!/usr/bin/env bash
# Rolling upgrade declarativo: se construye una imagen nueva y se le pide a
# Swarm que actualice el servicio. update_config en stack.yml (parallelism=1,
# order=start-first, failure_action=rollback) es quien orquesta que nunca
# quede el servicio con cero replicas sanas -antes esto lo hacia este script
# a mano, nodo por nodo (Removal from Service + Redundant Spare, Cap. 4).
set -euo pipefail

cd "$(dirname "$0")/.."

STACK_NAME="${STACK_NAME:-auth}"
SERVICE="${STACK_NAME}_backend"
TAG="build-$(date +%s)"
IMAGE="auth-backend:${TAG}"

echo "[rolling-upgrade] construyendo ${IMAGE}..."
docker build -t "$IMAGE" -t auth-backend:latest .

start=$(date +%s)

echo "[rolling-upgrade] actualizando el servicio ${SERVICE}..."
# --detach=false bloquea hasta que Swarm confirme la convergencia (o el
# rollback automatico si el healthcheck de liveness falla durante el update).
set +e
docker service update --image "$IMAGE" --detach=false "$SERVICE"
status=$?
set -e

end=$(date +%s)
echo "[rolling-upgrade] cycle time total: $((end - start))s"

if [ "$status" -ne 0 ]; then
    echo "[rolling-upgrade] ADVERTENCIA: la actualizacion no convergio limpiamente" >&2
    echo "[rolling-upgrade] (probable rollback automatico por failure_action=rollback)." >&2
    echo "[rolling-upgrade] revisa: docker service ps $SERVICE" >&2
    exit 1
fi

echo "[rolling-upgrade] convergencia confirmada. Revisa: docker service ps $SERVICE"
