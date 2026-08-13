#!/usr/bin/env bash
# Sonda de disponibilidad: mide el sistema desde afuera, a traves del
# routing mesh de Swarm (http://localhost:8080), igual que lo veria un
# cliente real. Mezcla realista de trafico -5% login, 95% validate por
# defecto- porque la disponibilidad del sistema se pondera por tipo de
# operacion: login SI depende del tier de datos (TokenService.issue
# persiste el refresh token), validate NO (Fase 1: verificacion de JWT en
# memoria). Medir solo validate, como hacia la version anterior de este
# script, escondia esa diferencia.
#
# Taxonomia del proyecto (Cap. 4, FaultKind, ver GlobalExceptionHandler): una
# respuesta de error EXPECTED (credenciales invalidas, token vencido) es el
# sistema respondiendo segun su especificacion, NO es un fallo. Solo FAULT,
# FAILURE, o la ausencia total de respuesta cuentan contra la disponibilidad.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
DURATION="${1:-60}"
INTERVAL="${INTERVAL:-0.5}"
LOGIN_RATIO="${LOGIN_RATIO:-5}"    # entero 0-100: % de peticiones que son /login en vez de /validate
POOL_SIZE="${POOL_SIZE:-5}"        # usuarios de prueba pre-registrados, reutilizados durante toda la corrida
TARGET_AVAILABILITY="99.99"

TS=$(date +%Y%m%d_%H%M%S)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/../results"
mkdir -p "$RESULTS_DIR"
OUT_CSV="${OUT_CSV:-${RESULTS_DIR}/probe-${TS}.csv}"

echo "== Sonda de disponibilidad =="
echo "objetivo: $BASE_URL | duracion: ${DURATION}s | intervalo: ${INTERVAL}s | mezcla: ${LOGIN_RATIO}% login / $((100 - LOGIN_RATIO))% validate"
echo "csv crudo: $OUT_CSV"
echo ""

# --- pool de usuarios de prueba: alfanumerico puro (RegisterRequest rechaza
# guiones/guiones bajos, TS trae "_") ---
PROBE_PASS="probepass1234"
declare -a POOL_USER
declare -a POOL_TOKEN

