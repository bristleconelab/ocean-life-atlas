"""Build public/data/completeness-h3.json: inventory completeness of every H3 cell (resolution 3, ~12,400 km²) of the
ocean, from the full OBIS occurrence store.

For each cell: species recorded (S), species recorded once (f1) and twice (f2), records, newest year, and the
bias-corrected Chao1 estimate S + f1 (f1 - 1) / (2 (f2 + 1)). Completeness = S / Chao1. Records stand in for
individuals, so this is an inventory-completeness index, not a census.

Source: s3://obis-open-data/occurrence/*.parquet (OBIS open data on AWS, one file per dataset, ~99 GB in 2026-11),
read with DuckDB (only five columns), in place or from a local mirror given in OBIS_PARQUET. Rows: not dropped, not absences, with a species id, not flagged ON_LAND.

Run where bandwidth and CPU are cheap (here: the roberta VM; ~20-60 min):
    uv venv .venv && uv pip install --python .venv/bin/python "duckdb<2" h3
    .venv/bin/python build_h3_completeness.py out.json
"""
import json
import os
import sys
import time

import duckdb
import h3

OUT = sys.argv[1] if len(sys.argv) > 1 else "completeness-h3.json"
# a local mirror is far faster than ~7,500 small remote files at ~300 ms each from Central Asia
SRC = os.environ.get("OBIS_PARQUET", "s3://obis-open-data/occurrence/*.parquet")
RES = 3
t0 = time.time()
c = duckdb.connect()
c.sql("SET home_directory = '/root'; SET threads = 16; SET memory_limit = '40GB'; SET preserve_insertion_order = false; SET temp_directory = '/data/ocean-life-atlas/h3/tmp';")
c.sql("INSTALL httpfs; LOAD httpfs; INSTALL h3 FROM community; LOAD h3; SET s3_region = 'us-east-1';")
c.sql(f"""
CREATE TABLE sp AS
SELECT h3_latlng_to_cell(interpreted.decimalLatitude, interpreted.decimalLongitude, {RES}) AS cell,
       interpreted.speciesid AS species,
       count(*) AS n,
       max(interpreted.date_year) AS last_year
FROM read_parquet('{SRC}')
WHERE NOT coalesce(dropped, false) AND NOT coalesce(absence, false)
  AND interpreted.speciesid IS NOT NULL
  AND interpreted.decimalLatitude BETWEEN -90 AND 90 AND interpreted.decimalLongitude BETWEEN -180 AND 180
  AND NOT list_contains(coalesce(flags, []), 'ON_LAND')
GROUP BY 1, 2
""")
print(f"species x cell rows: {c.sql('SELECT count(*) FROM sp').fetchone()[0]:,} ({time.time() - t0:.0f} s)", flush=True)
rows = c.sql("""
SELECT cell, count(*) AS s, sum(CASE WHEN n = 1 THEN 1 ELSE 0 END) AS f1, sum(CASE WHEN n = 2 THEN 1 ELSE 0 END) AS f2,
       sum(n) AS records, max(last_year) AS last_year
FROM sp GROUP BY cell ORDER BY cell
""").fetchall()


def ring(cell_int):
    """Hexagon outline, lon/lat, 3 decimals; unwrapped so a cell across 180° is one shape (lon may pass 180)."""
    pts = h3.cell_to_boundary(h3.int_to_str(cell_int))  # (lat, lon)
    lons = [p[1] for p in pts]
    if max(lons) - min(lons) > 180:
        lons = [x + 360 if x < 0 else x for x in lons]
    return [v for (lat, _), lon in zip(pts, lons) for v in (round(lon, 3), round(lat, 3))]


cells = []
for cell, s, f1, f2, records, last_year in rows:
    est = s + f1 * (f1 - 1) / (2 * (f2 + 1))
    cells.append({
        "r": ring(cell), "s": s, "f1": f1, "f2": f2, "n": int(records),
        "y": int(last_year) if last_year else None,
        # completeness only where there is something to estimate from
        "c": round(s / est, 3) if s >= 20 else None,
    })
out = {
    "source": "OBIS open data (s3://obis-open-data/occurrence), read " + time.strftime("%Y-%m-%d"),
    "method": "H3 resolution 3; per cell bias-corrected Chao1 from records per species; not dropped, not absent, not ON_LAND",
    "resolution": RES,
    "cells": cells,
}
with open(OUT, "w") as f:
    json.dump(out, f, separators=(",", ":"))
est_cells = [x for x in cells if x["c"] is not None]
print(f"{len(cells):,} cells, {len(est_cells):,} with an estimate, median completeness "
      f"{sorted(x['c'] for x in est_cells)[len(est_cells) // 2] if est_cells else 'n/a'}, {time.time() - t0:.0f} s -> {OUT}", flush=True)
