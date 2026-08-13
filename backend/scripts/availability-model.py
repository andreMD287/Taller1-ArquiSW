#!/usr/bin/env python3
"""Modelo analitico de disponibilidad (diagrama de bloques serie/paralelo).

Por que hace falta un modelo y no basta con medir: el objetivo del taller es
99.99% de disponibilidad, es decir, un presupuesto de ~52.6 minutos de caida
AL AÑO. Eso no se puede demostrar por observacion directa -haria falta un
año de muestreo para tener una sola muestra representativa-. Lo que si se
puede medir en una demo corta es el MTTR de cada modo de falla (con
chaos.sh + probe.sh); este script toma esos MTTR medidos, los combina con
el numero de replicas y la mezcla de trafico real del sistema (5% login,
95% validate), y proyecta la disponibilidad anual esperada.

Topologia modelada (Fase 1 + Fase 2, sin la Fase 4 de HA de Postgres):

  - Tier de logica: N replicas del backend en redundancia activa
    (Redundant Spare (active), Cap. 4) detras del routing mesh de Swarm.
    Disponibilidad del pool = 1 - (1 - A_replica) ** N   (al menos 1 arriba).
  - Tier de datos: UNA instancia de Postgres (Fase 4 la refuerza; sin ella,
    este es el componente menos disponible del sistema, y por diseno del
    taller esta FUERA del camino critico del 95% del trafico).

  - validate (95% del trafico, por defecto): NO toca el tier de datos
    (Fase 1: JWT verificado en memoria). Su disponibilidad es la del pool
    de backend, punto.
  - login (5% del trafico, por defecto): SI toca el tier de datos (persiste
    el refresh token). Es una dependencia en SERIE: A_login = A_app * A_bd.

  A_sistema = (1 - login_ratio) * A_app + login_ratio * (A_app * A_bd)

Cada parametro de entrada es medido (via --probe-csv, o pasado a mano desde
lo que imprime probe.sh) o una asuncion EXPLICITAMENTE marcada como tal
-nunca un numero inventado en silencio-. Sin --probe-csv ni flags de MTTR,
el script corre con defaults documentados en DEFAULTS_DOC de mas abajo, para
que el resultado nunca dependa de una corrida previa para ser reproducible.

Solo libreria estandar: no agrega una dependencia de Python al despliegue.
"""
from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass

MINUTES_PER_YEAR = 365.25 * 24 * 60

# Cada default trae su justificacion: de donde sale si nadie mide nada.
DEFAULTS_DOC = {
    "replica-mtbf-hours": (
        "ASUNCION: 720h (30 dias) entre fallas de una replica individual. "
        "Consistente con tasas de falla tipicas de instancias/contenedores "
        "en la nube publica (single-instance availability ~99.9-99.95% "
        "reportado por AWS/GCP para VMs individuales). No hay forma de "
        "medir esto en una demo corta; se documenta como asuncion."
    ),
    "replica-mttr-seconds": (
        "ASUNCION/MEDIBLE: 15s. Deriva de la config de stack.yml: Swarm "
        "detecta la tarea muerta casi de inmediato con 'docker kill' (no "
        "espera el HEALTHCHECK para notar que el proceso murio) y "
        "reprograma una nueva tarea; el arranque de Spring Boot observado "
        "en logs toma ~8-10s. Sobreescribir con el valor real que imprime "
        "chaos.sh + probe.sh (--replica-mttr-seconds o --probe-csv)."
    ),
    "db-mtbf-hours": (
        "ASUNCION: 2000h entre fallas del contenedor de Postgres. Con una "
        "sola instancia (sin la Fase 4) es el componente menos disponible "
        "del sistema; por diseno del taller, esta fuera del camino critico "
        "del 95% del trafico (ver Fase 1), asi que su impacto en el "
        "sistema completo queda acotado."
    ),
    "db-mttr-seconds": (
        "ASUNCION/MEDIBLE: 15s para el caso cubierto por este modelo -el "
        "contenedor de Postgres muere y restart_policy:condition=any lo "
        "reinicia sobre el MISMO volumen-. NO cubre la caida del nodo "
        "manager completo (ese caso son las ~1h de intervencion manual del "
        "enunciado original, y es exactamente lo que la Fase 4 -recortable- "
        "resuelve con failover automatico de Postgres)."
    ),
}


def availability(mtbf_hours: float, mttr_seconds: float) -> float:
    mtbf_seconds = mtbf_hours * 3600.0
    return mtbf_seconds / (mtbf_seconds + mttr_seconds)


