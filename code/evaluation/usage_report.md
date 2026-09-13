# Token usage and cost report

Final full-dataset run that produced `output.csv` (250 requests, 0.7 s wall-clock, generated 2026-09-13 13:02).

## Architecture summary

The decision engine (financial-state reconstruction, 90-day forecast, plan ranking, verification) is deterministic Python and makes **no model calls**. Models are used only for untrusted evidence:

* **Image amounts** (events with a blank `amount`): a vision-language model when an API key is configured, otherwise the bundled offline OCR (`rapidocr_onnxruntime`, ONNX, no network) plus a keyword heuristic.
* **Message interpretation**: rule-based template parser (English + Indonesian); an LLM is consulted only for messages the rules cannot classify.
* **Explanations**: deterministic templates grounded in the computed numbers.

## Model calls in this run

| Provider | Model | Calls | Input tokens | Output tokens | Total tokens | Est. cost (USD) |
|---|---|---:|---:|---:|---:|---:|
| (none - offline OCR + rules) | - | 0 | 0 | 0 | 0 | 0.00 |
| **Overall** | | **0** | **0** | **0** | **0** | **0.0000** |

## Per-request averages

* Requests processed: **250**
* Model calls per request: **0.000**
* Average tokens per request: **0.0** (input 0.0, output 0.0)
* Estimated cost per request: **USD 0.000000**
* Estimated total cost: **USD 0.0000**

## Notes

* Token counts come from the provider usage fields of each response; cached responses (from `code/cache/`) are listed as calls with zero tokens.
* Prices are list prices per 1M tokens at the time of writing and are approximate.
* No API keys, credentials or sensitive configuration values are included in this package.
