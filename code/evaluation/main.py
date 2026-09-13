"""Evaluation workflow.

    python code/evaluation/main.py                 # score the agent on dataset/sample_requests.csv
    python code/evaluation/main.py --tune          # grid-search forecaster knobs on the samples
    python code/evaluation/main.py --validate output.csv   # contract checks on a produced output
    python code/evaluation/main.py --usage-report  # regenerate evaluation/usage_report.md from the last run

Scoring mirrors the published criteria: amount_safe_to_pay accuracy, status, method+plan,
earliest date, spending-change validity, explanation consistency.
"""
from __future__ import annotations

import argparse
import csv
import itertools
import json
import sys
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CODE = HERE.parent
ROOT = CODE.parent
sys.path.insert(0, str(CODE))

from main import build_agent, run, COLUMNS  # noqa: E402
from buyorwait.verify import verify_row  # noqa: E402


def _rel(a: float, b: float) -> float:
    return abs(a - b) / max(abs(b), 1.0)


def score(rows: list[dict], samples, verbose=True) -> dict:
    by_id = {r["request_id"]: r for r in rows}
    tot = {"n": 0, "safe_exact": 0, "safe_close": 0, "status": 0, "method": 0, "plan": 0, "earliest": 0, "changes": 0,
           "safe_mae_rel": 0.0}
    lines = []
    for s in samples:
        r = by_id.get(s.request_id)
        if not r:
            continue
        e = s.expected
        tot["n"] += 1
        safe_e = float(e["amount_safe_to_pay"])
        safe_p = float(r["amount_safe_to_pay"])
        rel = _rel(safe_p, safe_e)
        tot["safe_mae_rel"] += rel
        tot["safe_exact"] += rel < 0.005
        tot["safe_close"] += rel < 0.05
        tot["status"] += r["affordability_status"] == e["affordability_status"]
        tot["method"] += r["recommended_payment_method"] == e["recommended_payment_method"]
        tot["plan"] += r["payment_plan"] == e["payment_plan"]
        tot["earliest"] += (r["earliest_date_for_full_payment"] or "") == (e["earliest_date_for_full_payment"] or "")
        tot["changes"] += r["spending_changes_needed"] == e["spending_changes_needed"]
        flag = "" if (r["affordability_status"] == e["affordability_status"] and rel < 0.01
                      and r["payment_plan"] == e["payment_plan"]) else "  <-- "
        lines.append(f"{s.request_id:11s} safe {safe_p:>14.2f} vs {safe_e:>14.2f} ({rel*100:5.1f}%) | "
                     f"{r['affordability_status']:19s}/{e['affordability_status']:19s} | "
                     f"{r['recommended_payment_method']:15s}/{e['recommended_payment_method']:15s} | "
                     f"earliest {r['earliest_date_for_full_payment'] or '-':10s}/{e['earliest_date_for_full_payment'] or '-':10s} | "
                     f"chg {r['spending_changes_needed']}/{e['spending_changes_needed']}{flag}")
    n = max(tot["n"], 1)
    tot["safe_mae_rel"] = round(tot["safe_mae_rel"] / n, 4)
    if verbose:
        print("\n".join(lines))
        print(f"\nn={tot['n']}  safe exact={tot['safe_exact']} close(<5%)={tot['safe_close']} mean rel err={tot['safe_mae_rel']:.3f} | "
              f"status={tot['status']} method={tot['method']} plan={tot['plan']} earliest={tot['earliest']} changes={tot['changes']}")
    return tot


def composite(t: dict) -> float:
    n = max(t["n"], 1)
    return (t["status"] + t["method"] + t["plan"] + t["earliest"] + t["changes"] + 2 * t["safe_close"] + t["safe_exact"]) / n \
        - t["safe_mae_rel"]


def tune(dataset: Path):
    grid = {
        "amount_stat": ["mean", "median", "mean3", "last", "max", "min"],
        "include_same_day": [False, True],
        "horizon": [90, 89],
        "reserve_failed": [False, True],
        "project_weekly_income": [False, True],
        "stale_periods": [1.6, 2.5],
    }
    keys = list(grid)
    best = None
    ds, llm, fc, planner = build_agent(dataset, "off")
    for vals in itertools.product(*(grid[k] for k in keys)):
        knobs = dict(zip(keys, vals))
        fc.k.update(knobs)
        rows, _ = run(ds.sample_requests, fc, planner, ds)
        t = score(rows, ds.sample_requests, verbose=False)
        c = composite(t)
        print(f"{knobs} -> {c:.3f} | status={t['status']} plan={t['plan']} earliest={t['earliest']} safe_close={t['safe_close']} rel={t['safe_mae_rel']}")
        if best is None or c > best[0]:
            best = (c, knobs, t)
    print("\nBEST", best)


