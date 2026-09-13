"""Deterministic contract checks for one output row (used before writing output.csv)."""
from __future__ import annotations

from datetime import datetime

from .data import Request

STATUSES = {"affordable_now", "affordable_with_plan", "affordable_later", "not_affordable"}
METHODS = {"full_payment", "partial_payment", "installments", "wait", "not_recommended"}


def _parse_plan(plan: str):
    if plan == "none":
        return []
    out = []
    for tok in plan.split("|"):
        d, a = tok.split(":")
        out.append((datetime.strptime(d, "%Y-%m-%d").date(), float(a)))
    return out


def verify_row(row: dict, req: Request, ds=None) -> list[str]:
    p: list[str] = []
    try:
        safe = float(row["amount_safe_to_pay"])
        if not (-1e-6 <= safe <= req.amount + 1e-6):
            p.append("amount_safe_to_pay out of bounds")
    except ValueError:
        p.append("amount_safe_to_pay not numeric")
        safe = 0.0
    st, me = row["affordability_status"], row["recommended_payment_method"]
    if st not in STATUSES:
        p.append("bad status")
    if me not in METHODS:
        p.append("bad method")
    try:
        plan = _parse_plan(row["payment_plan"])
    except Exception:
        p.append("unparsable plan")
        plan = []
    if plan != sorted(plan, key=lambda x: x[0]):
        p.append("plan not chronological")
    ed = row["earliest_date_for_full_payment"]
    if st == "affordable_now" and ed != req.request_date.isoformat():
        p.append("affordable_now requires earliest == request_date")
    if me == "partial_payment":
        if st != "affordable_with_plan" or len(plan) != 2:
            p.append("partial_payment shape")
        elif abs(plan[0][1] + plan[1][1] - req.amount) > 0.011 or abs(plan[0][1] - safe) > 0.011 \
                or plan[1][0].isoformat() != ed or plan[1][0] > req.deadline or not req.allows_partial:
            p.append("partial_payment rules")
    if me == "installments" and ds is not None:
        opts = [o for o in ds.options_by_request.get(req.request_id, []) if o.method == "installments"]
        ok = any(len(o.schedule()) == len(plan) and all(d1 == d2 and abs(a1 - a2) < 0.011
                 for (d1, a1), (d2, a2) in zip(o.schedule(), plan)) for o in opts)
        if not ok:
            p.append("installments do not match a supplied option")
    if me == "not_recommended" and (row["payment_plan"] != "none" or st != "not_affordable"):
        p.append("not_recommended shape")
    if me in ("full_payment", "wait") and len(plan) != 1:
        p.append("single payment expected")
    sc = row["spending_changes_needed"]
    if sc != "none":
        toks = sc.split("|")
        if len(toks) > 3:
            p.append("too many spending changes")
        ids = []
        for t in toks:
            parts = t.split(":")
            if parts[0] not in ("stop", "reduce_to") or (parts[0] == "stop" and len(parts) != 2) \
                    or (parts[0] == "reduce_to" and len(parts) != 3):
                p.append("bad spending change token")
                continue
            ids.append(parts[1])
            if ds is not None:
                ev = ds.events_by_id.get(parts[1])
                if ev is None or ev.flexibility == "fixed":
                    p.append("spending change targets non-flexible event")
        if len(set(ids)) != len(ids):
            p.append("same event stopped and reduced")
    return p
