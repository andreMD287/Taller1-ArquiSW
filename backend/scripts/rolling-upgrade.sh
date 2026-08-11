#!/usr/bin/env bash
# Rolling upgrade sin downtime: actualiza un nodo a la vez y solo avanza al
# siguiente cuando el anterior tiene su readiness en verde. El upstream de
# nginx nunca se queda sin al menos un nodo sano (Removal from Service +
# Redundant Spare, Cap. 4).
set -euo pipefail

READINESS_TIMEOUT="${READINESS_TIMEOUT:-60}"

wait_for_readiness() {
    local url=$1
    local waited=0
    until curl -sf "$url" >/dev/null 2>&1; do
        sleep 2
        waited=$((waited + 2))
        if [ "$waited" -ge "$READINESS_TIMEOUT" ]; then
            echo "[rolling-upgrade] timeout esperando readiness en $url" >&2
            return 1
        fi
    done
}

start=$(date +%s)

echo "[rolling-upgrade] respaldando la imagen actual como auth-backend:previous..."
docker tag auth-backend:latest auth-backend:previous 2>/dev/null \
    || echo "[rolling-upgrade] no habia imagen previa que respaldar (primer despliegue)"

echo "[rolling-upgrade] construyendo la nueva imagen..."
docker compose build backend-1

echo "[rolling-upgrade] actualizando backend-1..."
docker compose up -d --no-deps backend-1
wait_for_readiness "http://localhost:8081/actuator/health/readiness"
echo "[rolling-upgrade] backend-1 listo, sigue backend-2."

echo "[rolling-upgrade] actualizando backend-2..."
docker compose up -d --no-deps backend-2
wait_for_readiness "http://localhost:8082/actuator/health/readiness"
echo "[rolling-upgrade] backend-2 listo."

end=$(date +%s)
echo "[rolling-upgrade] cycle time total: $((end - start))s"
