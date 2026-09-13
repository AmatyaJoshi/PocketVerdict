"""Plan generation, ranking and output formatting."""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from datetime import date
from typing import Optional

from .data import PaymentOption, Request
from .forecast import Forecast

STATUS_NOW, STATUS_PLAN, STATUS_LATER, STATUS_NO = "affordable_now", "affordable_with_plan", "affordable_later", "not_affordable"


@dataclass
class Change:
    action: str          # stop | reduce_to
    series_key: str
    event_id: str
    label: str
    new_amount: Optional[float] = None
    saving: float = 0.0

    def token(self) -> str:
        if self.action == "stop":
            return f"stop:{self.event_id}"
        return f"reduce_to:{self.event_id}:{fmt_amount(self.new_amount)}"


@dataclass
class Plan:
    method: str                                   # full_payment|partial_payment|installments|wait|not_recommended
    payments: list[tuple[date, float]]
    total: float
    changes: list[Change] = field(default_factory=list)
    option: Optional[PaymentOption] = None
    meets_deadline: bool = True

    def rank_key(self, req: Request):
        start = self.payments[0][0] if self.payments else req.deadline
        return (0 if self.meets_deadline else 1,
                1 if self.changes else 0,
                round(self.total, 6),
                start,
                len(self.payments),
                self.option.num if self.option else 0)


@dataclass
class Decision:
    request_id: str
    amount_safe: float
    status: str
    method: str
    plan: Optional[Plan]
    earliest: Optional[date]
    changes: list[Change]
    explanation: str = ""
    debug: dict = field(default_factory=dict)

    def row(self) -> dict:
        return {
            "request_id": self.request_id,
            "amount_safe_to_pay": fmt_amount(self.amount_safe),
            "affordability_status": self.status,
            "recommended_payment_method": self.method,
            "payment_plan": "|".join(f"{d.isoformat()}:{fmt_plan_amount(a, self.debug.get('req_amount'))}"
                                     for d, a in self.plan.payments) if self.plan and self.plan.payments else "none",
            "earliest_date_for_full_payment": self.earliest.isoformat() if self.earliest else "",
            "spending_changes_needed": "|".join(c.token() for c in self.changes) if self.changes else "none",
            "decision_explanation": self.explanation,
        }


# ------------------------------------------------------------------ formatting helpers
def fmt_amount(x: float) -> str:
    x = round(x + 0.0, 2)
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return s


def fmt_plan_amount(x: float, req_amount: Optional[float] = None) -> str:
    """Plan amounts mirror the request's precision: 620.4 -> '620.40', 25256 -> '25256'."""
    x = round(x, 2)
    if req_amount is not None and abs(req_amount - round(req_amount)) > 1e-9:
        return f"{x:.2f}"
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    return f"{x:.2f}"


def money(cur: str, x: float) -> str:
    x = round(x, 2)
    if abs(x - round(x)) < 1e-9:
        return f"{cur} {int(round(x)):,}"
    return f"{cur} {x:,.2f}"


def nice_date(d: date) -> str:
    return f"{d.day} {d.strftime('%B %Y')}"