def validate(path: Path, dataset: Path):
    ds, *_ = build_agent(dataset, "off")
    with open(path, newline="", encoding="utf-8") as f:
        rd = csv.DictReader(f)
        rows = list(rd)
        cols = rd.fieldnames
    ok = True
    if cols != COLUMNS:
        print("!! header mismatch", cols)
        ok = False
    ids = [r["request_id"] for r in rows]
    want = [r.request_id for r in ds.requests]
    if ids != want:
        print(f"!! request ids differ: {len(ids)} rows vs {len(want)} requests; missing={set(want)-set(ids)}")
        ok = False
    by_id = {r.request_id: r for r in ds.requests}
    for r in rows:
        req = by_id.get(r["request_id"])
        if not req:
            continue
        p = verify_row(r, req, ds)
        if p:
            ok = False
            print(r["request_id"], p)
    print("VALID" if ok else "INVALID", f"({len(rows)} rows)")
    return ok


def usage_report(usage_path: Path, out: Path, output_csv: Path):
    u = json.loads(usage_path.read_text(encoding="utf-8")) if usage_path.exists() else {"per_model": {}, "total": {}}
    n = u.get("n_requests") or 0
    tot = u.get("total", {})
    calls = tot.get("calls", 0)
    it, ot = tot.get("input_tokens", 0), tot.get("output_tokens", 0)
    cost = tot.get("cost_usd", 0.0)
    lines = [
        "# Token usage and cost report", "",
        f"Final full-dataset run that produced `{output_csv.name}` "
        f"({n} requests, {u.get('seconds', 0)} s wall-clock, generated {datetime.now():%Y-%m-%d %H:%M}).", "",
        "## Architecture summary", "",
        "The decision engine (financial-state reconstruction, 90-day forecast, plan ranking, verification) is "
        "deterministic Python and makes **no model calls**. Models are used only for untrusted evidence:", "",
        "* **Image amounts** (events with a blank `amount`): a vision-language model when an API key is configured, "
        "otherwise the bundled offline OCR (`rapidocr_onnxruntime`, ONNX, no network) plus a keyword heuristic.",
        "* **Message interpretation**: rule-based template parser (English + Indonesian); an LLM is consulted only "
        "for messages the rules cannot classify.",
        "* **Explanations**: deterministic templates grounded in the computed numbers.", "",
        "## Model calls in this run", "",
        "| Provider | Model | Calls | Input tokens | Output tokens | Total tokens | Est. cost (USD) |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    if not u.get("per_model"):
        lines.append("| (none - offline OCR + rules) | - | 0 | 0 | 0 | 0 | 0.00 |")
    for k, m in u.get("per_model", {}).items():
        lines.append(f"| {m['provider']} | {m['model']} | {m['calls']} | {m['input_tokens']} | {m['output_tokens']} | "
                     f"{m['input_tokens'] + m['output_tokens']} | {m['cost_usd']:.4f} |")
    lines += [
        f"| **Overall** | | **{calls}** | **{it}** | **{ot}** | **{it + ot}** | **{cost:.4f}** |", "",
        "## Per-request averages", "",
        f"* Requests processed: **{n}**",
        f"* Model calls per request: **{(calls / n) if n else 0:.3f}**",
        f"* Average tokens per request: **{((it + ot) / n) if n else 0:.1f}** "
        f"(input {(it / n) if n else 0:.1f}, output {(ot / n) if n else 0:.1f})",
        f"* Estimated cost per request: **USD {(cost / n) if n else 0:.6f}**",
        f"* Estimated total cost: **USD {cost:.4f}**", "",
        "## Notes", "",
        "* Token counts come from the provider usage fields of each response; cached responses (from "
        "`code/cache/`) are listed as calls with zero tokens.",
        "* Prices are list prices per 1M tokens at the time of writing and are approximate.",
        "* No API keys, credentials or sensitive configuration values are included in this package.",
    ]
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out}")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(ROOT / "dataset"))
    ap.add_argument("--tune", action="store_true")
    ap.add_argument("--validate", default=None)
    ap.add_argument("--usage-report", action="store_true")
    ap.add_argument("--llm", default="off")
    args = ap.parse_args(argv)
    dataset = Path(args.dataset)
    if args.tune:
        return tune(dataset)
    if args.validate:
        return 0 if validate(Path(args.validate), dataset) else 1
    if args.usage_report:
        usage_report(CODE / "cache" / "last_run_usage.json", HERE / "usage_report.md", ROOT / "output.csv")
        return 0
    ds, llm, fc, planner = build_agent(dataset, args.llm)
    rows, debug = run(ds.sample_requests, fc, planner, ds)
    score(rows, ds.sample_requests)
    (CODE / "cache").mkdir(exist_ok=True)
    (CODE / "cache" / "sample_debug.json").write_text(json.dumps(debug, indent=1, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
