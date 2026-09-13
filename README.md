# PocketVerdict

**Buy or wait?** PocketVerdict answers that question for a real person with real commitments.
Give it an expense, and it rebuilds the user's cash flow, forecasts the next 90 days, and returns a
verdict: pay in full, pay part now, use a seller's installment plan, wait for a date, or don't.

Every verdict is *safe by construction*: the projected balance never drops below the user's
minimum on any day of the forecast, essentials stay covered, and the plan finishes by the deadline.

```
┌───────────────────────────────┐        ┌──────────────────────────────────┐
│  Decision engine (Python)     │        │  Workbench (Next.js 16)          │
│  code/                        │  JSON  │  web/                            │
│  • events → 90-day forecast   │◀──────▶│  • dashboard, request detail     │
│  • plan ranking & changes     │        │  • ask flow, evaluation page     │
│  • VLM / OCR + message parser │        │  • grounded advisor chatbot      │
│  • verifier → output.csv      │        │  • Prisma · MySQL/SQLite · Auth  │
└───────────────────────────────┘        └──────────────────────────────────┘
```

---

## What a verdict contains

| Field | Meaning |
|---|---|
| `amount_safe_to_pay` | The most the user can pay **today** without breaking the 90-day safety check |
| `affordability_status` | `affordable_now` · `affordable_with_plan` · `affordable_later` · `not_affordable` |
| `recommended_payment_method` | `full_payment` · `partial_payment` · `installments` · `wait` · `not_recommended` |
| `payment_plan` | Every payment as `YYYY-MM-DD:amount`, chronological |
| `earliest_date_for_full_payment` | First day the whole amount is safe as a single payment |
| `spending_changes_needed` | Up to three `stop:<event>` / `reduce_to:<event>:<amount>` on flexible expenses |
| `decision_explanation` | One or two plain sentences with the numbers behind the call |

---

## How the engine thinks

1. **Reconstruct the financial state.** Load profiles, events, seller options, messages, images and
   dated FX rates. Convert foreign-currency rows with the rate for their settlement date. Fill blank
   amounts from the linked bill or payslip image (vision model if a key is present, otherwise a bundled
   offline OCR model). Drop cancelled, non-cash and unrealised rows; recognise internal transfers.
2. **Read the evidence.** Messages follow employer / bank / merchant templates in English and
   Indonesian. A rule-based parser turns them into structured adjustments: salary raised, cut, moved or
   ended; first salary confirmed; arrears; approved invoices; rent +12 %; pending refunds and prizes
   that must *not* be counted. Anything unrecognised can be classified by an LLM, and every answer is
   validated before it touches a number. Instructions embedded in messages or images are never executed.
3. **Forecast 90 days.** Reserve pending, scheduled and failed debits; count confirmed salary on its
   settlement date; project recurring series found in history by cadence (monthly, weekly, every N
   days) and amount statistics; de-duplicate against known upcoming rows.
4. **Run the safety check.** Simulate the daily balance. The safe amount is the trough above the
   minimum; the earliest full-payment date is the first day whose suffix-minimum still clears the
   minimum plus the request.
5. **Rank the plans.** Full, wait, partial and each installment option are simulated. Eligibility
   follows the user's accepted methods and installment limit. Spending changes are only proposed on
   flexible, non-protected series the user is willing to adjust, and the least disruptive combination
   that works is chosen. Ranking: meets the deadline → no changes → lowest total cost → earlier start →
   fewer payments → lowest option id.
6. **Verify and explain.** A contract checker enforces bounds, plan shapes, option matching and
   flexible-only changes before `output.csv` is written; the explanation is generated from the numbers.

---

## Quick start

### Decision engine (Python 3.10+)

```bash
pip install -r code/requirements.txt
python code/main.py                                  # dataset/requests.csv -> output.csv
python code/evaluation/main.py                       # score against the 25 solved samples
python code/evaluation/main.py --validate output.csv # contract checks (rows, columns, rules)
python code/evaluation/main.py --tune                # grid-search forecaster knobs
python code/evaluation/main.py --usage-report        # regenerate code/evaluation/usage_report.md
```

Runs fully offline. To use models, set one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`
(images go through a vision model, unusual messages through an LLM). `BUYORWAIT_LLM=off|auto|on`.

### Workbench (Node 20+)

```bash
cd web
cp .env.example .env               # set AUTH_SECRET; choose a database below
npm install

