#!/usr/bin/env python3
"""
explore_telemetry.py
--------------------
Quick inspector for LRS collection SQLite databases.

Usage:
    python explore_telemetry.py                       # latest .db in data/collections/
    python explore_telemetry.py path/to/file.db       # specific file
    python explore_telemetry.py --plot Speed RPM       # plot named variables over time
    python explore_telemetry.py --group Motion         # show only one variable group
    python explore_telemetry.py --vars                 # list all variables + stats
    python explore_telemetry.py --session              # dump session metadata

Options
-------
  -p / --plot  VAR ...   Plot one or more variables against session_time
  -g / --group GROUP     Filter catalog output to a variable group
  -v / --vars            Print full variable catalog with min/max/sample stats
  -s / --session         Print the info + metadata tables
  -n N                   Sample only N ticks (default: all)
  -o / --offset N        Start from tick offset N
"""

from __future__ import annotations

import argparse
import io
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

# Force UTF-8 output on Windows so box-drawing chars and colour codes work
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ── Resolve DB path ────────────────────────────────────────────────────────────

COLLECTIONS_DIR = Path(__file__).parent / "data" / "collections"

def resolve_db(arg: str | None) -> Path:
    if arg:
        p = Path(arg)
        if not p.exists():
            # Try relative to collections dir
            p2 = COLLECTIONS_DIR / arg
            if p2.exists():
                return p2
        if not p.exists():
            sys.exit(f"[error] File not found: {arg}")
        return p
    # Find latest
    dbs = sorted(COLLECTIONS_DIR.glob("*.db"), reverse=True)
    if not dbs:
        sys.exit(f"[error] No .db files found in {COLLECTIONS_DIR}")
    return dbs[0]


# ── Terminal colour helpers ────────────────────────────────────────────────────

class C:
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    DIM    = "\033[2m"
    CYAN   = "\033[96m"
    GREEN  = "\033[92m"
    YELLOW = "\033[93m"
    RED    = "\033[91m"
    BLUE   = "\033[94m"
    PURPLE = "\033[95m"

def bold(s): return f"{C.BOLD}{s}{C.RESET}"
def dim(s):  return f"{C.DIM}{s}{C.RESET}"
def cyan(s): return f"{C.CYAN}{s}{C.RESET}"
def green(s): return f"{C.GREEN}{s}{C.RESET}"
def yellow(s): return f"{C.YELLOW}{s}{C.RESET}"
def red(s):  return f"{C.RED}{s}{C.RESET}"


# ── VAR grouping (matches frontend logic) ─────────────────────────────────────

import re

GROUP_RULES = [
    (r"^CarIdx",                                                           "CarIdx"),
    (r"^(CarClass|PlayerCar|Car)",                                         "Car"),
    (r"^(Chan[A-Z]|CpuUsage|GpuUsage|Mem[A-Z]|FrameRate|VidCap|DisplayUnits|Voltage|Driver)", "Performance"),
    (r"^(LF|RF|LR|RR)Shock",                                              "Shock/Susp"),
    (r"^(LF|RF|LR|RR|FrontTire|RearTire|LeftTire|RightTire)",             "Tyres"),
    (r"^(Tire|WheelSpeed)",                                                "Tyres"),
    (r"^Brake",                                                            "Brakes"),
    (r"^(dc[A-Z]|PushTo|P2P)",                                            "Controls"),
    (r"^(Throttle|Clutch|Gear|Shift|RPM|Fuel|Oil|Mani|Water|Engine|Manual|Handbrake)", "Engine"),
    (r"^(Speed|Vel|Lat|Lon|Yaw|Pitch|Roll|Vert|Accel|Steer)",             "Motion"),
    (r"^(Air|Weather|Wind|Fog|Skies|Precip|Track|Solar|Relative)",        "Environment"),
    (r"^(Lap|BestLap|LapBest|LastLap)",                                   "Lap"),
    (r"^(Session|Race|Quali|RaceLaps|DCDriver|DCLap|Is[A-Z]|Ok[A-Z]|Enter|Load[A-Z]|OnPit)", "Session"),
    (r"^(Pit|dp[A-Z]|FastRepair|PaceMode)",                               "Pit"),
    (r"^(Cam|Radio|Replay|Broadcast)",                                     "System"),
    (r"^Player",                                                           "Car"),
    (r"^P\d+",                                                             "Results"),
]
_COMPILED = [(re.compile(pat), grp) for pat, grp in GROUP_RULES]
_FALLBACK  = re.compile(r"^([A-Z][a-z]{2,})(?=[A-Z0-9]|$)")

def get_group(name: str) -> str:
    for pattern, grp in _COMPILED:
        if pattern.search(name):
            return grp
    m = _FALLBACK.match(name)
    return m.group(1) if m else "Other"


