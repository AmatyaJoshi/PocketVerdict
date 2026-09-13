"""Financial-state reconstruction and the 90-day cash-flow forecast.

Pipeline for one request:
  1. normalise the user's events (currency conversion, blank amounts from images, exclusions)
  2. reserve known future cash flows (pending / scheduled debits, confirmed scheduled salary)
  3. detect recurring series in settled history and project them forward
  4. apply message adjustments (salary changes, rent increase, ended income, ...)
  5. simulate the daily balance and expose helpers for the planner
"""
from __future__ import annotations

import calendar
import statistics
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from .data import Dataset, Event, Profile, Request
from .evidence import Adjustment, ImageReader, MessageParser

HORIZON_DAYS = 90

# Tunable knobs (calibrated on dataset/sample_requests.csv, see evaluation/main.py --tune)
DEFAULT_KNOBS = {
    "amount_stat": "mean",        # mean | median | last | max | mean3   (variable recurring debits)
    "salary_stat": "last",        # amount used for projected regular salary
    "min_occurrences": 3,         # to call a debit series recurring
    "include_same_day": True,    # a recurring debit due on request_date is not yet deducted
    "stale_periods": 1.6,         # series is dead if last occurrence older than this many periods
    "salary_max_spread": 0.12,    # (max-min)/max allowed for a stable salary series
    "outlier_factor": 2.5,        # drop amounts > factor * median from a debit series
    "horizon": HORIZON_DAYS - 1,  # request_date .. request_date+89 = 90 forecast days
    "reserve_failed": True,       # a failed debit is still an outstanding bill -> reserve it
    "project_weekly_income": False,
    "salary_require_stable": False,
    "apply_salary_messages": True,
    "salary_stale_days": 45,
    "apply_base_confirmed": False,
    "dedupe_days": 7,
    "reduced_next_scope_all": True,
}

ONE_OFF_INCOME_WORDS = ("bonus", "commission", "komisi", "arrears", "prorated", "prize", "reimburse", "windfall",
                        "refund", "reversal", "milestone", "payout", "earnings", "contract payment", "project payment",
                        "invoice payment", "retainer", "sale proceeds", "adjustment", "one-time", "final")


@dataclass
class Flow:
    day: date
    amount: float            # +credit / -debit, home currency
    kind: str                # pending|scheduled|recurring|salary|message|plan
    label: str
    series: Optional[str] = None


@dataclass
class Series:
    key: str
    category: str
    event_type: str
    flexibility: str
    min_allowed: Optional[float]
    period_days: Optional[int]      # None => monthly by day-of-month
    dom: Optional[int]
    amount: float
    last_event: Event
    events: list[Event]
    occurrences: list[date] = field(default_factory=list)

    @property
    def label(self) -> str:
        return self.last_event.description


@dataclass
class Forecast:
    profile: Profile
    request: Request
    start: date
    end: date
    flows: list[Flow]
    series: dict[str, Series]
    notes: list[str]
    adjustments: list[Adjustment]

    # ---------------------------------------------------------------- simulation
    def path(self, extra: Optional[list[tuple[date, float]]] = None, removed: Optional[set[str]] = None,
             reduced: Optional[dict[str, float]] = None) -> list[tuple[date, float]]:
        """Daily closing balance from start..end. `extra` adds (date, signed amount) flows,
        `removed` drops series keys (stop), `reduced` replaces per-occurrence amounts (reduce_to)."""
        by_day: dict[date, float] = {}
        for f in self.flows:
            if f.series and removed and f.series in removed:
                continue
            amt = f.amount
            if f.series and reduced and f.series in reduced:
                amt = -reduced[f.series]
            by_day[f.day] = by_day.get(f.day, 0.0) + amt
        for d, a in (extra or []):
            if self.start <= d <= self.end:
                by_day[d] = by_day.get(d, 0.0) + a
        bal = self.profile.balance
        out = []
        d = self.start
        while d <= self.end:
            bal += by_day.get(d, 0.0)
            out.append((d, bal))
            d += timedelta(days=1)
        return out

    def is_safe(self, path: list[tuple[date, float]]) -> bool:
        return all(b >= self.profile.min_balance - 1e-6 for _, b in path)

    def min_balance(self, path: list[tuple[date, float]]) -> float:
        return min(b for _, b in path)

    def amount_safe_today(self) -> float:
        p = self.path()
        room = self.min_balance(p) - self.profile.min_balance
        return max(0.0, min(self.request.amount, room))

    def earliest_full_date(self, removed=None, reduced=None) -> Optional[date]:
        """First day D such that paying the full amount on D keeps every later balance >= minimum."""
        p = self.path(removed=removed, reduced=reduced)
        need = self.profile.min_balance + self.request.amount
        # suffix minimum
        suffix = [0.0] * len(p)
        m = float("inf")
        for i in range(len(p) - 1, -1, -1):
            m = min(m, p[i][1])
            suffix[i] = m
        for i, (d, _) in enumerate(p):
            if suffix[i] >= need - 1e-6:
                return d
        return None


