/**
 * Advisor chatbot. Grounded strictly in stored decisions:
 *  1. resolve which request the question is about (explicit id in the text, page context, or user id)
 *  2. build a compact fact sheet from the database
 *  3. answer with Claude when ANTHROPIC_API_KEY is configured, otherwise with a deterministic
 *     template answerer that covers the common questions (why, how much, when, installments, changes).
 */
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";
import type { EngineResult } from "./engine";
import { METHOD_LABEL, STATUS_LABEL, money, niceDate, parsePlan, titleCase } from "./format";

export interface ChatTurn { role: "user" | "assistant"; text: string }
export interface Answer { answer: string; links?: { label: string; href: string }[]; mode: "claude" | "rules" }

async function loadContext(requestId: string) {
  const req = await prisma.financeRequest.findUnique({
    where: { requestId },
    include: { profile: true, options: true, expected: true, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!req) return null;
  const dec = req.decisions[0] ?? null;
  const engine: EngineResult | null = dec?.engineJson ? (JSON.parse(dec.engineJson) as EngineResult) : null;
  return { req, dec, engine };
}
type Ctx = NonNullable<Awaited<ReturnType<typeof loadContext>>>;

function factSheet({ req, dec, engine }: Ctx): string {
  const cur = req.profile.homeCurrency;
  const lines = [
    `Request ${req.requestId} by ${req.userId}: ${titleCase(req.requestType)} of ${money(cur, req.requestedAmount)}, decided on ${niceDate(req.requestDate)}, wanted by ${niceDate(req.desiredCompletionDate)}, partial payment ${req.allowsPartialPayment ? "allowed" : "not allowed"} by the seller.`,
    `Question asked: "${req.requestText}"`,
    `Profile: available ${money(cur, req.profile.balance)}, minimum to keep ${money(cur, req.profile.minBalance)}, accepts ${req.profile.methods.split("|").map((m) => METHOD_LABEL[m] ?? m).join(", ")}${req.profile.maxInstallmentMonths ? `, max ${req.profile.maxInstallmentMonths} installment months` : ", will not consider installments"}. Protected categories: ${req.profile.protect}. Willing to reduce: ${req.profile.reduceOk || "none"}. Willing to stop: ${req.profile.stopOk || "none"}.`,
  ];
  if (dec) {
    lines.push(`Decision: status ${STATUS_LABEL[dec.affordabilityStatus]}, recommendation ${METHOD_LABEL[dec.recommendedPaymentMethod]}, safe to pay today ${money(cur, dec.amountSafeToPay)}, earliest safe full payment ${dec.earliestDateForFullPayment ? niceDate(dec.earliestDateForFullPayment) : "not within the 90-day forecast"}, payment plan ${dec.paymentPlan}, spending changes ${dec.spendingChangesNeeded}. Explanation: ${dec.decisionExplanation}`);
  } else {
    lines.push("Decision: none stored yet (engine not run).");
  }
  if (engine) {
    const minPoint = engine.forecast.path.reduce((a, b) => (b.balance < a.balance ? b : a));
    lines.push(`Forecast ${engine.forecast.start} to ${engine.forecast.end}: lowest projected balance ${money(cur, minPoint.balance)} on ${niceDate(minPoint.date)} (before the request). Recurring series: ${engine.forecast.series.map((s) => `${s.label} ${money(cur, s.amount)} ${s.period_days ? `every ${s.period_days}d` : `monthly d${s.day_of_month}`} x${s.occurrences} [${s.flexibility}]`).join("; ")}.`);
    const salary = engine.forecast.flows.filter((f) => f.kind === "salary");
    if (salary.length) lines.push(`Income counted: ${salary.map((f) => `${money(cur, f.amount)} on ${niceDate(f.date)}`).join(", ")}.`);
    if (engine.forecast.notes.length) lines.push(`Engine notes: ${engine.forecast.notes.slice(0, 8).join(" | ")}`);
    if (engine.forecast.adjustments.length) lines.push(`Evidence used: ${engine.forecast.adjustments.filter((a) => a.kind !== "unclassified").map((a) => `${a.message_id}=${a.kind}${a.amount ? ` ${a.currency ?? ""} ${a.amount}` : ""}${a.date ? ` ${a.date}` : ""}`).join("; ") || "none relevant"}.`);
  }
  if (req.options.length) {
    lines.push(`Seller options: ${req.options.map((o) => `${o.optionId}: ${METHOD_LABEL[o.paymentMethod]} ${o.numberOfPayments} x ${money(cur, o.paymentAmount)} from ${niceDate(o.firstPaymentDate)} (total ${money(cur, o.totalPayableAmount)}, fee ${money(cur, o.financingFee)})`).join("; ")}.`);
  }
  if (req.expected) lines.push(`Solved-sample reference answer: ${req.expected.affordabilityStatus} / ${req.expected.recommendedPaymentMethod}, safe ${req.expected.amountSafeToPay}, earliest ${req.expected.earliestDateForFullPayment || "none"}.`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ resolve which request */
export async function resolveRequestId(message: string, pageRequestId?: string): Promise<string | undefined> {
  const m = message.match(/\b(request_\d+|adhoc_[a-z0-9]+)\b/i);
  if (m) return m[1].toLowerCase();
  const u = message.match(/\buser_(\d+)\b/i);
  if (u) {
    const latest = await prisma.financeRequest.findFirst({ where: { userId: `user_${u[1]}` }, orderBy: { createdAt: "desc" } });
    if (latest) return latest.requestId;
  }
  return pageRequestId;
}

/* ------------------------------------------------------------------ deterministic answers */
function rulesAnswer(q: string, ctx: Ctx): string {
  const { req, dec, engine } = ctx;
  const cur = req.profile.homeCurrency;
  const l = q.toLowerCase();
  if (!dec) return `No decision has been stored for ${req.requestId} yet. Open the request and press “Run engine” and I can walk you through the result.`;
  const plan = parsePlan(dec.paymentPlan);
  const minPoint = engine?.forecast.path.reduce((a, b) => (b.balance < a.balance ? b : a));
  const headroom = minPoint ? money(cur, Math.max(0, minPoint.balance - req.profile.minBalance)) : money(cur, dec.amountSafeToPay);

  if (/(how much|safe (to )?pay|today|afford now|right now)/.test(l)) {
    return `${req.userId} can safely pay ${money(cur, dec.amountSafeToPay)} today toward the ${money(cur, req.requestedAmount)} request.${minPoint ? ` The 90-day forecast bottoms out at ${money(cur, minPoint.balance)} on ${niceDate(minPoint.date)}, which leaves ${headroom} above the ${money(cur, req.profile.minBalance)} minimum.` : ""}`;
  }
  if (/(when|earliest|full payment|wait)/.test(l)) {
    return dec.earliestDateForFullPayment
      ? `The earliest date the full ${money(cur, req.requestedAmount)} is safe as one payment is ${niceDate(dec.earliestDateForFullPayment)}${engine?.forecast.flows.some((f) => f.kind === "salary" && f.date === dec.earliestDateForFullPayment) ? " (a salary day)" : ""}.${new Date(dec.earliestDateForFullPayment) > req.desiredCompletionDate ? ` That is after the ${niceDate(req.desiredCompletionDate)} target date.` : " That is on or before the target date."}`
      : `Within the 90-day forecast there is no date on which the full ${money(cur, req.requestedAmount)} can be paid while keeping ${money(cur, req.profile.minBalance)} in reserve. Income ${engine?.forecast.flows.some((f) => f.kind === "salary") ? "is counted, but it doesn’t create enough room" : "isn’t confirmed for this period"}.`;
  }
  if (/(installment|emi|instalment|option)/.test(l)) {
    const inst = req.options.filter((o) => o.paymentMethod === "installments");
    if (!inst.length) return "The seller did not offer any installment option for this request.";
    const chosen = dec.recommendedPaymentMethod === "installments" ? plan : null;
    const eligible = req.profile.methods.includes("installments");
    return `${inst.length} installment option${inst.length > 1 ? "s were" : " was"} offered: ${inst.map((o) => `${o.numberOfPayments} × ${money(cur, o.paymentAmount)} (total ${money(cur, o.totalPayableAmount)})`).join("; ")}. ${!eligible ? `${req.userId} does not accept installments, so they were not considered.` : req.profile.maxInstallmentMonths ? `Only plans of at most ${req.profile.maxInstallmentMonths} payments fit the user’s limit.` : ""} ${chosen ? `The recommendation uses ${chosen.length} payments of ${money(cur, chosen[0].amount)} starting ${niceDate(chosen[0].date)} because it completes by the deadline at the lowest total cost among safe plans.` : `The recommendation is ${METHOD_LABEL[dec.recommendedPaymentMethod]} instead, which ranks higher (deadline first, then no spending changes, then lowest total cost).`}`;
  }
  if (/(spending|stop|reduce|cut|change)/.test(l)) {
    if (dec.spendingChangesNeeded === "none") return "No spending changes are needed for this recommendation. The engine only proposes changes to flexible, non-protected expenses the user is willing to adjust, and only when no plan works without them.";
    const parts = dec.spendingChangesNeeded.split("|").map((c) => {
      const [a, id, amt] = c.split(":");
      const s = engine?.forecast.series.find((x) => x.last_event_id === id);
      return a === "stop" ? `stop the ${s?.label ?? id}` : `reduce the ${s?.label ?? id} to ${money(cur, Number(amt))}`;
    });
    return `To make the plan safe the user should ${parts.join(" and ")}. These are the least disruptive changes among the categories ${req.userId} is willing to adjust (reduce: ${req.profile.reduceOk || "none"}; stop: ${req.profile.stopOk || "none"}).`;
  }
  if (/(why|reason|because|explain|not affordable|risk)/.test(l)) {
    return `${dec.decisionExplanation} In short: the forecast projects every recurring bill, pending debit and confirmed salary for 90 days and requires the balance to stay above ${money(cur, req.profile.minBalance)} on every day.${minPoint ? ` The tightest day is ${niceDate(minPoint.date)} at ${money(cur, minPoint.balance)}.` : ""} Status: ${STATUS_LABEL[dec.affordabilityStatus]}; recommendation: ${METHOD_LABEL[dec.recommendedPaymentMethod]}.`;
  }
  if (/(income|salary|paid|payday)/.test(l)) {
    const sal = engine?.forecast.flows.filter((f) => f.kind === "salary") ?? [];
    return sal.length ? `Income counted in the forecast: ${sal.map((f) => `${money(cur, f.amount)} on ${niceDate(f.date)}`).join(", ")}. Pending bonuses, commissions, refunds and prizes are not counted until they settle.` : "No confirmed or regular salary is projected for this user in the forecast window, so only the current balance carries the plan.";
  }
  return `${req.requestId}: ${STATUS_LABEL[dec.affordabilityStatus]} — ${METHOD_LABEL[dec.recommendedPaymentMethod]}. ${dec.decisionExplanation} Ask me “why”, “how much today”, “when can I pay in full”, “which installment option”, or “what spending changes”.`;
}

/* ------------------------------------------------------------------ Claude */
const SYSTEM = `You are the PocketVerdict advisor inside a personal-finance workbench (PocketVerdict answers "buy or wait?"). Answer the analyst's question about one affordability decision using ONLY the fact sheet provided. Be concise (2-5 sentences), concrete with numbers and dates, and plain-spoken. Never invent income, expenses or options that are not in the fact sheet. If the fact sheet lacks the answer, say so and suggest running the engine or opening the request page. Do not give generic financial advice beyond the decision.`;

async function claudeAnswer(q: string, history: ChatTurn[], sheet: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-8).map((h) => ({ role: h.role, content: h.text }) as Anthropic.MessageParam),
    { role: "user", content: `Fact sheet:\n${sheet}\n\nQuestion: ${q}` },
  ];
  const response = await client.messages.create({
    model: process.env.ADVISOR_MODEL ?? "claude-opus-5",
    max_tokens: 1024,
    system: SYSTEM,
    output_config: { effort: "low" },
    messages,
  });
  if (response.stop_reason === "refusal") return null;
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || null;
}

/* ------------------------------------------------------------------ entry */
export async function answer(message: string, history: ChatTurn[], pageRequestId?: string): Promise<Answer> {
  const requestId = await resolveRequestId(message, pageRequestId);
  if (!requestId) {
    const n = await prisma.financeRequest.count();
    return {
      mode: "rules",
      answer: `I answer questions about a specific decision. Open a request page or mention an id like request_26 or user_26 in your question. There are ${n} requests loaded.`,
      links: [{ label: "Browse requests", href: "/" }, { label: "Ask a new question", href: "/ask" }],
    };
  }
  const ctx = await loadContext(requestId);
  if (!ctx) return { mode: "rules", answer: `I couldn't find ${requestId}.`, links: [{ label: "Browse requests", href: "/" }] };
  const sheet = factSheet(ctx);
  const links = [{ label: `Open ${requestId}`, href: `/requests/${requestId}` }];
  try {
    const c = await claudeAnswer(message, history, sheet);
    if (c) return { mode: "claude", answer: c, links };
  } catch (e) {
    console.warn("[advisor] Claude call failed, using rules:", (e as Error).message);
  }
  return { mode: "rules", answer: rulesAnswer(message, ctx), links };
}