TYPE_LABELS = {0: "char", 1: "bool", 2: "int", 3: "bitmask", 4: "float", 5: "double"}
SESSION_STATES = {0: "Invalid", 1: "GetInCar", 2: "Warmup", 3: "Parade", 4: "Racing", 5: "Checkered", 6: "Cooldown"}


# ── DB helpers ─────────────────────────────────────────────────────────────────

def open_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load_catalog(conn: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT name, var_type, unit, desc, count FROM catalog ORDER BY name"
    ).fetchall()]


def load_ticks(conn: sqlite3.Connection, limit: int | None, offset: int = 0) -> list[dict]:
    sql = "SELECT id, session_time, session_state, replay_frame, data_json FROM ticks ORDER BY id"
    if limit is not None:
        sql += f" LIMIT {limit} OFFSET {offset}"
    rows = conn.execute(sql).fetchall()
    result = []
    for r in rows:
        data = {}
        if r["data_json"]:
            try:
                data = json.loads(r["data_json"])
            except json.JSONDecodeError:
                pass
        result.append({
            "id":            r["id"],
            "session_time":  r["session_time"],
            "session_state": r["session_state"],
            "replay_frame":  r["replay_frame"],
            "data":          data,
        })
    return result


def get_var_stats(conn: sqlite3.Connection, var_name: str, limit: int = 5000) -> dict:
    """Compute min, max, mean, and unique count for a scalar variable."""
    rows = conn.execute(
        "SELECT data_json FROM ticks ORDER BY id LIMIT ?", (limit,)
    ).fetchall()

    values = []
    for r in rows:
        if not r["data_json"]:
            continue
        try:
            d = json.loads(r["data_json"])
        except json.JSONDecodeError:
            continue
        v = d.get(var_name)
        if v is None:
            continue
        if isinstance(v, list):
            values.extend(x for x in v if x is not None)
        elif isinstance(v, (int, float)):
            values.append(v)

    if not values:
        return {"count": 0, "unique": 0, "min": None, "max": None, "mean": None}

    unique = len(set(values))
    return {
        "count":  len(values),
        "unique": unique,
        "min":    min(values),
        "max":    max(values),
        "mean":   sum(values) / len(values),
    }


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_summary(conn: sqlite3.Connection, path: Path):
    """Print a summary of the collection file."""
    tick_count = conn.execute("SELECT COUNT(*) FROM ticks").fetchone()[0]
    cat_count  = conn.execute("SELECT COUNT(*) FROM catalog").fetchone()[0]
    info_rows  = conn.execute("SELECT key, value FROM info").fetchall()
    info       = {r["key"]: r["value"] for r in info_rows}

    size_bytes = path.stat().st_size
    size_str = f"{size_bytes / 1_048_576:.1f} MB" if size_bytes >= 1_048_576 else f"{size_bytes // 1024} KB"

    print()
    print(bold(cyan("━━━  Collection File Summary  ━━━")))
    print(f"  File     : {bold(path.name)}")
    print(f"  Size     : {size_str}")
    print(f"  Ticks    : {bold(str(tick_count)):>12}")
    print(f"  Variables: {bold(str(cat_count)):>12}")

    if info:
        print()
        print(bold("  Metadata:"))
        for k, v in info.items():
            print(f"    {k:<20} {v}")

    # Session state distribution
    states = conn.execute(
        "SELECT session_state, COUNT(*) as n FROM ticks GROUP BY session_state ORDER BY session_state"
    ).fetchall()
    if states:
        print()
        print(bold("  Session state distribution:"))
        for s in states:
            label = SESSION_STATES.get(s["session_state"], str(s["session_state"]))
            bar   = "█" * min(40, s["n"] * 40 // tick_count)
            print(f"    {label:<12} {s['n']:>6} ticks  {dim(bar)}")

    # Time range
    times = conn.execute("SELECT MIN(session_time), MAX(session_time) FROM ticks").fetchone()
    if times[0] is not None:
        dur = times[1] - times[0]
        print()
        print(bold("  Time range:"))
        print(f"    {times[0]:.1f}s → {times[1]:.1f}s  ({dur:.1f}s = {dur/60:.1f} min)")

    print()


def cmd_vars(conn: sqlite3.Connection, group_filter: str | None, sample_n: int = 2000):
    """Print variable catalog with per-var stats."""
    catalog = load_catalog(conn)
    if group_filter:
        catalog = [v for v in catalog if get_group(v["name"]).lower() == group_filter.lower()]

    # Group them
    groups: dict[str, list] = {}
    for v in catalog:
        g = get_group(v["name"])
        groups.setdefault(g, []).append(v)

    print()
    print(bold(cyan(f"━━━  Variable Catalog ({len(catalog)} vars)  ━━━")))

    for g_name, vars_list in sorted(groups.items()):
        print()
        print(f"  {bold(yellow(g_name))}  {dim(f'({len(vars_list)})')}")
        print(f"  {'Name':<28} {'Type':<8} {'Unit':<10} {'Count':>6}  Description")
        print(f"  {'─'*28} {'─'*8} {'─'*10} {'─'*6}  {'─'*30}")
        for v in sorted(vars_list, key=lambda x: x["name"]):
            typ   = TYPE_LABELS.get(v["var_type"], "?")
            unit  = v["unit"] or ""
            count = v["count"] or 1
            desc  = (v["desc"] or "")[:50]
            print(f"  {v['name']:<28} {typ:<8} {unit:<10} {count:>6}  {dim(desc)}")

    print()


def cmd_stats(conn: sqlite3.Connection, var_names: list[str], sample_n: int = 5000):
    """Print min/max/mean stats for specified variables."""
    print()
    print(bold(cyan("━━━  Variable Statistics  ━━━")))
    print(f"  (sampling up to {sample_n:,} ticks)")
    print()
    print(f"  {'Variable':<28} {'Min':>12} {'Max':>12} {'Mean':>12} {'Unique':>8} {'Samples':>8}")
    print(f"  {'─'*28} {'─'*12} {'─'*12} {'─'*12} {'─'*8} {'─'*8}")

    for name in var_names:
        s = get_var_stats(conn, name, sample_n)
        if s["count"] == 0:
            print(f"  {name:<28} {dim('  (no data)')}")
            continue

        def fmt(v): return f"{v:.4f}" if isinstance(v, float) and not float(v).is_integer() else str(v) if v is not None else "—"
        print(
            f"  {name:<28} {fmt(s['min']):>12} {fmt(s['max']):>12} {fmt(s['mean']):>12}"
            f" {s['unique']:>8} {s['count']:>8}"
        )
    print()


def cmd_session(conn: sqlite3.Connection):
    """Dump info/metadata tables."""
    print()
    print(bold(cyan("━━━  Session Metadata  ━━━")))

    for table in ("info", "metadata"):
        try:
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
            if rows:
                print(f"\n  [{bold(table)}]")
                for r in rows:
                    k, v = r[0], r[1]
                    # Try to pretty-print JSON
                    try:
                        parsed = json.loads(v)
                        v = json.dumps(parsed, indent=4)
                        for i, line in enumerate(v.splitlines()):
                            if i == 0:
                                print(f"  {k:<30} {line}")
                            else:
                                print(f"  {'':30} {line}")
                    except (json.JSONDecodeError, TypeError):
                        print(f"  {k:<30} {v}")
        except sqlite3.OperationalError:
            pass
    print()


def cmd_sample(conn: sqlite3.Connection, sample_n: int, offset: int):
    """Show the first N ticks in a human-readable table."""
    ticks = load_ticks(conn, limit=sample_n, offset=offset)
    tick_count = conn.execute("SELECT COUNT(*) FROM ticks").fetchone()[0]

    print()
    print(bold(cyan(f"━━━  Tick Sample [{offset}–{offset+len(ticks)-1} of {tick_count:,}]  ━━━")))
    print()

    # Detect interesting vars (not always 0/null in this sample)
    all_keys: set[str] = set()
    for t in ticks:
        all_keys.update(t["data"].keys())

    interesting: list[str] = []
    for k in sorted(all_keys):
        vals = [t["data"].get(k) for t in ticks if k in t["data"]]
        scalars = [v for v in vals if isinstance(v, (int, float))]
        if scalars and (max(scalars) - min(scalars)) > 0.001:
            interesting.append(k)
        elif any(v is not None and v != 0 and v != [] and v != "" for v in vals):
            interesting.append(k)

    # Show up to 8 most interesting
    show_vars = interesting[:8]
    if not show_vars:
        show_vars = sorted(all_keys)[:8]

    header = f"  {'#':>6}  {'Time(s)':>9}  {'State':<12}  {'Frame':>7}"
    for v in show_vars:
        header += f"  {v[:14]:<14}"
    print(header)
    print("  " + "─" * (len(header) - 2))

    for t in ticks:
        state_label = SESSION_STATES.get(t["session_state"], str(t["session_state"]))
        row = f"  {t['id']:>6}  {t['session_time']:>9.3f}  {state_label:<12}  {t['replay_frame']:>7}"
        for v in show_vars:
            val = t["data"].get(v)
            if val is None:
                cell = "—"
            elif isinstance(val, list):
                cell = f"[{len(val)}]"
            elif isinstance(val, float):
                cell = f"{val:.3f}" if abs(val) < 10000 else f"{val:.0f}"
            else:
                cell = str(val)
            row += f"  {cell[:14]:<14}"
        print(row)

    print()
    if show_vars:
        print(f"  {dim('Showing vars:')} {', '.join(show_vars)}")
        if len(interesting) > 8:
            print(f"  {dim(f'({len(interesting)-8} more interesting vars not shown — use --vars to list all)')}")
    print()


def cmd_plot(conn: sqlite3.Connection, var_names: list[str], sample_n: int):
    """Plot variables over session_time using matplotlib."""
    try:
        import matplotlib.pyplot as plt
        import matplotlib.ticker as mticker
    except ImportError:
        sys.exit("[error] matplotlib not installed. Run: pip install matplotlib")

    ticks = load_ticks(conn, limit=sample_n)
    times = [t["session_time"] for t in ticks]

    # Determine subplot layout
    n = len(var_names)
    cols = min(n, 2)
    rows = (n + cols - 1) // cols

    fig, axes = plt.subplots(rows, cols, figsize=(14, 3.5 * rows), sharex=True, squeeze=False)
    _sn_row = conn.execute("SELECT value FROM info WHERE key='session_name'").fetchone()
    _sn = _sn_row[0] if _sn_row else ""
    fig.suptitle(f"Telemetry — {_sn}", fontsize=13)
    fig.patch.set_facecolor("#0e0e14")

    ax_flat = [axes[r][c] for r in range(rows) for c in range(cols)]

    for i, var_name in enumerate(var_names):
        ax = ax_flat[i]
        ax.set_facecolor("#0e0e14")
        ax.tick_params(colors="#888", labelsize=8)
        for spine in ax.spines.values():
            spine.set_color("#333")

        values = []
        t_vals = []
        for j, t in enumerate(ticks):
            v = t["data"].get(var_name)
            if v is None:
                continue
            if isinstance(v, list):
                # For array vars, plot[0] (usually player car) and mean
                scalars = [x for x in v if isinstance(x, (int, float))]
                if scalars:
                    v = scalars[0]
                else:
                    continue
            if isinstance(v, (int, float)):
                values.append(v)
                t_vals.append(t["session_time"])

        if values:
            ax.plot(t_vals, values, linewidth=0.8, color="#22d3ee", alpha=0.85)
            ax.set_ylabel(var_name, color="#aaa", fontsize=8)
        else:
            ax.text(0.5, 0.5, f"No numeric data for\n{var_name}",
                    transform=ax.transAxes, ha="center", va="center", color="#666", fontsize=9)

        # Shade session states
        if i == 0:
            prev_state, prev_t = None, times[0]
            state_colors = {4: "#22d3ee", 5: "#4ade80", 2: "#facc15", 3: "#fb923c"}
            for t in ticks:
                if t["session_state"] != prev_state:
                    if prev_state in state_colors and t_vals:
                        ax.axvspan(prev_t, t["session_time"], alpha=0.04,
                                   color=state_colors[prev_state], lw=0)
                    prev_state, prev_t = t["session_state"], t["session_time"]

    # Hide unused axes
    for j in range(i + 1, len(ax_flat)):
        ax_flat[j].set_visible(False)

    ax_flat[-1 if i == len(ax_flat) - 1 else (rows - 1) * cols].set_xlabel("Session Time (s)", color="#aaa", fontsize=8)
    plt.tight_layout()
    plt.show()


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Inspect LRS telemetry collection .db files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("db", nargs="?", help="Path to .db file (default: latest in data/collections/)")
    parser.add_argument("-p", "--plot",  nargs="+", metavar="VAR", help="Plot variables over time")
    parser.add_argument("-g", "--group", metavar="GROUP",           help="Show only vars in GROUP")
    parser.add_argument("-v", "--vars",  action="store_true",       help="Print full variable catalog")
    parser.add_argument("-s", "--session", action="store_true",     help="Print session metadata")
    parser.add_argument("-t", "--stats",  nargs="+", metavar="VAR", help="Print stats for VAR(s)")
    parser.add_argument("-n", "--sample-n", type=int, default=50,   metavar="N",  help="Number of ticks to show in sample table (default: 50)")
    parser.add_argument("-o", "--offset",   type=int, default=0,    metavar="N",  help="Tick offset for sample (default: 0)")
    parser.add_argument("--no-sample",  action="store_true",        help="Skip the sample tick table")
    args = parser.parse_args()

    db_path = resolve_db(args.db)
    print(f"\n{cyan('Opening:')} {db_path}")

    conn = open_db(db_path)

    cmd_summary(conn, db_path)

    if args.session:
        cmd_session(conn)

    if args.vars or args.group:
        cmd_vars(conn, args.group)

    if args.stats:
        cmd_stats(conn, args.stats)

    if not args.no_sample and not args.plot:
        cmd_sample(conn, args.sample_n, args.offset)

    if args.plot:
        cmd_plot(conn, args.plot, sample_n=5000)

    conn.close()


if __name__ == "__main__":
    main()