# ----------------------------------------------------------------------------- helpers
def _add_months(d: date, n: int, dom: int) -> date:
    y, m = d.year, d.month + n
    while m > 12:
        y, m = y + 1, m - 12
    while m < 1:
        y, m = y - 1, m + 12
    last = calendar.monthrange(y, m)[1]
    return date(y, m, min(dom, last))


def _stat(vals: list[float], how: str) -> float:
    if how == "median":
        return statistics.median(vals)
    if how == "last":
        return vals[-1]
    if how == "max":
        return max(vals)
    if how == "mean3":
        return statistics.mean(vals[-3:])
    if how == "min":
        return min(vals)
    return statistics.mean(vals)


def _is_one_off_income(e: Event) -> bool:
    low = e.description.lower()
    return any(w in low for w in ONE_OFF_INCOME_WORDS)


class Forecaster:
    def __init__(self, ds: Dataset, images: ImageReader, messages: MessageParser, knobs: Optional[dict] = None):
        self.ds = ds
        self.images = images
        self.messages = messages
        self.k = dict(DEFAULT_KNOBS)
        if knobs:
            self.k.update(knobs)

    # ------------------------------------------------------------------ step 1
    def normalise(self, prof: Profile, req: Request) -> tuple[list[Event], list[str]]:
        notes = []
        evs = []
        for e0 in self.ds.events_by_user.get(prof.user_id, []):
            e = Event(**{k: getattr(e0, k) for k in e0.__dataclass_fields__})
            if e.amount is None:
                img = self.ds.images_by_event.get(e.event_id)
                if img:
                    r = self.images.read(img, e)
                    if r.amount is not None:
                        e.amount = r.amount
                        if r.currency and r.currency != e.currency:
                            e.currency = r.currency
                        notes.append(f"{e.event_id}: amount {r.amount} {e.currency} read from {img.image_id} ({r.source})")
                if e.amount is None:
                    e.excluded, e.exclude_reason = True, "blank amount and no readable image"
                    notes.append(f"{e.event_id}: blank amount, no evidence -> excluded")
            if e.amount is not None:
                on = e.settlement_date or e.event_date
                conv = self.ds.convert(e.amount, e.currency, prof.home_currency, on)
                if conv is None:
                    e.excluded, e.exclude_reason = True, f"no rate {e.currency}->{prof.home_currency}"
                    notes.append(f"{e.event_id}: {e.exclude_reason}")
                e.home_amount = conv
            if e.status == "cancelled" or (e.status == "failed" and not self.k["reserve_failed"]):
                e.excluded, e.exclude_reason = True, e.status
            elif e.direction == "non_cash" or e.status == "unrealized" or e.event_type == "investment_valuation":
                e.excluded, e.exclude_reason = True, "non-cash valuation"
            evs.append(e)
        return evs, notes

    # ------------------------------------------------------------------ step 2-5
    def build(self, req: Request) -> Forecast:
        prof = self.ds.profiles[req.user_id]
        start = req.request_date
        end = start + timedelta(days=int(self.k["horizon"]))
        evs, notes = self.normalise(prof, req)
        adjustments: list[Adjustment] = []
        for m in self.ds.messages_by_user.get(req.user_id, []):
            if m.request_id and m.request_id != req.request_id:
                continue
            if m.sent_at.date() > start:
                continue
            adjustments.extend(self.messages.parse(m))
        kinds = {a.kind for a in adjustments}

        # internal transfers: remove matching debit/credit pairs around the message date
        if "internal_transfer" in kinds:
            self._drop_internal_transfers(evs, adjustments, notes)

        flows: list[Flow] = []
        live = [e for e in evs if not e.excluded and e.home_amount is not None]

        # known future flows ------------------------------------------------
        scheduled_salary_days: list[date] = []
        for e in live:
            sd = e.settlement_date or e.event_date
            if e.status in ("pending", "scheduled", "failed"):
                day = max(sd, start)
                if day > end:
                    continue
                if e.direction == "debit":
                    flows.append(Flow(day, -e.home_amount, e.status, e.description))
                elif e.direction == "credit":
                    # only confirmed salary counts before it settles
                    if e.event_type == "income" and e.category == "salary" and e.status == "scheduled" \
                            and "income_ended" not in kinds:
                        flows.append(Flow(day, e.home_amount, "salary", e.description, series="salary"))
                        scheduled_salary_days.append(day)
                    else:
                        notes.append(f"{e.event_id}: pending credit not counted ({e.description})")

        # recurring debits ---------------------------------------------------
        series = self._detect_debit_series(live, start, end, notes)
        rent_mult = 1.0
        for a in adjustments:
            if a.kind == "rent_increase" and a.pct:
                rent_mult = 1 + a.pct / 100.0
        # a known pending / scheduled / failed debit in the same category replaces the projected
        # occurrence it obviously corresponds to (e.g. a failed utility debit that will be retried)
        known = [(e.category, max(e.settlement_date or e.event_date, start)) for e in live
                 if e.direction == "debit" and e.status in ("pending", "scheduled", "failed")]
        for s in series.values():
            amt = s.amount
            if rent_mult != 1.0 and s.category in ("rent", "housing") and s.event_type == "expense" \
                    and "rent" in s.label.lower():
                amt = round(amt * rent_mult, 2)
                notes.append(f"{s.key}: rent increased by message to {amt}")
            kept = []
            for d in s.occurrences:
                if s.period_days is None and any(c == s.category and abs((kd - d).days) <= self.k.get("dedupe_days", 7)
                                                 for c, kd in known):
                    notes.append(f"{s.key}: projected {d} replaced by a known {s.category} debit")
                    continue
                kept.append(d)
                flows.append(Flow(d, -amt, "recurring", s.label, series=s.key))
            s.occurrences = kept

        # regular salary -----------------------------------------------------
        self._project_salary(live, prof, start, end, adjustments, scheduled_salary_days, flows, notes)

        # one-off confirmed credits from messages ------------------------------
        for a in adjustments:
            if a.kind == "invoice_approved" and a.amount and a.date and start <= a.date <= end:
                amt = self.ds.convert(a.amount, a.currency or prof.home_currency, prof.home_currency, a.date)
                if amt:
                    flows.append(Flow(a.date, amt, "message", f"approved invoice ({a.message_id})"))
            if a.kind == "salary_foreign_confirmed" and a.amount and a.date and start <= a.date <= end:
                if not any(abs((a.date - d).days) <= 3 for d in scheduled_salary_days) and \
                        not any(f.series == "salary" and abs((f.day - a.date).days) <= 3 for f in flows):
                    amt = self.ds.convert(a.amount, a.currency or prof.home_currency, prof.home_currency, a.date)
                    if amt:
                        flows.append(Flow(a.date, amt, "salary", f"confirmed salary ({a.message_id})", series="salary"))

        return Forecast(prof, req, start, end, flows, series, notes, adjustments)

    # ------------------------------------------------------------------ internals
    def _drop_internal_transfers(self, evs: list[Event], adjustments: list[Adjustment], notes: list[str]):
        for a in adjustments:
            if a.kind != "internal_transfer":
                continue
            m = next((mm for mm in self.ds.messages_by_user.get(evs[0].user_id, []) if mm.message_id == a.message_id), None)
            if not m:
                continue
            when = m.sent_at.date()
            window = [e for e in evs if not e.excluded and e.amount is not None and abs((e.event_date - when).days) <= 45]
            credits = [e for e in window if e.direction == "credit"]
            debits = [e for e in window if e.direction == "debit"]
            for c in credits:
                for d in debits:
                    if d.excluded or abs(d.amount - c.amount) < 0.005 and abs((d.event_date - c.event_date).days) <= 5:
                        c.excluded = d.excluded = True
                        c.exclude_reason = d.exclude_reason = "internal transfer"
                        notes.append(f"{c.event_id}/{d.event_id}: internal transfer pair excluded")
                        break

    def _detect_debit_series(self, live: list[Event], start: date, end: date, notes: list[str]) -> dict[str, Series]:
        k = self.k
        hist = [e for e in live if e.direction == "debit" and e.status == "settled" and e.event_date < start
                and e.event_type in ("expense", "subscription", "debt_payment")]
        groups: dict[tuple, list[Event]] = {}
        for e in hist:
            groups.setdefault((e.event_type, e.category, e.flexibility, e.min_allowed), []).append(e)
        out: dict[str, Series] = {}
        for gk, es in groups.items():
            es.sort(key=lambda e: (e.event_date, e.num))
            amounts = [e.home_amount for e in es]
            if len(es) >= 4:
                med = statistics.median(amounts)
                keep = [e for e in es if e.home_amount <= k["outlier_factor"] * med]
                if len(keep) != len(es):
                    notes.append(f"{gk[1]}: {len(es) - len(keep)} outlier(s) treated as one-off")
                es = keep
            if len(es) < k["min_occurrences"]:
                continue
            dates = [e.event_date for e in es]
            gaps = [(dates[i + 1] - dates[i]).days for i in range(len(dates) - 1)]
            gaps = [g for g in gaps if g > 0] or [0]
            g = statistics.median(gaps)
            if g <= 0:
                continue
            if max(gaps) > 2.2 * g:      # irregular cadence -> not recurring
                continue
            last = es[-1]
            monthly = 26 <= g <= 33
            period = None if monthly else int(round(g))
            if (start - last.event_date).days > k["stale_periods"] * (30 if monthly else period):
                continue
            amt = _stat([e.home_amount for e in es], k["amount_stat"])
            occ = []
            if monthly:
                dom = last.event_date.day
                n = 1
                d = _add_months(last.event_date, n, dom)
                while d <= end:
                    if d > start or (d == start and k["include_same_day"]):
                        occ.append(d)
                    n += 1
                    d = _add_months(last.event_date, n, dom)
            else:
                d = last.event_date + timedelta(days=period)
                while d <= end:
                    if d > start or (d == start and k["include_same_day"]):
                        occ.append(d)
                    d += timedelta(days=period)
            key = f"{gk[0]}:{gk[1]}:{gk[2]}"
            out[key] = Series(key=key, category=gk[1], event_type=gk[0], flexibility=gk[2], min_allowed=gk[3],
                              period_days=period, dom=last.event_date.day if monthly else None, amount=amt,
                              last_event=last, events=es, occurrences=occ)
        return out

    def _project_salary(self, live, prof, start, end, adjustments, scheduled_days, flows, notes):
        """Project regular income.  A stream is *regular* when its cadence is stable (monthly on a
        fixed day, or every 7/14 days); amounts may step up or down (raises, leave) and the most
        recent amount is carried forward.  Irregular gig/freelance income with no stable cadence,
        bonuses, commissions, arrears, prizes, refunds and reimbursements are never projected."""
        k = self.k
        kinds = {a.kind for a in adjustments}
        sal = [e for e in live if e.direction == "credit" and e.status == "settled" and e.event_date < start
               and e.event_type == "income" and e.category == "salary"]
        sal.sort(key=lambda e: (e.event_date, e.num))
        regular = [e for e in sal if not _is_one_off_income(e)]
        income_over = bool(sal) and any(w in sal[-1].description.lower() for w in ("final", "last payroll", "terakhir"))
        if income_over:
            notes.append("most recent payroll is marked final -> no future salary projected")
            regular = []

        streams: list[dict] = []   # {dom|period, events, amount}
        # (a) monthly streams: cluster by day-of-month
        clusters: dict[int, list[Event]] = {}
        for e in regular:
            dom = e.event_date.day
            key = next((c for c in clusters if abs(c - dom) <= 2), dom)
            clusters.setdefault(key, []).append(e)
        used: set[str] = set()
        for dom, es in clusters.items():
            es.sort(key=lambda e: e.event_date)
            if len(es) < 2:
                continue
            gaps = [(es[i + 1].event_date - es[i].event_date).days for i in range(len(es) - 1)]
            if not all(25 <= g <= 36 for g in gaps):
                continue
            if (start - es[-1].event_date).days > k.get("salary_stale_days", 70):
                notes.append(f"salary stream dom={dom}: stale -> not projected")
                continue
            amts = [e.home_amount for e in es]
            spread = (max(amts) - min(amts)) / max(amts) if max(amts) else 0
            if spread > k["salary_max_spread"] and k.get("salary_require_stable", False):
                notes.append(f"salary stream dom={dom}: variable amounts (spread {spread:.2f}) -> not projected")
                continue
            if "final" in es[-1].description.lower():
                notes.append("last payroll marked final -> no future salary")
                continue
            streams.append({"dom": dom, "period": None, "events": es, "amount": _stat(amts, k["salary_stat"])})
            used.update(e.event_id for e in es)
        # (b) weekly / fortnightly streams (gig platforms) - only when the knob allows
        rest = [e for e in regular if e.event_id not in used]
        if k.get("project_weekly_income", False) and len(rest) >= 4:
            rest.sort(key=lambda e: e.event_date)
            gaps = [(rest[i + 1].event_date - rest[i].event_date).days for i in range(len(rest) - 1)]
            g = statistics.median(gaps)
            if 6 <= g <= 15 and max(gaps) <= 2.2 * g and (start - rest[-1].event_date).days <= 2 * g:
                streams.append({"dom": None, "period": int(round(g)), "events": rest,
                                "amount": _stat([e.home_amount for e in rest], k["salary_stat"])})

        # (c) a confirmed scheduled salary row anchors a monthly stream when history has none
        sched = [f for f in flows if f.series == "salary" and f.kind == "salary"]
        for f in sched:
            if not any(s["dom"] is not None and abs(s["dom"] - f.day.day) <= 2 for s in streams):
                streams.append({"dom": f.day.day, "period": None, "events": [], "amount": f.amount, "anchor": f.day})
                notes.append(f"confirmed salary {f.amount:.2f} on {f.day} used as recurring anchor")

        if "income_ended" in kinds or income_over:
            notes.append("no future salary projected (income ended)")
            streams = []
            for f in list(flows):
                if f.series == "salary":
                    flows.remove(f)
        if "payout_pending" in kinds:
            streams = [s for s in streams if s["period"] is None]
            notes.append("message: platform payout pending -> irregular income not projected")
        if "salary_remaining" in kinds and streams:
            a = next(a for a in adjustments if a.kind == "salary_remaining")
            amt = self.ds.convert(a.amount, a.currency or prof.home_currency, prof.home_currency, start) if a.amount else None
            best = min(streams, key=lambda s: abs(s["amount"] - (amt or s["amount"])))
            best["amount"] = amt or best["amount"]
            streams = [best]
            notes.append(f"message: one household income ended, remaining {amt}")

        not_before = None
        for a in adjustments:
            if a.kind in ("salary_first", "salary_resumes") and a.amount and a.date:
                amt = self.ds.convert(a.amount, a.currency or prof.home_currency, prof.home_currency, a.date)
                if amt is None:
                    continue
                dom = a.date.day
                hit = [s for s in streams if s["dom"] is not None and abs(s["dom"] - dom) <= 2]
                if hit:
                    for s in hit:
                        s["amount"] = amt
                else:
                    streams.append({"dom": dom, "period": None, "events": [], "amount": amt, "anchor": a.date})
                    notes.append(f"message: salary {amt:.2f} starts {a.date}")
                not_before = a.date

        all_kinds = ["salary_temporary", "salary_arrears"]
        if k.get("apply_base_confirmed", False):
            all_kinds.append("salary_base_confirmed")
        if k.get("reduced_next_scope_all", True):
            all_kinds.append("salary_reduced_next")
        override_all = next((a for a in adjustments if a.kind in all_kinds and a.amount), None)
        override_from = next((a for a in adjustments if a.kind == "salary_increase" and a.amount), None)
        override_next = next((a for a in adjustments if a.kind in ("salary_reduced_next", "salary_arrears") and a.amount
                              and a.kind not in all_kinds), None)
        arrears = next((a for a in adjustments if a.kind == "salary_arrears" and a.note), None)
        date_shift = next((a for a in adjustments if a.kind == "salary_date" and a.date), None)
        apply_msgs = k.get("apply_salary_messages", True)

        def conv(a, d):
            return self.ds.convert(a.amount, a.currency or prof.home_currency, prof.home_currency, d)

        for s in streams:
            base = s["amount"]
            if override_all and apply_msgs:
                base = conv(override_all, start) or base
            dates: list[date] = []
            if s["period"] is None:
                dom = date_shift.date.day if date_shift else s["dom"]
                if s["events"]:
                    anchor, n = s["events"][-1].event_date, 1
                else:
                    anchor, n = s.get("anchor", start), 0
                d = _add_months(anchor, n, dom)
                while d <= end:
                    if d >= start:
                        dates.append(d)
                    n += 1
                    d = _add_months(anchor, n, dom)
            else:
                d = s["events"][-1].event_date + timedelta(days=s["period"])
                while d <= end:
                    if d >= start:
                        dates.append(d)
                    d += timedelta(days=s["period"])
            first = True
            projected = 0
            for d in dates:
                if not_before and d < not_before:
                    continue
                pay = base
                if override_from and override_from.date and d >= override_from.date and apply_msgs:
                    pay = conv(override_from, d) or pay
                if first and override_next and apply_msgs:
                    pay = conv(override_next, d) or pay
                if first and arrears and apply_msgs:
                    import json as _json
                    extra = _json.loads(arrears.note).get("arrears") or 0
                    pay += self.ds.convert(extra, arrears.currency or prof.home_currency, prof.home_currency, d) or 0
                first = False
                # a confirmed scheduled row on (about) the same day takes precedence
                near = [f for f in flows if f.series == "salary" and f.kind == "salary" and abs((f.day - d).days) <= 3]
                if near:
                    if date_shift:
                        for f in near:
                            f.day = d
                    continue
                flows.append(Flow(d, pay, "salary", "projected salary", series="salary"))
                projected += 1
            label = ('dom=' + str(s['dom'])) if s['period'] is None else ('every ' + str(s['period']) + 'd')
            notes.append(f"salary stream {label}: base {base:.2f}, {projected} projected payroll(s)")
