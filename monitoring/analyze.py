#!/usr/bin/env python3
"""Compares the experiment runs in monitoring/runs and writes tables and charts.

Usage: python3 monitoring/analyze.py [run names in display order]
Output: monitoring/report/comparison.csv, comparison.md and charts/*.png
Charts need matplotlib. The tables need only Python.
"""
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
REPORT = ROOT / "report"
SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
INK = "#1d2433"
MUTED = "#5d6677"
GRID = "#e6e8ec"

COLUMNS = [
    ("run", "Run"), ("change", "Change applied"), ("resourceActions", "CloudFormation result"),
    ("instancesReplaced", "Instances replaced"), ("databaseReplaced", "Database replaced"),
    ("stackUpdateSeconds", "Update time (s)"), ("appFailedChecks", "Failed app checks"),
    ("databaseFailedChecks", "Failed DB checks"), ("requestsPerSecond", "Requests/s"),
    ("p50Ms", "p50 (ms)"), ("p95Ms", "p95 (ms)"), ("p99Ms", "p99 (ms)"), ("failurePercent", "Failed requests (%)"),
    ("webCpuAvg", "Web CPU avg (%)"), ("webCpuPeak", "Web CPU peak (%)"), ("instancesPeak", "Peak instances"),
    ("dbCpuAvg", "DB CPU avg (%)"), ("dbConnectionsPeak", "Peak DB connections"),
]


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def read_metrics(run_dir):
    path = run_dir / "metrics.csv"
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row["_time"] = parse_time(row["time"])
    return rows


def values(rows, field):
    return [float(row[field]) for row in rows if row.get(field) not in (None, "")]


def average(items):
    return round(sum(items) / len(items), 1) if items else ""


def peak(items):
    return round(max(items), 1) if items else ""


def load_window(rows, summary):
    if "loadStartedAt" not in summary:
        return rows
    start = parse_time(summary["loadStartedAt"]).replace(second=0, microsecond=0)
    end = parse_time(summary["loadEndedAt"])
    return [row for row in rows if start <= row["_time"] <= end]


def describe_actions(summary):
    changes = summary.get("resourceChanges") or []
    if not changes:
        return ""
    parts = []
    for change in changes:
        replacement = change.get("replacement")
        detail = {"True": "replace", "Conditional": "may replace", "False": "in place"}.get(replacement, change["action"].lower())
        parts.append(f"{change['resource']}: {detail}")
    return "; ".join(parts)


def summarise_run(run_dir):
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    metrics = load_window(read_metrics(run_dir), summary)
    load = summary.get("load", {})
    observed = summary.get("observedChange", {})
    settings = summary.get("settings") or {}
    change = ", ".join(f"{key}={value}" for key, value in settings.items())
    if summary.get("kind") == "baseline":
        change = "None (baseline)"
    if summary.get("kind") == "failure":
        change = "One instance terminated"
    if summary.get("kind") == "operation":
        change = "Application release" if "release.sh" in " ".join(summary.get("command", [])) else " ".join(summary.get("command", []))
    if summary.get("kind") == "preview":
        change = f"{change} (preview only)"
    return {
        "run": run_dir.name,
        "change": change,
        "resourceActions": describe_actions(summary),
        "instancesReplaced": observed.get("instancesRemoved", ""),
        "databaseReplaced": observed.get("databaseReplaced", ""),
        "stackUpdateSeconds": summary.get("stackUpdateSeconds", ""),
        "appFailedChecks": summary.get("appFailedChecks", ""),
        "databaseFailedChecks": summary.get("databaseFailedChecks", ""),
        "requestsPerSecond": load.get("requestsPerSecond", ""),
        "p50Ms": load.get("p50Ms", ""),
        "p95Ms": load.get("p95Ms", ""),
        "p99Ms": load.get("p99Ms", ""),
        "failurePercent": load.get("failurePercent", ""),
        "webCpuAvg": average(values(metrics, "web_cpu_percent")),
        "webCpuPeak": peak(values(metrics, "web_cpu_max_percent")),
        "instancesPeak": peak(values(metrics, "instances_in_service")),
        "dbCpuAvg": average(values(metrics, "db_cpu_percent")),
        "dbConnectionsPeak": peak(values(metrics, "db_connections")),
    }