# Option A – MySQL (production target)
docker compose up -d               # MySQL 8.4 on localhost:3307
npx prisma db push && npm run db:seed

# Option B – SQLite (zero setup)
#   DATABASE_URL="file:./dev.db" in .env, then:
npm run db:sqlite

npm run dev                        # http://localhost:3000  (demo@buyorwait.app / demo1234)
```

The web app calls the engine as a child process (`python ../code/serve.py`), so Python and the
engine requirements must be available to Node. Set `PYTHON_BIN` in `.env` if needed.

---

## Workbench features

* **Requests** – Kite-style dashboard: verdict summary strip, paginated table with search and
  filters by status, type and source.
* **Request detail** – the verdict card, 90-day balance chart (minimum-balance floor, deadline and
  payment markers), payment plan, spending changes, seller options, messages and bill images, engine
  notes, and full decision history. Re-run the engine at any time.
* **Ask** – three fields (who, how much, when) with live headroom feedback. Creates an ad-hoc request,
  runs the engine and opens the verdict.
* **Evaluation** – runs the 25 solved samples and shows agreement on status, method, earliest date and
  safe amount, side by side with the expected answers.
* **Advisor** – a chat panel that knows which request is open. It builds a fact sheet from the stored
  decision and answers *why*, *how much today*, *when in full*, *which installment option* and *what
  spending changes* deterministically, or through Claude (`@anthropic-ai/sdk`, model `claude-opus-5`)
  when `ANTHROPIC_API_KEY` is set. Answers never invent numbers that are not in the fact sheet.
* **Accessibility** – skip link, focus rings, labelled controls, table captions, live regions,
  keyboard-closable dialog, colour never used alone, all motion respects `prefers-reduced-motion`.

---

## Repository layout

```
.
├── code/                        Decision engine
│   ├── main.py                  CLI: dataset -> output.csv
│   ├── serve.py                 JSON bridge used by the web app
│   ├── buyorwait/
│   │   ├── data.py              CSV loading, dated FX conversion
│   │   ├── evidence.py          image reader (VLM -> OCR), message template parser (-> LLM)
│   │   ├── forecast.py          recurrence detection, salary projection, daily simulation
│   │   ├── planner.py           candidate plans, spending changes, ranking, explanations
│   │   ├── verify.py            output-contract checks
│   │   └── llm.py               provider-agnostic model client with token accounting
│   ├── evaluation/main.py       scoring, tuning, validation, usage report
│   └── evaluation/usage_report.md
├── web/                         PocketVerdict workbench (see web/README.md)
│   ├── app/                     App Router pages and API routes
│   ├── components/              UI, charts, chat, pagination, motion
│   ├── lib/                     Prisma client, engine bridge, advisor, formatting
│   └── prisma/                  schema + CSV seed
├── dataset/                     Input data (profiles, events, requests, options, messages, images, rates)
└── output.csv                   Verdicts for every request in dataset/requests.csv
```

---

## Configuration and secrets

All secrets come from environment variables or a local `.env` that is git-ignored. Nothing in this
repository contains keys, and model answers are cached as amounts only (`code/cache/`).

| Variable | Used by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` | engine, advisor | optional model providers |
| `BUYORWAIT_LLM`, `BUYORWAIT_MODEL`, `ADVISOR_MODEL` | engine, advisor | mode and model overrides |
| `DATABASE_URL` | web | MySQL or SQLite connection |
| `AUTH_SECRET`, `AUTH_URL` | web | NextAuth |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | seed | demo login |
| `ENGINE_ROOT`, `PYTHON_BIN` | web | where the engine lives and how to run it |

---

## Design principles

* **Deterministic core, models at the edges.** Financial logic never depends on a model; models only
  read evidence, and their output is validated before use.
* **Personalised by data, not by rules of thumb.** Two users with the same balance get different
  verdicts because their commitments, protected categories, accepted methods and flexibility differ.
* **Conservative on income.** Pending credits, bonuses, commissions, refunds, prizes and unrealised
  gains are not cash until they settle.
* **Explainable.** Every number on a verdict can be traced to a row in the dataset or a projected
  series shown in the UI.
