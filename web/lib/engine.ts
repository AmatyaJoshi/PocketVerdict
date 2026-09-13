/**
 * Bridge to the Python decision engine (code/serve.py). The engine is the single source of truth for
 * the financial logic; the web app stores and visualises its output.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { prisma } from "./db";

export const ENGINE_ROOT = path.resolve(process.env.ENGINE_ROOT ?? path.join(process.cwd(), ".."));
const PYTHON = process.env.PYTHON_BIN ?? "python";

export type EngineInput =
  | { request_id: string }
  | {
      request_id?: string;
      user_id: string;
      request_date: string;
      request_type: string;
      requested_amount: number;
      desired_completion_date: string;
      allows_partial_payment: boolean;
      request_text?: string;
    };

export interface EngineDecision {
  request_id: string;
  amount_safe_to_pay: string;
  affordability_status: string;
  recommended_payment_method: string;
  payment_plan: string;
  earliest_date_for_full_payment: string;
  spending_changes_needed: string;
  decision_explanation: string;
}

export interface EngineResult {
  error?: string;
  request: {
    request_id: string; user_id: string; request_date: string; request_type: string; requested_amount: number;
    desired_completion_date: string; allows_partial_payment: boolean; request_text: string;
  };
  profile: {
    home_currency: string; balance: number; min_balance: number; methods: string[]; max_installment_months: number | null;
    protect: string[]; reduce_ok: string[]; stop_ok: string[]; priorities: string[];
  };
  decision: EngineDecision;
  problems: string[];
  forecast: {
    start: string; end: string;
    path: { date: string; balance: number }[];
    flows: { date: string; amount: number; kind: string; label: string }[];
    series: { key: string; category: string; flexibility: string; amount: number; period_days: number | null;
      day_of_month: number | null; occurrences: number; last_event_id: string; label: string }[];
    notes: string[];
    adjustments: { kind: string; amount: number | null; currency: string | null; date: string | null; pct: number | null; message_id: string }[];
  };
  payment_options: { payment_option_id: string; payment_method: string; payment_amount: number; number_of_payments: number;
    first_payment_date: string; payment_frequency_days: number | null; financing_fee: number; total_payable_amount: number }[];
  messages: { message_id: string; sent_at: string; source_type: string; related_event_id: string; text: string }[];
  images: { image_id: string; related_event_id: string; path: string }[];
  usage: { per_model: Record<string, { provider: string; model: string; calls: number; input_tokens: number; output_tokens: number; cost_usd: number }>;
    total: { calls: number; input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number } };
}

export function runEngine(input: EngineInput): Promise<EngineResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      /* turbopackIgnore: true */
      PYTHON,
      [path.join(ENGINE_ROOT, "code", "serve.py")],
      { cwd: ENGINE_ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 180_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`engine failed: ${stderr || err.message}`));
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as EngineResult;
          if (parsed.error) return reject(new Error(parsed.error));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`engine returned invalid JSON: ${(e as Error).message}\n${stderr}`));
        }
      },
    );
    child.stdin?.end(JSON.stringify({ ...input, llm: process.env.BUYORWAIT_LLM ?? "auto" }));
  });
}

/** Runs the engine for a stored request and persists the decision (latest wins in the UI). */
export async function decideAndStore(requestId: string, userId?: string) {
  const req = await prisma.financeRequest.findUniqueOrThrow({ where: { requestId } });
  const input: EngineInput = req.source === "adhoc"
    ? {
        request_id: req.requestId, user_id: req.userId, request_date: req.requestDate.toISOString().slice(0, 10),
        request_type: req.requestType, requested_amount: req.requestedAmount,
        desired_completion_date: req.desiredCompletionDate.toISOString().slice(0, 10),
        allows_partial_payment: req.allowsPartialPayment, request_text: req.requestText,
      }
    : { request_id: requestId };
  const result = await runEngine(input);
  const d = result.decision;
  const providers = Object.keys(result.usage?.per_model ?? {});
  const saved = await prisma.decision.create({
    data: {
      requestId, amountSafeToPay: Number(d.amount_safe_to_pay), affordabilityStatus: d.affordability_status,
      recommendedPaymentMethod: d.recommended_payment_method, paymentPlan: d.payment_plan,
      earliestDateForFullPayment: d.earliest_date_for_full_payment || null, spendingChangesNeeded: d.spending_changes_needed,
      decisionExplanation: d.decision_explanation, engineJson: JSON.stringify(result),
      llmProvider: providers.length ? providers.join(",") : "offline", createdById: userId ?? null,
    },
  });
  return { saved, result };
}
