#!/usr/bin/env bash
# Mide el MTTR real de un failover de Postgres (Fase 4): identifica el
# primario actual del cluster repmgr (postgres-1/2/3), lo apaga, y
# cronometra hasta que repmgrd promueve un standby. Este es exactamente el
# numero que separa la intervencion manual (~1h, el escenario del enunciado
# original) del failover automatico: con esto baja al orden de segundos.
#
# "docker service scale =0" en vez de "docker kill": con restart_policy
# condition=any, un kill simple hace que Swarm reviva el MISMO contenedor
# (mismo volumen, todavia con su rol de primario en el WAL) en ~8s en esta
# maquina -mas rapido que reconnect_attempts(3) x reconnect_interval(5s) de
# repmgr.conf-, asi que repmgrd nunca llega a promover a nadie: solo
# reconecta. Para forzar una promocion de verdad hay que mantener al
# primario abajo mas tiempo que esa ventana de reconexion.
#
# SPLIT-BRAIN CONFIRMADO EN VIVO al construir este script: revivir al viejo
# primario con su volumen intacto NO lo hace rejoin como standby. Bitnami
# postgresql-repmgr, al encontrar un PGDATA ya poblado en el arranque, lo
# reusa tal cual -incluyendo su rol de primario- sin comprobar si alguien
# mas fue promovido mientras tanto. Resultado: dos nodos aceptando
# escrituras a la vez. La unica forma segura de reincorporarlo es borrar su
# volumen para forzar un re-clonado limpio (pg_basebackup) desde el
# primario real. Automatizado abajo (wipe_node_volume); NUNCA revivir el
# viejo primario sin este paso.
set -uo pipefail

STACK_NAME="${STACK_NAME:-auth}"
DB_USER="${DB_USER:-auth}"
DB_NAME="${DB_NAME:-authdb}"
POLL_INTERVAL="${POLL_INTERVAL:-1}"
TIMEOUT="${TIMEOUT:-120}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/../results"
mkdir -p "$RESULTS_DIR"
LOG_FILE="${LOG_FILE:-${RESULTS_DIR}/chaos-db-failover-$(date +%Y%m%d_%H%M%S).log}"

log() {
    echo "[$(date +%s)] $1" | tee -a "$LOG_FILE"
}

node_container() {
    docker ps -q --filter "label=com.docker.swarm.service.name=${STACK_NAME}_$1" | head -1
}

# postgres-1 -> pgdata1 (ver el mapeo volumes:/environment en stack.yml)
volume_for_node() {
    echo "pgdata${1##*-}"
}

wipe_node_volume() {
    local node="$1"
    local vol="${STACK_NAME}_$(volume_for_node "$node")"
    # Swarm retiene contenedores de tareas terminadas (task history) aunque
    # el servicio este en 0 replicas; mientras existan, siguen "usando" el
    # volumen y el rm falla. Hay que tirarlos primero.
    local stale
    stale=$(docker ps -a -q --filter "label=com.docker.swarm.service.name=${STACK_NAME}_${node}")
    if [ -n "$stale" ]; then
        docker rm -f $stale >/dev/null 2>&1 || true
    fi
    if docker volume rm "$vol" >/dev/null 2>&1; then
        log "volumen $vol borrado: $node arrancara vacio y se re-clonara del primario actual (pg_basebackup)"
    else
        log "AVISO: no pude borrar el volumen $vol; si $node revive con datos viejos puede causar split-brain"
    fi
}

# "f" = pg_is_in_recovery() = false = es el primario. Cualquier otra cosa
# (vacio, "t", error) significa "no es primario ahora mismo".
is_primary() {
    local cid="$1"
    docker exec "$cid" sh -c \
        "PGPASSWORD=\$(cat /run/secrets/postgres_password) psql -h 127.0.0.1 -U ${DB_USER} -d ${DB_NAME} -tAc 'select pg_is_in_recovery();'" \
        2>/dev/null | tr -d '[:space:]'
}

log "chaos-db-failover.sh iniciado (stack=$STACK_NAME)"
log "buscando el primario actual entre postgres-1, postgres-2, postgres-3..."

PRIMARY_NODE=""
PRIMARY_CID=""
for node in postgres-1 postgres-2 postgres-3; do
    cid=$(node_container "$node")
    if [ -z "$cid" ]; then
        log "  $node: sin contenedor corriendo"
        continue
    fi
    state=$(is_primary "$cid")
    log "  $node ($cid): pg_is_in_recovery=${state:-sin respuesta}"
    if [ "$state" = "f" ]; then
        PRIMARY_NODE="$node"
        PRIMARY_CID="$cid"
    fi
done

if [ -z "$PRIMARY_NODE" ]; then
    log "ERROR: no pude identificar un primario sano antes de empezar. Aborto."
    exit 1
fi

log "primario actual: $PRIMARY_NODE ($PRIMARY_CID)"
log "escalando ${STACK_NAME}_${PRIMARY_NODE} a 0 replicas (simula la caida sostenida del primario)..."
kill_ts=$(date +%s)
docker service scale "${STACK_NAME}_${PRIMARY_NODE}=0" --detach=true >/dev/null
log "primario apagado"

OTHER_NODES=()
for node in postgres-1 postgres-2 postgres-3; do
    [ "$node" != "$PRIMARY_NODE" ] && OTHER_NODES+=("$node")
done

log "esperando a que repmgrd promueva a uno de: ${OTHER_NODES[*]}..."

promoted_node=""
elapsed=0
while [ "$elapsed" -lt "$TIMEOUT" ]; do
    for node in "${OTHER_NODES[@]}"; do
        cid=$(node_container "$node")
        [ -z "$cid" ] && continue
        state=$(is_primary "$cid")
        if [ "$state" = "f" ]; then
            promoted_node="$node"
            break 2
        fi
    done
    sleep "$POLL_INTERVAL"
    elapsed=$(( $(date +%s) - kill_ts ))
done

if [ -z "$promoted_node" ]; then
    log "TIMEOUT: nadie fue promovido a primario en ${TIMEOUT}s. Revisa 'docker service logs ${STACK_NAME}_postgres-2' / postgres-3."
    exit 1
fi

promoted_ts=$(date +%s)
mttr=$((promoted_ts - kill_ts))
log "$promoted_node promovido a primario. MTTR de failover: ${mttr}s"
log "el backend deberia seguir al nuevo primario solo (targetServerType=primary en el JDBC URL), sin reiniciarlo."

log "reincorporando $PRIMARY_NODE como standby (con volumen limpio, para evitar split-brain)..."
wipe_node_volume "$PRIMARY_NODE"
docker service scale "${STACK_NAME}_${PRIMARY_NODE}=1" --detach=true >/dev/null
log "$PRIMARY_NODE re-desplegado; el re-clonado (pg_basebackup) puede tardar mientras el volumen sea chico."

log "siguiente paso: alimenta este numero al modelo -> python3 scripts/availability-model.py --db-mttr-seconds $mttr"
log "log completo: $LOG_FILE"