# ------------------------------------------------------------------ planner
class Planner:
    def __init__(self, ds):
        self.ds = ds

    def decide(self, fc: Forecast) -> Decision:
        req, prof = fc.request, fc.profile
        safe = fc.amount_safe_today()
        earliest = fc.earliest_full_date()
        options = self.ds.options_by_request.get(req.request_id, [])
        cands: list[Plan] = []

        # 1) pay in full today / wait ------------------------------------------------
        if "full_payment" in prof.methods:
            if earliest is not None:
                if earliest == req.request_date:
                    cands.append(Plan("full_payment", [(req.request_date, req.amount)], req.amount))
                else:
                    cands.append(Plan("wait", [(earliest, req.amount)], req.amount, meets_deadline=earliest <= req.deadline))

        # 2) partial payment -----------------------------------------------------------
        if "partial_payment" in prof.methods and req.allows_partial and 0 < safe < req.amount \
                and earliest is not None and req.request_date < earliest <= req.deadline:
            cands.append(Plan("partial_payment", [(req.request_date, safe), (earliest, req.amount - safe)], req.amount))

        # 3) installments --------------------------------------------------------------
        if "installments" in prof.methods:
            for o in options:
                if o.method != "installments":
                    continue
                if prof.max_installment_months is not None and o.n_payments > prof.max_installment_months:
                    continue
                sched = o.schedule()
                if sched[0][0] < req.request_date:
                    continue
                if not fc.is_safe(fc.path(extra=[(d, -a) for d, a in sched])):
                    continue
                cands.append(Plan("installments", sched, o.total, option=o, meets_deadline=sched[-1][0] <= req.deadline))

        # 4) spending changes enabling a plan that meets the deadline ----------------------
        best_no_change = min((c for c in cands if c.meets_deadline), key=lambda c: c.rank_key(req), default=None)
        if best_no_change is None or best_no_change.changes:
            for plan in self._plans_with_changes(fc, safe, options):
                cands.append(plan)

        cands.sort(key=lambda c: c.rank_key(req))
        plan = cands[0] if cands else None
        if plan is None:
            dec = Decision(req.request_id, safe, STATUS_NO, "not_recommended", None, earliest, [])
        else:
            status = {"full_payment": STATUS_NOW, "wait": STATUS_LATER, "partial_payment": STATUS_PLAN,
                      "installments": STATUS_PLAN}[plan.method]
            if plan.changes:
                status = STATUS_PLAN
            dec = Decision(req.request_id, safe, status, plan.method, plan, earliest, plan.changes)
        dec.debug = {"req_amount": req.amount, "min_path": fc.min_balance(fc.path()), "n_flows": len(fc.flows),
                     "candidates": [(c.method, c.meets_deadline, bool(c.changes), c.total) for c in cands]}
        dec.explanation = self.explain(dec, fc)
        return dec

    # ------------------------------------------------------------------ spending changes
    def _plans_with_changes(self, fc: Forecast, safe: float, options: list[PaymentOption]) -> list[Plan]:
        req, prof = fc.request, fc.profile
        base_path = fc.path()
        actions: list[Change] = []
        for key, s in fc.series.items():
            if s.category in prof.protect or not s.occurrences:
                continue
            flex = s.flexibility
            if flex in ("stoppable", "reducible_or_stoppable") and s.category in prof.stop_ok:
                actions.append(Change("stop", key, s.last_event.event_id, s.label, None, s.amount * len(s.occurrences)))
            if flex in ("reducible", "reducible_or_stoppable") and s.category in prof.reduce_ok and s.min_allowed is not None \
                    and s.min_allowed < s.amount:
                actions.append(Change("reduce_to", key, s.last_event.event_id, s.label, s.min_allowed,
                                      (s.amount - s.min_allowed) * len(s.occurrences)))
        if not actions:
            return []
        plans: list[Plan] = []
        need_full = req.amount + prof.min_balance
        combos: list[list[Change]] = []
        for r in (1, 2, 3):
            for combo in itertools.combinations(actions, r):
                if len({c.series_key for c in combo}) != r:      # stop & reduce on the same series are exclusive
                    continue
                combos.append(list(combo))
        # smallest total saving first: least disruptive combination that works wins
        combos.sort(key=lambda cs: (sum(c.saving for c in cs), len(cs), min(int(c.event_id.split('_')[-1]) for c in cs)))
        found_full = None
        for combo in combos:
            removed = {c.series_key for c in combo if c.action == "stop"}
            reduced = {c.series_key: c.new_amount for c in combo if c.action == "reduce_to"}
            if "full_payment" in prof.methods:
                p = fc.path(extra=[(req.request_date, -req.amount)], removed=removed, reduced=reduced)
                if fc.is_safe(p):
                    plans.append(Plan("full_payment", [(req.request_date, req.amount)], req.amount, changes=combo))
                    found_full = combo
                    break
        if found_full is None:
            # try: changes that let the user wait until a date on/before the deadline, or use installments
            for combo in combos:
                removed = {c.series_key for c in combo if c.action == "stop"}
                reduced = {c.series_key: c.new_amount for c in combo if c.action == "reduce_to"}
                if "full_payment" in prof.methods:
                    e2 = fc.earliest_full_date(removed=removed, reduced=reduced)
                    if e2 is not None and e2 <= req.deadline:
                        plans.append(Plan("wait", [(e2, req.amount)], req.amount, changes=combo))
                        break
                if "installments" in prof.methods:
                    ok = False
                    for o in options:
                        if o.method != "installments":
                            continue
                        if prof.max_installment_months is not None and o.n_payments > prof.max_installment_months:
                            continue
                        sched = o.schedule()
                        if sched[0][0] < req.request_date or sched[-1][0] > req.deadline:
                            continue
                        if fc.is_safe(fc.path(extra=[(d, -a) for d, a in sched], removed=removed, reduced=reduced)):
                            plans.append(Plan("installments", sched, o.total, option=o, changes=combo))
                            ok = True
                            break
                    if ok:
                        break
        return plans

    # ------------------------------------------------------------------ explanation
    def explain(self, dec: Decision, fc: Forecast) -> str:
        req, prof = fc.request, fc.profile
        cur = prof.home_currency
        mn = money(cur, prof.min_balance)
        amt = money(cur, req.amount)
        if dec.method == "full_payment" and not dec.changes:
            return f"Pay {amt} today. This leaves at least {mn} available over the next 90 days."
        if dec.method == "full_payment" and dec.changes:
            parts = []
            for c in dec.changes:
                if c.action == "stop":
                    parts.append(f"stop the {c.label.lower()}")
                else:
                    parts.append(f"reduce the {c.label.lower()} to {money(cur, c.new_amount)}")
            s = " and ".join(parts)
            s = s[0].upper() + s[1:]
            return f"{s}, then pay {amt} today. This leaves at least {mn} available."
        if dec.method == "wait":
            d = dec.plan.payments[0][0]
            if dec.changes:
                parts = " and ".join((f"stop the {c.label.lower()}" if c.action == "stop"
                                      else f"reduce the {c.label.lower()} to {money(cur, c.new_amount)}") for c in dec.changes)
                return f"{parts[0].upper() + parts[1:]}, then pay {amt} in full on {nice_date(d)}. This keeps the {mn} minimum protected."
            late = "" if d <= req.deadline else f" This is after the {nice_date(req.deadline)} target date, so confirm the seller still accepts payment then."
            return (f"Pay {amt} in full on {nice_date(d)}. Paying earlier would take the balance below the {mn} minimum.{late}")
        if dec.method == "partial_payment":
            (d1, a1), (d2, a2) = dec.plan.payments
            return (f"Pay {money(cur, a1)} today and the remaining {money(cur, a2)} on {nice_date(d2)}. "
                    f"This completes the full request and keeps the {mn} minimum protected.")
        if dec.method == "installments":
            o = dec.plan.option
            lead = ""
            if dec.changes:
                parts = " and ".join((f"stop the {c.label.lower()}" if c.action == "stop"
                                      else f"reduce the {c.label.lower()} to {money(cur, c.new_amount)}") for c in dec.changes)
                lead = parts[0].upper() + parts[1:] + ", then "
            body = f"use {o.n_payments} installments of {money(cur, o.payment_amount)}, starting {nice_date(o.first_date)}."
            if not lead:
                body = body[0].upper() + body[1:]
            return f"{lead}{body} This leaves at least {mn} available."
        # not recommended
        if dec.earliest is None and dec.amount_safe > 0 and req.allows_partial:
            return (f"Do not proceed with the {amt} request. Although {money(cur, dec.amount_safe)} is available today, "
                    f"the full amount cannot be completed safely within 90 days.")
        return (f"Do not make this payment by {nice_date(req.deadline)}. None of the available options keeps the "
                f"{mn} minimum protected.")
