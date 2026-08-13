#!/usr/bin/env bash
# Inyeccion de fallas controlada contra el stack de Swarm: mata una tarea del
# backend (Swarm la reprograma sola -Reconfiguration, Cap. 4- sin que nadie
# corra "docker compose start" a mano) y despues apaga el TIER DE DATOS
# COMPLETO (los 3 nodos del cluster repmgr, no solo el primario) unos
# segundos. Pensado para correr en paralelo con probe.sh; deja un log con
# marcas de tiempo (mismo reloj que el CSV de la sonda: epoch en segundos)
# para poder correlacionar los dos despues.
#
# Complementa a chaos-db-failover.sh, no lo reemplaza: este script apaga
# TODO el tier de datos (deberia degradar login, y validate deberia seguir
# en 100% -esa es la prueba de la Fase 1-); chaos-db-failover.sh mata SOLO
# el primario y mide el failover automatico entre los otros dos (Fase 4).
set -euo pipefail

STACK_NAME="${STACK_NAME:-auth}"
STEP_WAIT="${STEP_WAIT:-15}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/../results"
mkdir -p "$RESULTS_DIR"
LOG_FILE="${LOG_FILE:-${RESULTS_DIR}/chaos-$(date +%Y%m%d_%H%M%S).log}"

log() {
    echo "[$(date +%s)] $1" | tee -a "$LOG_FILE"
}

wait_for_replicas() {
    local service="$1" desired="$2" timeout="${3:-60}"
    local waited=0
    while true; do
        local current
        current=$(docker service ls --filter "name=$service" --format '{{.Replicas}}' | cut -d/ -f1)
        if [ "$current" = "$desired" ]; then
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
        if [ "$waited" -ge "$timeout" ]; then
            log "timeout esperando ${desired} replicas de ${service} (quedo en ${current:-?})"
            return 1
        fi
    done
}

log "chaos.sh iniciado (stack=$STACK_NAME, step_wait=${STEP_WAIT}s)"
log "esperando ${STEP_WAIT}s para que probe.sh tome una linea base sana..."
sleep "$STEP_WAIT"

log "matando una tarea de ${STACK_NAME}_backend (simula la caida de una replica)..."
BACKEND_CID=$(docker ps -q --filter "label=com.docker.swarm.service.name=${STACK_NAME}_backend" | head -1)
if [ -z "$BACKEND_CID" ]; then
    log "ERROR: no encontre ningun contenedor corriendo de ${STACK_NAME}_backend"
else
    docker kill "$BACKEND_CID" >/dev/null
    log "tarea $BACKEND_CID matada de un kill -9; Swarm deberia reemplazarla sola"
fi
if wait_for_replicas "${STACK_NAME}_backend" 3 60; then
    log "replicas de backend de vuelta a 3/3 (reprogramadas por Swarm, sin intervencion manual)"
fi

sleep "$STEP_WAIT"

log "deteniendo el tier de datos completo (postgres-1, postgres-2, postgres-3)..."
for node in postgres-1 postgres-2 postgres-3; do
    docker service scale "${STACK_NAME}_${node}=0" --detach=true >/dev/null
done
sleep "$STEP_WAIT"

log "reviviendo el tier de datos..."
for node in postgres-1 postgres-2 postgres-3; do
    docker service scale "${STACK_NAME}_${node}=1" --detach=true >/dev/null
done
for node in postgres-1 postgres-2 postgres-3; do
    if wait_for_replicas "${STACK_NAME}_${node}" 1 90; then
        log "$node de vuelta arriba"
    fi
done
log "nota: los 3 nodos vuelven con su volumen intacto (todos se apagaron juntos, ninguno"
log "quedo desactualizado respecto a otro), asi que repmgr puede re-formar el cluster sin"
log "el riesgo de split-brain que si existe al revivir solo un EX-primario (ver chaos-db-failover.sh)."

log "experimento de caos terminado. Log: $LOG_FILE"
