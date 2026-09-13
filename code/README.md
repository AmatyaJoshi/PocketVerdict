# Buy or Wait? — AI-powered affordability agent

Solution for the HackerRank Orchestrate (September 2026) challenge. For every request in
`dataset/requests.csv` the agent reconstructs the user's financial position, forecasts the next
90 days, and recommends `full_payment`, `partial_payment`, `installments`, `wait` or
`not_recommended`, writing `output.csv` with the exact required schema.

## Quick start

```bash
# from the repository root (the folder that contains dataset/ and code/)
pip install -r code/requirements.txt
python code/main.py                 # -> output.csv (250 rows)
python code/evaluation/main.py      # score against dataset/sample_requests.csv
python code/evaluation/main.py --validate output.csv   # contract checks
```

Python 3.10+ is required. The run is fully deterministic and works **offline**: image amounts are
read with a bundled ONNX OCR model (`rapidocr_onnxruntime`) and messages are parsed with template
rules. If an API key is present in the environment the same pipeline uses a vision-language model
for the images and an LLM for any message the rules cannot classify.

### Optional model providers (environment variables only)

| Variable | Provider | Default model |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | `claude-sonnet-5` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o-mini` |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | Google | `gemini-2.0-flash` |

`BUYORWAIT_LLM=off|auto|on` (default `auto`), `BUYORWAIT_MODEL=<model id>` to override.
A `.env` file in the repository root is loaded when `python-dotenv` is installed. No secret is
ever written to disk or to the log; model answers are cached in `code/cache/` (amounts only).

## How it works

```
requests.csv ─┐
profiles ─────┤   1. normalise events      currency conversion (dated rates, stated direction),
events ───────┤                            blank amounts from images, drop cancelled / non-cash /
rates ────────┤                            unrealised rows, exclude internal transfers
messages ─────┤   2. evidence              template parser (EN + ID) -> structured adjustments
images ───────┤                            (salary raised/cut/moved/ended, first salary, arrears,
options ──────┘                             approved invoice, rent +12 %, pending refunds ...)
                  3. forecast (90 days)    reserve pending/scheduled debits; count confirmed salary
                                           on its settlement date; project recurring series found in
                                           history (cadence + amount statistic); never count pending
                                           credits, bonuses, commissions, refunds, prizes, gains
                  4. safety check          daily balance must stay >= minimum_balance_to_keep
                                           amount_safe_to_pay = trough - minimum (capped)
                                           earliest_date_for_full_payment = first D whose suffix-min
                                           still clears minimum + requested_amount
                  5. plans + ranking       full / wait / partial / each installment option
                                           (max_installment_months, user's accepted methods,
                                           schedule simulated); spending changes only on flexible,
                                           non-protected series the user is willing to change -
                                           the least disruptive combination (<= 3) that works
                                           ranking: deadline > no changes > total cost > earlier
                                           start > fewer payments > lowest option id
                  6. verify + explain      contract checks (bounds, plan shapes, option match,
                                           flexible-only changes) and a grounded explanation
```

Key files:

| Path | Purpose |
|---|---|
| `code/main.py` | CLI entry point, orchestration, CSV writer |
| `code/buyorwait/data.py` | dataset loading, dated FX conversion |
| `code/buyorwait/evidence.py` | image reader (VLM → OCR fallback) and message parser (rules → LLM fallback) |
| `code/buyorwait/forecast.py` | event normalisation, recurrence detection, salary projection, daily simulation |
| `code/buyorwait/planner.py` | candidate plans, spending changes, ranking, formatting, explanations |
| `code/buyorwait/verify.py` | deterministic output-contract checks |
| `code/buyorwait/llm.py` | provider-agnostic model client with token accounting |
| `code/evaluation/main.py` | sample scoring, knob tuning, output validation, usage-report generator |
| `code/evaluation/usage_report.md` | token / cost report of the final full-dataset run |

## Evaluation workflow

* `python code/evaluation/main.py` runs the agent on the 25 solved samples and reports exact / close
  matches for `amount_safe_to_pay`, and agreement on status, method, plan, earliest date and
  spending changes.
* `python code/evaluation/main.py --tune` grid-searches the forecaster knobs (amount statistic,
  same-day handling, horizon, failed-debit reservation, ...) on the samples.
* `python code/evaluation/main.py --validate output.csv` checks every row of a produced file against
  the contract (250 rows, header order, bounds, partial/installment rules, flexible-only changes).
* `python code/evaluation/main.py --usage-report` regenerates `evaluation/usage_report.md` from the
  usage recorded by the last `main.py` run.

## Design notes

* Messages and images are untrusted. They are reduced to a narrow schema (an amount, a date, a
  percentage, a kind) and validated before use; embedded instructions are never executed.
* Conflicts are resolved in the order required by the statement: explicit cancellation / settlement /
  amendment, newer record from the same source, settled over estimate, then the safer reading.
* No organiser-only files, no hardcoded labels: `sample_requests.csv` is used only to calibrate the
  forecaster knobs and to score the evaluation workflow.
