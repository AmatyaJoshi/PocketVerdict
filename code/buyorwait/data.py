"""Loading and light normalisation of the participant-facing dataset."""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional


def _d(s: str) -> Optional[date]:
    s = (s or "").strip()
    if not s:
        return None
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def _f(s: str) -> Optional[float]:
    s = (s or "").strip()
    if s == "":
        return None
    return float(s)


def _split(s: str) -> list[str]:
    return [x.strip() for x in (s or "").split("|") if x.strip()]


@dataclass
class Profile:
    user_id: str
    home_currency: str
    balance: float
    min_balance: float
    priorities: list[str]
    protect: list[str]
    reduce_ok: list[str]
    stop_ok: list[str]
    methods: list[str]
    max_installment_months: Optional[int]


@dataclass
class Event:
    event_id: str
    user_id: str
    event_type: str
    description: str
    category: str
    direction: str
    amount: Optional[float]
    currency: str
    event_date: date
    settlement_date: Optional[date]
    status: str
    linked_event_id: str
    flexibility: str
    min_allowed: Optional[float]
    # derived
    home_amount: Optional[float] = None   # amount in the user's home currency
    excluded: bool = False
    exclude_reason: str = ""

    @property
    def num(self) -> int:
        return int(self.event_id.split("_")[-1])


@dataclass
class Request:
    request_id: str
    user_id: str
    request_date: date
    request_type: str
    amount: float
    deadline: date
    allows_partial: bool
    text: str
    # present only in sample_requests.csv
    expected: dict = field(default_factory=dict)


@dataclass
class PaymentOption:
    option_id: str
    request_id: str
    method: str
    payment_amount: float
    n_payments: int
    first_date: date
    frequency_days: Optional[int]
    fee: float
    total: float

    @property
    def num(self) -> int:
        return int(self.option_id.split("_")[-1])

    def schedule(self) -> list[tuple[date, float]]:
        out = []
        for k in range(self.n_payments):
            d = self.first_date + timedelta(days=k * (self.frequency_days or 0))
            out.append((d, self.payment_amount))
        return out


@dataclass
class Message:
    message_id: str
    user_id: str
    request_id: str
    related_event_id: str
    sent_at: datetime
    source_type: str
    text: str


@dataclass
class ImageRef:
    image_id: str
    user_id: str
    request_id: str
    related_event_id: str


@dataclass
class Dataset:
    root: Path
    profiles: dict[str, Profile]
    events: list[Event]
    events_by_user: dict[str, list[Event]]
    events_by_id: dict[str, Event]
    requests: list[Request]
    sample_requests: list[Request]
    options_by_request: dict[str, list[PaymentOption]]
    messages_by_user: dict[str, list[Message]]
    images: list[ImageRef]
    images_by_event: dict[str, ImageRef]
    rates: dict[tuple[str, str], list[tuple[date, float]]]

    def image_path(self, image_id: str) -> Path:
        return self.root / "media" / "images" / f"{image_id}.png"

    def convert(self, amount: float, from_cur: str, to_cur: str, on: date, _depth: int = 0) -> Optional[float]:
        """Convert using the fixed rate table. Prefer the exact settlement-date row for the
        stated direction, else the closest dated row for the pair (or its inverse)."""
        if from_cur == to_cur:
            return amount
        rows = self.rates.get((from_cur, to_cur))
        if rows:
            exact = [r for d, r in rows if d == on]
            if exact:
                return amount * exact[0]
            _, r0 = min(rows, key=lambda dr: abs((dr[0] - on).days))
            return amount * r0
        rows = self.rates.get((to_cur, from_cur))
        if rows:
            exact = [r for d, r in rows if d == on]
            if exact:
                return amount / exact[0]
            _, r0 = min(rows, key=lambda dr: abs((dr[0] - on).days))
            return amount / r0
        if _depth == 0:
            for mid in ("USD", "EUR"):
                if mid in (from_cur, to_cur):
                    continue
                a = self.convert(amount, from_cur, mid, on, 1)
                if a is None:
                    continue
                b = self.convert(a, mid, to_cur, on, 1)
                if b is not None:
                    return b
        return None


