#!/usr/bin/env bash
# Rollback declarativo: Swarm ya guarda la especificacion del despliegue
# anterior del servicio, asi que no hace falta reetiquetar imagenes a mano
# como en la version de docker-compose. "docker service rollback" vuelve a
# la ultima version estable en un solo comando.
set -euo pipefail

STACK_NAME="${STACK_NAME:-auth}"
SERVICE="${STACK_NAME}_backend"

echo "[rollback] revirtiendo $SERVICE a su version anterior..."
docker service rollback --detach=false "$SERVICE"

echo "[rollback] completado. Verifica con: docker service ps $SERVICE"
