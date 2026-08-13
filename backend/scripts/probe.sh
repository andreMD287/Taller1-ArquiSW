#!/usr/bin/env bash
# Sonda de disponibilidad: mide el sistema desde afuera, a traves de nginx,
# igual que lo veria un cliente real. No golpea /actuator/health/readiness
# a proposito: readiness cae cuando Postgres cae, y eso haria ver como
# "caida total" algo que deberia ser degradacion parcial. En su lugar usa
# /api/auth/validate sobre una sesion ya emitida, que es exactamente lo que
# TokenService sigue sirviendo (degraded: true) cuando el tier de datos
# esta abajo. Esa es la metrica que le importa al taller.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
DURATION="${1:-60}"
INTERVAL="${INTERVAL:-0.5}"
TARGET_AVAILABILITY="99.99"
TS=$(date +%Y%m%d_%H%M%S)
OUT_CSV="${OUT_CSV:-$(dirname "$0")/probe_${TS}.csv}"
# alfanumerico puro: RegisterRequest rechaza guiones/guiones bajos (TS trae "_").
PROBE_USER="probeuser${TS//_/}"
PROBE_PASS="probepass1234"

echo "== Sonda de disponibilidad =="
echo "objetivo: $BASE_URL | duracion: ${DURATION}s | intervalo: ${INTERVAL}s"
echo "csv crudo: $OUT_CSV"
echo ""

curl -s -o /dev/null -X POST "$BASE_URL/api/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$PROBE_USER\",\"password\":\"$PROBE_PASS\"}"

TOKEN=""
for attempt in 1 2 3 4 5; do
    TOKEN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PROBE_USER\",\"password\":\"$PROBE_PASS\"}" \
        | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
    [ -n "$TOKEN" ] && break
    echo "esperando a que el sistema arranque sano (intento $attempt)..."
    sleep 2
done

if [ -z "$TOKEN" ]; then
    echo "ERROR: no se pudo obtener un token inicial; el sistema no esta sano al arrancar la sonda." >&2
    exit 1
fi

echo "token de prueba obtenido, iniciando medicion..."
echo "timestamp,success,http_status,latency_ms" > "$OUT_CSV"

start_time=$(date +%s)
end_time=$((start_time + DURATION))
total=0
success=0
outage_count=0
in_outage=0

while [ "$(date +%s)" -lt "$end_time" ]; do
    ts=$(date +%s)
    start_ms=$(date +%s%3N)
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 -X POST "$BASE_URL/api/auth/validate" \
        -H "Content-Type: application/json" \
        -d "{\"token\":\"$TOKEN\"}" 2>/dev/null)
    status="${status:-000}"
    end_ms=$(date +%s%3N)
    latency=$((end_ms - start_ms))

    total=$((total + 1))
    if [ "$status" = "200" ]; then
        ok=1
        success=$((success + 1))
        if [ "$in_outage" -eq 1 ]; then
            in_outage=0
            echo "[$ts] fin de ventana de caida"
        fi
    else
        ok=0
        if [ "$in_outage" -eq 0 ]; then
            in_outage=1
            outage_count=$((outage_count + 1))
            echo "[$ts] inicio de ventana de caida (status=$status)"
        fi
    fi

    echo "$ts,$ok,$status,$latency" >> "$OUT_CSV"
    sleep "$INTERVAL"
done

# ---- Metricas ----
failed=$((total - success))
availability=$(awk -v s="$success" -v t="$total" 'BEGIN { printf "%.4f", (t>0) ? (s/t*100) : 0 }')
downtime_seconds=$(awk -v f="$failed" -v i="$INTERVAL" 'BEGIN { printf "%.1f", f*i }')
downtime_int=$(awk -v d="$downtime_seconds" 'BEGIN { printf "%d", d }')
elapsed=$(( $(date +%s) - start_time ))
uptime_seconds=$((elapsed - downtime_int))

# MTBF/MTTR aproximados a partir de las ventanas de caida contadas por muestreo.
mtbf=$(awk -v u="$uptime_seconds" -v o="$outage_count" 'BEGIN { d = (o==0)?1:o; printf "%.1f", u/d }')
mttr=$(awk -v d="$downtime_seconds" -v o="$outage_count" 'BEGIN { den = (o==0)?1:o; printf "%.1f", d/den }')

sorted_latencies=$(awk -F, 'NR>1 && $2==1 {print $4}' "$OUT_CSV" | sort -n)
count=$(printf "%s\n" "$sorted_latencies" | grep -c . || true)

percentile() {
    local p=$1
    if [ "$count" -eq 0 ]; then echo "N/A"; return; fi
    local idx
    idx=$(awk -v p="$p" -v n="$count" 'BEGIN { i = int((p/100)*n + 0.999999); if (i < 1) i = 1; if (i > n) i = n; print i }')
    printf "%s\n" "$sorted_latencies" | sed -n "${idx}p"
}

p50=$(percentile 50)
p95=$(percentile 95)
p99=$(percentile 99)

echo ""
echo "== Resultados =="
echo "muestras totales:         $total"
echo "exitosas:                 $success"
echo "fallidas:                 $failed"
echo "ventanas de caida:        $outage_count"
echo "disponibilidad observada: ${availability}%"
echo "objetivo del taller:      ${TARGET_AVAILABILITY}%"
echo "MTBF aprox. (s):          $mtbf"
echo "MTTR aprox. (s):          $mttr"
echo "latencia p50 (ms):        $p50"
echo "latencia p95 (ms):        $p95"
echo "latencia p99 (ms):        $p99"

if awk -v a="$availability" -v t="$TARGET_AVAILABILITY" 'BEGIN { exit !(a>=t) }'; then
    echo "resultado:                CUMPLE el objetivo de ${TARGET_AVAILABILITY}%"
else
    echo "resultado:                NO cumple el objetivo de ${TARGET_AVAILABILITY}%"
fi

echo ""
echo "CSV crudo guardado en: $OUT_CSV"