def pool_availability(replica_availability: float, replicas: int) -> float:
    """Al menos 1 de N replicas arriba (redundancia activa, Cap. 4)."""
    return 1.0 - (1.0 - replica_availability) ** replicas


@dataclass
class MeasuredOutage:
    mttr_seconds: float
    mtbf_seconds: float
    outage_count: int
    sample_count: int
    source: str


def measure_from_probe_csv(path: str) -> MeasuredOutage:
    """Deriva MTTR/MTBF de un CSV de probe.sh (columna 'available').

    No distingue de que componente vino cada ventana de caida (para eso
    hace falta cruzar manualmente con el log de chaos.sh, ver README); el
    numero que devuelve es el MTTR/MTBF observado del SISTEMA completo tal
    como lo vio la sonda, que es un limite superior razonable para
    cualquiera de los dos componentes por separado.
    """
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    if not rows:
        raise ValueError(f"{path} no tiene filas")

    outage_durations = []
    uptime_seconds = 0
    in_outage = False
    outage_start = None
    prev_ts = None

    for row in rows:
        ts = int(row["timestamp"])
        available = row["available"] == "1"
        if prev_ts is not None:
            delta = ts - prev_ts
            if in_outage:
                pass  # se contabiliza al cerrar la ventana
            else:
                uptime_seconds += delta
        if not available and not in_outage:
            in_outage = True
            outage_start = ts
        elif available and in_outage:
            in_outage = False
            outage_durations.append(ts - outage_start)
        prev_ts = ts

    if in_outage:
        outage_durations.append(prev_ts - outage_start)

    outage_count = len(outage_durations)
    if outage_count == 0:
        raise ValueError(
            f"{path}: no se observo ninguna ventana de caida; no hay MTTR que medir de esta corrida "
            "(corre chaos.sh en paralelo con probe.sh para generar fallas observables)"
        )

    mttr = sum(outage_durations) / outage_count
    mtbf = uptime_seconds / outage_count if outage_count > 0 else float("inf")

    return MeasuredOutage(
        mttr_seconds=mttr,
        mtbf_seconds=mtbf,
        outage_count=outage_count,
        sample_count=len(rows),
        source=path,
    )


def fmt_pct(x: float, decimals: int = 4) -> str:
    return f"{x * 100:.{decimals}f}%"


def fmt_downtime_per_year(a: float) -> str:
    """Minutos/año de caida equivalentes a una disponibilidad 'a'.

    Mostrar solo el porcentaje se queda sin resolucion cuando el valor tiene
    muchos nueves (con 3 replicas, 1-A puede ser ~1e-16: imposible de leer
    en un porcentaje con pocos decimales, y agregar 16 decimales no ayuda a
    nadie). El downtime/año en minutos o segundos comunica la misma
    magnitud de forma legible.
    """
    minutes = (1 - a) * MINUTES_PER_YEAR
    if minutes >= 1:
        return f"{minutes:.2f} min/ano"
    seconds = minutes * 60
    if seconds >= 0.01:
        return f"{seconds:.2f} s/ano"
    return "~0 (100% a esta escala)"


