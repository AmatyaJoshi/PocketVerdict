"""Optional LLM / VLM layer with usage accounting.

Providers are selected from environment variables only (never hardcoded):
  * ANTHROPIC_API_KEY  -> Anthropic Messages API (default model: claude-sonnet-5)
  * OPENAI_API_KEY     -> OpenAI chat completions (default model: gpt-4o-mini)
  * GOOGLE_API_KEY / GEMINI_API_KEY -> Gemini (default model: gemini-2.0-flash)

BUYORWAIT_LLM = off | auto | on   (default: auto = use a provider if a key is present)
BUYORWAIT_MODEL overrides the model name.

Every call is recorded so evaluation/usage_report.md can be generated from the real run.
All model output is treated as untrusted data: it is parsed into a narrow JSON schema and
validated by the deterministic engine before it can influence any number.
"""
from __future__ import annotations

import base64
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

# Approximate list prices in USD per 1M tokens (input, output), used only for the report.
PRICES = {
    "claude-sonnet-5": (3.0, 15.0),
    "claude-opus-5": (15.0, 75.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.0),
    "gemini-2.0-flash": (0.10, 0.40),
}


@dataclass
class Usage:
    calls: list[dict] = field(default_factory=list)

    def record(self, provider: str, model: str, purpose: str, inp: int, out: int, seconds: float, cached: bool = False):
        self.calls.append({"provider": provider, "model": model, "purpose": purpose,
                           "input_tokens": inp, "output_tokens": out, "seconds": round(seconds, 2),
                           "cached": cached})

    def summary(self) -> dict:
        per_model: dict[str, dict] = {}
        for c in self.calls:
            k = f"{c['provider']}/{c['model']}"
            m = per_model.setdefault(k, {"provider": c["provider"], "model": c["model"], "calls": 0,
                                         "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0})
            m["calls"] += 1
            m["input_tokens"] += c["input_tokens"]
            m["output_tokens"] += c["output_tokens"]
            pi, po = PRICES.get(c["model"], (3.0, 15.0))
            m["cost_usd"] += c["input_tokens"] / 1e6 * pi + c["output_tokens"] / 1e6 * po
        tot = {"calls": sum(m["calls"] for m in per_model.values()),
               "input_tokens": sum(m["input_tokens"] for m in per_model.values()),
               "output_tokens": sum(m["output_tokens"] for m in per_model.values()),
               "cost_usd": sum(m["cost_usd"] for m in per_model.values())}
        tot["total_tokens"] = tot["input_tokens"] + tot["output_tokens"]
        return {"per_model": per_model, "total": tot}


class LLM:
    """Thin provider-agnostic client. `available` is False when no key is configured."""

    def __init__(self, mode: Optional[str] = None, cache_path: Optional[Path] = None):
        self.mode = (mode or os.environ.get("BUYORWAIT_LLM", "auto")).lower()
        self.usage = Usage()
        self.provider = None
        self.model = os.environ.get("BUYORWAIT_MODEL")
        self.cache_path = cache_path
        self.cache: dict[str, Any] = {}
        if cache_path and cache_path.exists():
            try:
                self.cache = json.loads(cache_path.read_text(encoding="utf-8"))
            except Exception:
                self.cache = {}
        if self.mode == "off":
            return
        if os.environ.get("ANTHROPIC_API_KEY"):
            self.provider = "anthropic"
            self.model = self.model or "claude-sonnet-5"
        elif os.environ.get("OPENAI_API_KEY"):
            self.provider = "openai"
            self.model = self.model or "gpt-4o-mini"
        elif os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"):
            self.provider = "gemini"
            self.model = self.model or "gemini-2.0-flash"
        elif self.mode == "on":
            raise RuntimeError("BUYORWAIT_LLM=on but no API key found in the environment.")

    @property
    def available(self) -> bool:
        return self.provider is not None

    # ----------------------------------------------------------------- helpers
    def _save_cache(self):
        if self.cache_path:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(json.dumps(self.cache, indent=1, ensure_ascii=False), encoding="utf-8")

    @staticmethod
    def _extract_json(text: str) -> Optional[dict]:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except Exception:
            return None

    # ----------------------------------------------------------------- calls
    def json_call(self, purpose: str, system: str, user: str, image_path: Optional[Path] = None,
                  cache_key: Optional[str] = None, max_tokens: int = 400) -> Optional[dict]:
        if not self.available:
            return None
        key = cache_key or f"{purpose}:{hash(system + user + str(image_path))}"
        if key in self.cache:
            c = self.cache[key]
            self.usage.record(self.provider, self.model, purpose, 0, 0, 0.0, cached=True)
            return c
        t0 = time.time()
        img_b64 = None
        if image_path is not None:
            img_b64 = base64.b64encode(Path(image_path).read_bytes()).decode()
        try:
            if self.provider == "anthropic":
                text, inp, out = self._anthropic(system, user, img_b64, max_tokens)
            elif self.provider == "openai":
                text, inp, out = self._openai(system, user, img_b64, max_tokens)
            else:
                text, inp, out = self._gemini(system, user, image_path, max_tokens)
        except Exception as exc:  # never let the model layer break the deterministic run
            print(f"[llm] {purpose} failed: {exc}")
            return None
        self.usage.record(self.provider, self.model, purpose, inp, out, time.time() - t0)
        parsed = self._extract_json(text or "")
        if parsed is not None:
            self.cache[key] = parsed
            self._save_cache()
        return parsed

    def _anthropic(self, system, user, img_b64, max_tokens):
        import anthropic  # type: ignore
        client = anthropic.Anthropic()
        content: list[dict] = []
        if img_b64:
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img_b64}})
        content.append({"type": "text", "text": user})
        resp = client.messages.create(model=self.model, max_tokens=max_tokens, temperature=0, system=system,
                                      messages=[{"role": "user", "content": content}])
        text = "".join(getattr(b, "text", "") for b in resp.content)
        return text, resp.usage.input_tokens, resp.usage.output_tokens

    def _openai(self, system, user, img_b64, max_tokens):
        from openai import OpenAI  # type: ignore
        client = OpenAI()
        content: list[dict] = [{"type": "text", "text": user}]
        if img_b64:
            content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}})
        resp = client.chat.completions.create(model=self.model, temperature=0, max_tokens=max_tokens,
                                              messages=[{"role": "system", "content": system},
                                                        {"role": "user", "content": content}])
        u = resp.usage
        return resp.choices[0].message.content, u.prompt_tokens, u.completion_tokens

    def _gemini(self, system, user, image_path, max_tokens):
        import google.generativeai as genai  # type: ignore
        genai.configure(api_key=os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"))
        model = genai.GenerativeModel(self.model, system_instruction=system)
        parts: list[Any] = [user]
        if image_path is not None:
            parts.append({"mime_type": "image/png", "data": Path(image_path).read_bytes()})
        resp = model.generate_content(parts, generation_config={"temperature": 0, "max_output_tokens": max_tokens})
        um = getattr(resp, "usage_metadata", None)
        return resp.text, getattr(um, "prompt_token_count", 0), getattr(um, "candidates_token_count", 0)