for i in $(seq 0 $((POOL_SIZE - 1))); do
    uname="probe${TS//_/}u${i}"
    curl -s -o /dev/null -X POST "$BASE_URL/api/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$uname\",\"password\":\"$PROBE_PASS\"}"

    token=""
    for attempt in 1 2 3 4 5; do
        token=$(curl -s -X POST "$BASE_URL/api/auth/login" \
            -H "Content-Type: application/json" \
            -d "{\"username\":\"$uname\",\"password\":\"$PROBE_PASS\"}" \
            | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
        [ -n "$token" ] && break
        echo "esperando a que el sistema arranque sano (usuario $i, intento $attempt)..."
        sleep 2
    done
    if [ -z "$token" ]; then
        echo "ERROR: no se pudo inicializar el usuario de prueba $uname; el sistema no esta sano al arrancar la sonda." >&2
        exit 1
    fi
    POOL_USER[$i]="$uname"
    POOL_TOKEN[$i]="$token"
done

echo "pool de $POOL_SIZE usuarios listo, iniciando medicion..."
echo "timestamp,operation,available,kind,http_status,latency_ms" > "$OUT_CSV"

start_time=$(date +%s)
end_time=$((start_time + DURATION))

total=0; success=0
total_login=0; success_login=0
total_validate=0; success_validate=0
outage_count=0
in_outage=0
outage_start=0
declare -a OUTAGE_DURATIONS

extract_kind() {
    # vacio si el cuerpo no trae "kind" (respuesta 2xx, o sin respuesta alguna)
    echo "$1" | grep -o '"kind":"[^"]*"' | cut -d'"' -f4
}

while [ "$(date +%s)" -lt "$end_time" ]; do
    ts=$(date +%s)
    idx=$((RANDOM % POOL_SIZE))
    roll=$((RANDOM % 100))

    if [ "$roll" -lt "$LOGIN_RATIO" ]; then
        op="login"
        uname="${POOL_USER[$idx]}"
        start_ms=$(date +%s%3N)
        raw=$(curl -s --max-time 3 -w "\n%{http_code}" -X POST "$BASE_URL/api/auth/login" \
            -H "Content-Type: application/json" \
            -d "{\"username\":\"$uname\",\"password\":\"$PROBE_PASS\"}" 2>/dev/null)
        end_ms=$(date +%s%3N)
        status=$(echo "$raw" | tail -n1)
        payload=$(echo "$raw" | sed '$d')
        if [ "$status" = "200" ]; then
            newtoken=$(echo "$payload" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
            [ -n "$newtoken" ] && POOL_TOKEN[$idx]="$newtoken"
        fi
    else
        op="validate"
        token="${POOL_TOKEN[$idx]}"
        start_ms=$(date +%s%3N)
        raw=$(curl -s --max-time 3 -w "\n%{http_code}" -X POST "$BASE_URL/api/auth/validate" \
            -H "Content-Type: application/json" \
            -d "{\"token\":\"$token\"}" 2>/dev/null)
        end_ms=$(date +%s%3N)
        status=$(echo "$raw" | tail -n1)
        payload=$(echo "$raw" | sed '$d')
    fi

    status="${status:-000}"
    latency=$((end_ms - start_ms))
    kind=""

    if [ "$status" = "200" ] || [ "$status" = "201" ]; then
        available=1
    else
        kind=$(extract_kind "$payload")
        if [ "$kind" = "EXPECTED" ]; then
            available=1
        else
            # FAULT, FAILURE, o cuerpo no interpretable (incluye "sin respuesta",
            # status=000): cuenta contra la disponibilidad.
            available=0
        fi
    fi

    total=$((total + 1))
    if [ "$op" = "login" ]; then
        total_login=$((total_login + 1))
        [ "$available" -eq 1 ] && success_login=$((success_login + 1))
    else
        total_validate=$((total_validate + 1))
        [ "$available" -eq 1 ] && success_validate=$((success_validate + 1))
    fi

    if [ "$available" -eq 1 ]; then
        success=$((success + 1))
        if [ "$in_outage" -eq 1 ]; then
            in_outage=0
            duration=$((ts - outage_start))
            OUTAGE_DURATIONS+=("$duration")
            echo "[$ts] fin de ventana de caida (duracion ${duration}s)"
        fi
    else
        if [ "$in_outage" -eq 0 ]; then
            in_outage=1
            outage_start=$ts
            outage_count=$((outage_count + 1))
            echo "[$ts] inicio de ventana de caida (op=$op status=$status kind=${kind:-N/A})"
        fi
    fi

    echo "$ts,$op,$available,${kind:-},$status,$latency" >> "$OUT_CSV"
    sleep "$INTERVAL"
done

# si la medicion termina en medio de una caida, se cierra la ventana igual.
if [ "$in_outage" -eq 1 ]; then
    duration=$(( $(date +%s) - outage_start ))
    OUTAGE_DURATIONS+=("$duration")
    echo "[$(date +%s)] ventana de caida seguia abierta al terminar la medicion (duracion ${duration}s)"
fi

# ---- Metricas ----
failed=$((total - success))
availability=$(awk -v s="$success" -v t="$total" 'BEGIN { printf "%.4f", (t>0) ? (s/t*100) : 0 }')
avail_login=$(awk -v s="$success_login" -v t="$total_login" 'BEGIN { printf "%.4f", (t>0) ? (s/t*100) : 0 }')
avail_validate=$(awk -v s="$success_validate" -v t="$total_validate" 'BEGIN { printf "%.4f", (t>0) ? (s/t*100) : 0 }')

elapsed=$(( $(date +%s) - start_time ))
downtime_total=0
for d in "${OUTAGE_DURATIONS[@]:-}"; do
    [ -n "$d" ] && downtime_total=$((downtime_total + d))
done
uptime_seconds=$((elapsed - downtime_total))

mttr="N/A"
mtbf="N/A"
if [ "$outage_count" -gt 0 ]; then
    mttr=$(awk -v d="$downtime_total" -v o="$outage_count" 'BEGIN { printf "%.1f", d/o }')
    mtbf=$(awk -v u="$uptime_seconds" -v o="$outage_count" 'BEGIN { printf "%.1f", u/o }')
fi

sorted_latencies=$(awk -F, 'NR>1 && $3==1 {print $6}' "$OUT_CSV" | sort -n)
count=$(printf "%s\n" "$sorted_latencies" | grep -c . || true)

percentile() {
    local p=$1
    if [ "$count" -eq 0 ]; then echo "N/A"; return; fi
    local idx
    idx=$(awk -v p="$p" -v n="$count" 'BEGIN { i = int((p/100)*n + 0.999999); if (i < 1) i = 1; if (i > n) i = n; print i }')
    printf "%s\n" "$sorted_latencies" | sed -n "${idx}p"
}

p50=$(percentile 50); p95=$(percentile 95); p99=$(percentile 99)

echo ""
echo "== Resultados =="
echo "muestras totales:              $total  (login=$total_login, validate=$total_validate)"
echo "disponibles (EXPECTED cuenta): $success"
echo "fallidas (FAULT/FAILURE):      $failed"
echo "ventanas de caida:             $outage_count"
if [ "$outage_count" -gt 0 ]; then
    echo -n "duracion de cada ventana (s):  "
    (IFS=,; echo "${OUTAGE_DURATIONS[*]}")
fi
echo "disponibilidad observada:      ${availability}%   (login: ${avail_login}%, validate: ${avail_validate}%)"
echo "objetivo del taller:           ${TARGET_AVAILABILITY}%"
echo "MTBF observado (s):            $mtbf"
echo "MTTR observado (s):            $mttr"
echo "latencia p50/p95/p99 (ms):     $p50 / $p95 / $p99"

if awk -v a="$availability" -v t="$TARGET_AVAILABILITY" 'BEGIN { exit !(a>=t) }'; then
    echo "resultado:                     CUMPLE ${TARGET_AVAILABILITY}% en esta muestra (ver availability-model.py para la proyeccion anual)"
else
    echo "resultado:                     NO cumple ${TARGET_AVAILABILITY}% en esta muestra"
fi

echo ""
echo "CSV crudo guardado en: $OUT_CSV"
if [ "$mttr" != "N/A" ]; then
    echo "siguiente paso: alimenta este MTTR al modelo, ej.:"
    echo "  python3 scripts/availability-model.py --replica-mttr-seconds $mttr"
fi