def main() -> int:
    # forzado explicito: la consola de Windows hereda un codepage que no es
    # UTF-8 por defecto, y este script imprime tildes/enes (disponibilidad,
    # año). Sin esto, los caracteres no-ASCII salen mangled en Git Bash/cmd.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Modelo analitico de disponibilidad (bloques serie/paralelo) para el taller.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--replicas", type=int, default=3, help="replicas del backend (deploy.replicas en stack.yml)")
    parser.add_argument("--replica-mtbf-hours", type=float, default=None)
    parser.add_argument("--replica-mttr-seconds", type=float, default=None)
    parser.add_argument("--db-mtbf-hours", type=float, default=None)
    parser.add_argument("--db-mttr-seconds", type=float, default=None)
    parser.add_argument("--login-ratio", type=float, default=0.05, help="fraccion del trafico que es /login (el resto es /validate)")
    parser.add_argument("--target", type=float, default=99.99, help="objetivo de disponibilidad, en porcentaje")
    parser.add_argument("--probe-csv", type=str, default=None,
                         help="CSV de scripts/probe.sh; si se da, su MTTR/MTBF medido se usa como default "
                              "para replica y db salvo que se pasen flags explicitos")
    args = parser.parse_args()

    measured = None
    if args.probe_csv:
        try:
            measured = measure_from_probe_csv(args.probe_csv)
        except (OSError, ValueError) as e:
            print(f"ERROR leyendo --probe-csv: {e}", file=sys.stderr)
            return 1

    def resolve(flag_value, fallback_hours_or_seconds, doc_key):
        if flag_value is not None:
            return flag_value, "medido/pasado por flag (--" + doc_key.replace("_", "-") + ")"
        if measured is not None and doc_key.endswith("mttr-seconds"):
            return measured.mttr_seconds, f"medido desde {measured.source} (MTTR observado del sistema)"
        return fallback_hours_or_seconds, DEFAULTS_DOC[doc_key]

    replica_mtbf_hours, replica_mtbf_src = resolve(args.replica_mtbf_hours, 720.0, "replica-mtbf-hours")
    replica_mttr_seconds, replica_mttr_src = resolve(args.replica_mttr_seconds, 15.0, "replica-mttr-seconds")
    db_mtbf_hours, db_mtbf_src = resolve(args.db_mtbf_hours, 2000.0, "db-mtbf-hours")
    db_mttr_seconds, db_mttr_src = resolve(args.db_mttr_seconds, 15.0, "db-mttr-seconds")

    a_replica = availability(replica_mtbf_hours, replica_mttr_seconds)
    a_app_pool = pool_availability(a_replica, args.replicas)
    a_bd = availability(db_mtbf_hours, db_mttr_seconds)

    login_ratio = args.login_ratio
    validate_ratio = 1.0 - login_ratio
    a_validate = a_app_pool
    a_login = a_app_pool * a_bd
    a_system = validate_ratio * a_validate + login_ratio * a_login

    target_fraction = args.target / 100.0
    annual_budget_minutes = (1 - target_fraction) * MINUTES_PER_YEAR
    projected_downtime_minutes = (1 - a_system) * MINUTES_PER_YEAR

    print("== Modelo analitico de disponibilidad ==\n")

    if measured is not None:
        print(f"Medicion de entrada: {measured.source}")
        print(f"  ventanas de caida observadas: {measured.outage_count} (sobre {measured.sample_count} muestras)")
        print(f"  MTTR observado (sistema):     {measured.mttr_seconds:.1f}s")
        print(f"  MTBF observado (sistema):     {measured.mtbf_seconds:.1f}s")
        print()

    def row(name, mtbf, mttr, a):
        return f"  {name:<28}{mtbf:>10}{mttr:>9}{fmt_pct(a):>15}  {fmt_downtime_per_year(a)}"

    print("Componentes:")
    print(f"  {'componente':<28}{'MTBF':>10}{'MTTR':>9}{'disponibilidad':>15}  downtime/ano equiv.")
    print(row("backend (1 replica)", f"{replica_mtbf_hours:.1f}h", f"{replica_mttr_seconds:.1f}s", a_replica))
    print(row(f"backend pool ({args.replicas} replicas)", "n/a", "n/a", a_app_pool))
    print(row("postgres (1 instancia)", f"{db_mtbf_hours:.1f}h", f"{db_mttr_seconds:.1f}s", a_bd))
    print()

    print("Fuentes de cada parametro:")
    print(f"  replica MTBF: {replica_mtbf_src}")
    print(f"  replica MTTR: {replica_mttr_src}")
    print(f"  postgres MTBF: {db_mtbf_src}")
    print(f"  postgres MTTR: {db_mttr_src}")
    print()

    print(f"Mezcla de trafico: {login_ratio*100:.0f}% login (serie: app + BD), {validate_ratio*100:.0f}% validate (solo app)")
    print(f"  A(validate) = A(app pool)             = {fmt_pct(a_validate)}")
    print(f"  A(login)    = A(app pool) * A(bd)     = {fmt_pct(a_login)}")
    print(f"  A(sistema)  = {validate_ratio:.2f}*A(validate) + {login_ratio:.2f}*A(login) = {fmt_pct(a_system)}")
    print()

    print(f"Objetivo del taller: {args.target}%  (presupuesto: {annual_budget_minutes:.1f} min/ano de caida)")
    print(f"Disponibilidad proyectada: {fmt_pct(a_system, 6)}  ({fmt_downtime_per_year(a_system)} proyectados)")
    if a_system >= target_fraction:
        print(f"resultado: CUMPLE el objetivo de {args.target}%")
        return 0
    else:
        print(f"resultado: NO cumple el objetivo de {args.target}%")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