def _read(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _parse_requests(rows: list[dict]) -> list[Request]:
    out = []
    for r in rows:
        exp = {}
        for k in ("amount_safe_to_pay", "affordability_status", "recommended_payment_method",
                  "payment_plan", "earliest_date_for_full_payment", "spending_changes_needed",
                  "decision_explanation"):
            if k in r:
                exp[k] = r[k]
        out.append(Request(
            request_id=r["request_id"], user_id=r["user_id"], request_date=_d(r["request_date"]),
            request_type=r["request_type"], amount=float(r["requested_amount"]),
            deadline=_d(r["desired_completion_date"]),
            allows_partial=str(r["allows_partial_payment"]).strip().lower() == "true",
            text=r.get("request_text", ""), expected=exp))
    return out


def load_dataset(root: str | Path) -> Dataset:
    root = Path(root)
    profiles = {}
    for r in _read(root / "financial_profiles.csv"):
        mim = (r.get("max_installment_months") or "").strip()
        profiles[r["user_id"]] = Profile(
            user_id=r["user_id"], home_currency=r["home_currency"],
            balance=float(r["current_available_balance"]), min_balance=float(r["minimum_balance_to_keep"]),
            priorities=_split(r["financial_priorities"]), protect=_split(r["expense_categories_to_protect"]),
            reduce_ok=_split(r["expense_categories_user_is_willing_to_reduce"]),
            stop_ok=_split(r["expense_categories_user_is_willing_to_stop"]),
            methods=_split(r["payment_methods_user_will_consider"]),
            max_installment_months=int(float(mim)) if mim else None)

    events = []
    for r in _read(root / "financial_events.csv"):
        events.append(Event(
            event_id=r["event_id"], user_id=r["user_id"], event_type=r["event_type"],
            description=r["description"], category=r["category"], direction=r["direction"],
            amount=_f(r["amount"]), currency=r["currency"], event_date=_d(r["event_date"]),
            settlement_date=_d(r["settlement_date"]), status=r["status"],
            linked_event_id=(r.get("linked_event_id") or "").strip(), flexibility=r["flexibility"],
            min_allowed=_f(r.get("minimum_allowed_amount", ""))))
    events_by_user: dict[str, list[Event]] = {}
    for e in events:
        events_by_user.setdefault(e.user_id, []).append(e)
    events_by_id = {e.event_id: e for e in events}

    requests = _parse_requests(_read(root / "requests.csv"))
    samples_path = root / "sample_requests.csv"
    samples = _parse_requests(_read(samples_path)) if samples_path.exists() else []

    options_by_request: dict[str, list[PaymentOption]] = {}
    for r in _read(root / "request_payment_options.csv"):
        fd = (r.get("payment_frequency_days") or "").strip()
        o = PaymentOption(
            option_id=r["payment_option_id"], request_id=r["request_id"], method=r["payment_method"],
            payment_amount=float(r["payment_amount"]), n_payments=int(float(r["number_of_payments"])),
            first_date=_d(r["first_payment_date"]), frequency_days=int(float(fd)) if fd else None,
            fee=float(r.get("financing_fee") or 0), total=float(r["total_payable_amount"]))
        options_by_request.setdefault(o.request_id, []).append(o)

    messages_by_user: dict[str, list[Message]] = {}
    for r in _read(root / "messages.csv"):
        m = Message(message_id=r["message_id"], user_id=r["user_id"], request_id=(r.get("request_id") or "").strip(),
                    related_event_id=(r.get("related_event_id") or "").strip(),
                    sent_at=datetime.strptime(r["sent_at"].replace("Z", "")[:19], "%Y-%m-%dT%H:%M:%S"),
                    source_type=r["source_type"], text=r["message_text"])
        messages_by_user.setdefault(m.user_id, []).append(m)

    images = [ImageRef(r["image_id"], r["user_id"], (r.get("request_id") or "").strip(),
                       (r.get("related_event_id") or "").strip()) for r in _read(root / "images.csv")]
    images_by_event = {i.related_event_id: i for i in images if i.related_event_id}

    rates: dict[tuple[str, str], list[tuple[date, float]]] = {}
    for r in _read(root / "exchange_rates.csv"):
        rates.setdefault((r["from_currency"], r["to_currency"]), []).append((_d(r["rate_date"]), float(r["rate"])))

    return Dataset(root=root, profiles=profiles, events=events, events_by_user=events_by_user,
                   events_by_id=events_by_id, requests=requests, sample_requests=samples,
                   options_by_request=options_by_request, messages_by_user=messages_by_user,
                   images=images, images_by_event=images_by_event, rates=rates)
