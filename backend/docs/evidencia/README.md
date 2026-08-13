# Evidencia cruda de los experimentos

Archivos crudos (CSV de `probe.sh`, logs de `chaos.sh`/`chaos-db-failover.sh`) de las
corridas reales contra el stack de Swarm en vivo, ejecutadas el **12 de agosto de 2026**.
Son la base de la tabla de experimentos de la sección 12 de
[`docs/documentacion-arquitectura.md`](../documentacion-arquitectura.md); esta carpeta
existe para que esos números no dependan de que alguien vuelva a correr los scripts para
verificarlos — el CSV/log real queda commiteado, no solo el resumen narrado.

Los timestamps de cada archivo son epoch en segundos (columna `timestamp` en los CSV,
prefijo `[N]` en los logs), así que un CSV y un log con marcas de tiempo superpuestas se
pueden correlacionar directamente restando los números.

| Archivo | Experimento | Qué contiene |
|---|---|---|
| `probe-20260812_204156.csv` | E1, E4 | Sonda de 150s (mezcla 5% login / 95% validate) corriendo en paralelo con `chaos-20260812_204201.log`, contra Postgres de instancia única (antes de la Fase 4). 126 muestras, 1 fallo real (login durante la caída de Postgres), `validate` en 100% durante toda la ventana. |
| `chaos-20260812_204201.log` | E2, E4 | Kill de una réplica de backend (reprogramada por Swarm en 28s) seguido de apagar/revivir Postgres (~21s de caída total). Corresponde temporalmente al CSV de arriba. |
| `chaos-db-failover-20260812_211916.log` | E8 | Primer intento de medir el failover del primario con `docker kill`: **timeout, nadie fue promovido** — Swarm revivió el mismo contenedor antes de que `repmgrd` pudiera detectar la caída. Resultado negativo que llevó a corregir el experimento (ver ADR-11). |
| `chaos-db-failover-20260812_212301.log` | E9 (primera corrida) | Failover corregido (`docker service scale =0`): **29s de MTTR**. Esta corrida fue la que reveló el split-brain al revivir el viejo primario sin vaciar su volumen (ver el hallazgo documentado en ADR-11) — el split-brain en sí no quedó en un log automatizado, se diagnosticó a mano con `psql` directo a cada nodo. |
| `chaos-db-failover-20260812_213020.log` | E9 (segunda corrida, script ya corregido) | Failover repetido tras arreglar el script para vaciar el volumen del nodo demovido antes de reincorporarlo: **29s de MTTR de nuevo** (reproducible), sin split-brain esta vez. |
| `probe-20260812_220509.csv` | E5 | Sonda de 140s (intervalo 0.3s) corriendo en paralelo con `rolling-upgrade.sh` (cycle time 115s). 133 muestras, **0 fallidas**. |
| `chaos-20260812_220802.log` | E2 (repetición), E10 | Segunda corrida de kill de réplica (28s de nuevo, mismo resultado) seguida de apagar/revivir los 3 nodos de Postgres **a la vez** (ya con la Fase 4 desplegada), sin split-brain porque ninguno quedó desactualizado respecto a otro. |
| `probe-20260812_220819.csv` | E10 | Sonda de 90s corriendo en paralelo con el chaos.sh de arriba. 90 muestras, 0 fallidas (la ventana de caída de la BD fue corta y la muestra de login de 5% no alcanzó a capturar un fallo esta vez — comportamiento esperado por el muestreo aleatorio, no evidencia de que no hubo caída: el log del chaos confirma que sí la hubo). |

## Cómo reproducir

Los comandos exactos están en `GUIA-DE-USO.md`. En resumen: `./scripts/deploy.sh`, y
luego `./scripts/probe.sh <segundos>` en una terminal con `./scripts/chaos.sh` o
`./scripts/chaos-db-failover.sh` en otra, en paralelo.
