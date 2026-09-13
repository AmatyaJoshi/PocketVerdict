"""JSON bridge used by the web app.

    echo '{"request_id": "request_26"}' | python code/serve.py
    echo '{"user_id": "user_26", "request_date": "2025-08-03", "requested_amount": 1000000,
          "desired_completion_date": "2025-10-07", "allows_partial_payment": true,
          "request_type": "purchase", "request_text": "Can I ..."}' | python code/serve.py

Reads one request (an existing request_id, or ad-hoc fields) from stdin and prints the decision
together with the forecast that produced it (daily balance path, flows, notes, evidence).
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from main import build_agent, ROOT  # noqa: E402
from buyorwait.data import Request  # noqa: E402
from buyorwait.verify import verify_row  # noqa: E402


def _d(s: str) -> date:
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def main() -> int:
    payload = json.loads(sys.stdin.read() or "{}")
    dataset = Path(payload.get("dataset") or (ROOT / "dataset"))
    ds, llm, fc, planner = build_agent(dataset, payload.get("llm") or "auto")
    req = None
    if payload.get("request_id") and not payload.get("user_id"):
        req = next((r for r in ds.requests + ds.sample_requests if r.request_id == payload["request_id"]), None)
        if req is None:
            print(json.dumps({"error": f"unknown request_id {payload['request_id']}"}))
            return 1
    else:
        req = Request(
            request_id=payload.get("request_id") or "adhoc",
            user_id=payload["user_id"], request_date=_d(payload["request_date"]),
            request_type=payload.get("request_type") or "other", amount=float(payload["requested_amount"]),
            deadline=_d(payload["desired_completion_date"]),
            allows_partial=bool(payload.get("allows_partial_payment", False)),
            text=payload.get("request_text") or "")
        if req.user_id not in ds.profiles:
            print(json.dumps({"error": f"unknown user_id {req.user_id}"}))
            return 1
    forecast = fc.build(req)
    dec = planner.decide(forecast)
    row = dec.row()
    problems = verify_row(row, req, ds)
    path = forecast.path()
    prof = forecast.profile
    out = {
        "request": {"request_id": req.request_id, "user_id": req.user_id, "request_date": req.request_date.isoformat(),
                    "request_type": req.request_type, "requested_amount": req.amount,
                    "desired_completion_date": req.deadline.isoformat(), "allows_partial_payment": req.allows_partial,
                    "request_text": req.text},
        "profile": {"home_currency": prof.home_currency, "balance": prof.balance, "min_balance": prof.min_balance,
                    "methods": prof.methods, "max_installment_months": prof.max_installment_months,
                    "protect": prof.protect, "reduce_ok": prof.reduce_ok, "stop_ok": prof.stop_ok,
                    "priorities": prof.priorities},
        "decision": row,
        "problems": problems,
        "forecast": {
            "start": forecast.start.isoformat(), "end": forecast.end.isoformat(),
            "path": [{"date": d.isoformat(), "balance": round(b, 2)} for d, b in path],
            "flows": [{"date": f.day.isoformat(), "amount": round(f.amount, 2), "kind": f.kind, "label": f.label}
                      for f in sorted(forecast.flows, key=lambda f: (f.day, f.label))],
            "series": [{"key": s.key, "category": s.category, "flexibility": s.flexibility, "amount": round(s.amount, 2),
                        "period_days": s.period_days, "day_of_month": s.dom, "occurrences": len(s.occurrences),
                        "last_event_id": s.last_event.event_id, "label": s.label}
                       for s in forecast.series.values()],
            "notes": forecast.notes,
            "adjustments": [{"kind": a.kind, "amount": a.amount, "currency": a.currency,
                             "date": a.date.isoformat() if a.date else None, "pct": a.pct, "message_id": a.message_id}
                            for a in forecast.adjustments],
        },
        "payment_options": [{"payment_option_id": o.option_id, "payment_method": o.method, "payment_amount": o.payment_amount,
                             "number_of_payments": o.n_payments, "first_payment_date": o.first_date.isoformat(),
                             "payment_frequency_days": o.frequency_days, "financing_fee": o.fee,
                             "total_payable_amount": o.total} for o in ds.options_by_request.get(req.request_id, [])],
        "messages": [{"message_id": m.message_id, "sent_at": m.sent_at.isoformat(), "source_type": m.source_type,
                      "related_event_id": m.related_event_id, "text": m.text}
                     for m in ds.messages_by_user.get(req.user_id, []) if not m.request_id or m.request_id == req.request_id],
        "images": [{"image_id": i.image_id, "related_event_id": i.related_event_id, "path": f"/media/images/{i.image_id}.png"}
                   for i in ds.images if i.user_id == req.user_id and (not i.request_id or i.request_id == req.request_id)],
        "usage": llm.usage.summary(),
    }
    print(json.dumps(out, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
