"""Buy or Wait? - entry point.

Usage (from the repository root):
    python code/main.py                       # dataset/requests.csv -> output.csv
    python code/main.py --requests dataset/sample_requests.csv --out samples_output.csv
    python code/main.py --llm off             # fully offline deterministic run

Secrets are read from the environment only (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY).
A `.env` file next to this repo is loaded if python-dotenv is installed.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

try:  # optional
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(ROOT / ".env")
except Exception:
    pass

from buyorwait.data import load_dataset, Request  # noqa: E402
from buyorwait.evidence import ImageReader, MessageParser  # noqa: E402
from buyorwait.forecast import Forecaster  # noqa: E402
from buyorwait.llm import LLM  # noqa: E402
from buyorwait.planner import Planner  # noqa: E402
from buyorwait.verify import verify_row  # noqa: E402

COLUMNS = ["request_id", "amount_safe_to_pay", "affordability_status", "recommended_payment_method",
           "payment_plan", "earliest_date_for_full_payment", "spending_changes_needed", "decision_explanation"]


def build_agent(dataset_dir: Path, llm_mode: str | None = None, knobs: dict | None = None):
    ds = load_dataset(dataset_dir)
    cache_dir = HERE / "cache"
    llm = LLM(mode=llm_mode, cache_path=cache_dir / "llm_cache.json")
    images = ImageReader(ds, llm, cache_dir)
    messages = MessageParser(llm)
    fc = Forecaster(ds, images, messages, knobs)
    planner = Planner(ds)
    return ds, llm, fc, planner


def run(requests: list[Request], fc: Forecaster, planner: Planner, ds, verbose: bool = False):
    rows, debug = [], []
    for req in requests:
        forecast = fc.build(req)
        dec = planner.decide(forecast)
        row = dec.row()
        problems = verify_row(row, req, ds)
        if problems:
            # deterministic guard-rails: never emit an invalid row
            row = repair(row, req, problems)
        rows.append(row)
        debug.append({"request_id": req.request_id, "notes": forecast.notes, "debug": dec.debug,
                      "adjustments": [a.kind for a in forecast.adjustments], "problems": problems})
        if verbose:
            print(f"{req.request_id}: {row['affordability_status']:20s} {row['recommended_payment_method']:16s} "
                  f"safe={row['amount_safe_to_pay']:>14s} earliest={row['earliest_date_for_full_payment']}")
    return rows, debug


def repair(row: dict, req: Request, problems: list[str]) -> dict:
    """Last-resort fixes so the schema contract always holds."""
    try:
        v = float(row["amount_safe_to_pay"])
    except ValueError:
        v = 0.0
    v = max(0.0, min(req.amount, v))
    row["amount_safe_to_pay"] = ("%.2f" % v).rstrip("0").rstrip(".") if v != int(v) else str(int(v))
    if row["affordability_status"] == "affordable_now":
        row["earliest_date_for_full_payment"] = req.request_date.isoformat()
    if row["recommended_payment_method"] == "not_recommended":
        row["payment_plan"] = "none"
        row["spending_changes_needed"] = "none"
    return row


def write_csv(rows: list[dict], out: Path):
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in COLUMNS})


def main(argv=None):
    ap = argparse.ArgumentParser(description="Buy or Wait? affordability agent")
    ap.add_argument("--dataset", default=str(ROOT / "dataset"))
    ap.add_argument("--requests", default=None, help="requests CSV (default: <dataset>/requests.csv)")
    ap.add_argument("--out", default=str(ROOT / "output.csv"))
    ap.add_argument("--llm", default=None, choices=[None, "off", "auto", "on"], help="override BUYORWAIT_LLM")
    ap.add_argument("--debug-json", default=None, help="write per-request forecast notes to this JSON file")
    ap.add_argument("--usage-json", default=None, help="write raw LLM usage to this JSON file")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    t0 = time.time()
    ds, llm, fc, planner = build_agent(Path(args.dataset), args.llm)
    if args.requests:
        from buyorwait.data import _parse_requests, _read
        requests = _parse_requests(_read(Path(args.requests)))
    else:
        requests = ds.requests
    print(f"[buyorwait] {len(requests)} requests | LLM: {llm.provider or 'off'}"
          f"{(' (' + llm.model + ')') if llm.available else ''}")
    rows, debug = run(requests, fc, planner, ds, verbose=args.verbose)
    write_csv(rows, Path(args.out))
    print(f"[buyorwait] wrote {args.out} ({len(rows)} rows) in {time.time() - t0:.1f}s")
    if args.debug_json:
        Path(args.debug_json).write_text(json.dumps(debug, indent=1, default=str), encoding="utf-8")
    usage = llm.usage.summary()
    usage["n_requests"] = len(requests)
    usage["seconds"] = round(time.time() - t0, 1)
    up = Path(args.usage_json) if args.usage_json else HERE / "cache" / "last_run_usage.json"
    up.parent.mkdir(parents=True, exist_ok=True)
    up.write_text(json.dumps(usage, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