def write_tables(rows):
    REPORT.mkdir(parents=True, exist_ok=True)
    with (REPORT / "comparison.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([label for _, label in COLUMNS])
        writer.writerows([[row[key] for key, _ in COLUMNS] for row in rows])
    lines = ["| " + " | ".join(label for _, label in COLUMNS) + " |", "|" + " --- |" * len(COLUMNS)]
    for row in rows:
        cells = [str(row[key]).replace("|", "/") for key, _ in COLUMNS]
        lines.append("| " + " | ".join(cells) + " |")
    (REPORT / "comparison.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def style_axis(axis, title, unit):
    axis.set_title(title, loc="left", color=INK, fontsize=12, fontweight="bold", pad=12)
    axis.set_ylabel(unit, color=MUTED, fontsize=9)
    axis.tick_params(colors=MUTED, labelsize=9, length=0)
    axis.grid(axis="y", color=GRID, linewidth=0.8)
    axis.set_axisbelow(True)
    for side in ("top", "right", "left"):
        axis.spines[side].set_visible(False)
    axis.spines["bottom"].set_color(GRID)


def timeline_chart(plt, run_dirs, field, title, unit, filename, scale=1.0):
    figure, axis = plt.subplots(figsize=(9, 4.2), dpi=160)
    drawn = 0
    for index, run_dir in enumerate(run_dirs[: len(SERIES_COLORS)]):
        summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
        rows = load_window(read_metrics(run_dir), summary)
        points = [(row["_time"], float(row[field]) * scale) for row in rows if row.get(field) not in (None, "")]
        if not points:
            continue
        start = points[0][0]
        axis.plot([(moment - start).total_seconds() / 60 for moment, _ in points], [value for _, value in points],
                  color=SERIES_COLORS[index], linewidth=2, label=run_dir.name)
        drawn += 1
    if drawn:
        style_axis(axis, title, unit)
        axis.set_xlabel("Minutes since the load test started", color=MUTED, fontsize=9)
        axis.set_ylim(bottom=0)
        axis.legend(frameon=False, fontsize=9, loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=4, labelcolor=INK)
        figure.tight_layout()
        figure.savefig(REPORT / "charts" / filename, facecolor="white")
    plt.close(figure)


def p95_chart(plt, rows):
    measured = [row for row in rows if row["p95Ms"] != ""]
    if not measured:
        return
    figure, axis = plt.subplots(figsize=(9, 0.55 * len(measured) + 1.3), dpi=160)
    names = [row["run"] for row in reversed(measured)]
    latencies = [float(row["p95Ms"]) for row in reversed(measured)]
    bars = axis.barh(names, latencies, color=SERIES_COLORS[0], height=0.55)
    axis.bar_label(bars, labels=[f"{value:,.0f} ms" for value in latencies], padding=4, color=INK, fontsize=9)
    style_axis(axis, "95th percentile response time by run", "")
    axis.grid(False)
    axis.xaxis.set_visible(False)
    axis.spines["bottom"].set_visible(False)
    axis.set_xlim(0, max(latencies) * 1.18)
    figure.tight_layout()
    figure.savefig(REPORT / "charts" / "p95_by_run.png", facecolor="white")
    plt.close(figure)


def write_charts(run_dirs, rows):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib is not installed, so charts were skipped")
        return
    (REPORT / "charts").mkdir(parents=True, exist_ok=True)
    p95_chart(plt, rows)
    timeline_chart(plt, run_dirs, "web_cpu_percent", "Web tier CPU during the load test", "Percent", "web_cpu.png")
    timeline_chart(plt, run_dirs, "response_p95_seconds", "95th percentile response time during the load test", "Milliseconds", "response_p95.png", 1000)
    timeline_chart(plt, run_dirs, "instances_in_service", "Instances in service during the load test", "Instances", "instances.png")
    timeline_chart(plt, run_dirs, "db_cpu_percent", "Database CPU during the load test", "Percent", "database_cpu.png")


def main():
    if sys.argv[1:]:
        run_dirs = [RUNS / name for name in sys.argv[1:]]
    else:
        run_dirs = sorted(path for path in RUNS.iterdir() if path.is_dir() and not path.name.startswith("_")) if RUNS.exists() else []
    run_dirs = [path for path in run_dirs if (path / "summary.json").exists()]
    if not run_dirs:
        print("No completed runs were found in monitoring/runs")
        return 1
    rows = [summarise_run(path) for path in run_dirs]
    write_tables(rows)
    write_charts([path for path in run_dirs if (path / "metrics.csv").exists()], rows)
    print(f"Compared {len(rows)} runs. See {REPORT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
