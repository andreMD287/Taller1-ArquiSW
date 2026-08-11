#!/usr/bin/env bash
# Inyeccion de fallas controlada para la demo: mata una replica, la revive,
# y despues tira el tier de datos. Pensado para correr en paralelo con
# probe.sh (ver docs/03-mediciones.md para el protocolo del experimento).
set -euo pipefail

STEP_WAIT="${STEP_WAIT:-15}"

echo "[chaos] esperando ${STEP_WAIT}s para que probe.sh tome una linea base sana..."
sleep "$STEP_WAIT"

echo "[chaos] matando backend-1 (simula la caida de una replica)..."
docker compose stop backend-1
sleep "$STEP_WAIT"

echo "[chaos] reviviendo backend-1..."
docker compose start backend-1
sleep "$STEP_WAIT"

echo "[chaos] deteniendo postgres (simula la caida del tier de datos)..."
docker compose stop postgres
sleep "$STEP_WAIT"

echo "[chaos] reviviendo postgres..."
docker compose start postgres

echo "[chaos] experimento de caos terminado."
