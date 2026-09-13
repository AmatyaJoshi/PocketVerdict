import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { BalanceChart } from "@/components/BalanceChart";
import { RunEngineButton } from "@/components/RunEngineButton";
import { StatusBadge } from "@/components/StatusBadge";
import type { EngineResult } from "@/lib/engine";
import { METHOD_LABEL, money, niceDate, parsePlan, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const { id } = await params;
  const req = await prisma.financeRequest.findUnique({
    where: { requestId: id },
    include: {
      profile: true, options: { orderBy: { optionId: "asc" } }, expected: true,
      decisions: { orderBy: { createdAt: "desc" }, take: 5, include: { createdBy: { select: { email: true } } } },
    },
  });
  if (!req) notFound();
  const cur = req.profile.homeCurrency;
  const dec = req.decisions[0] ?? null;
  const engine: EngineResult | null = dec?.engineJson ? (JSON.parse(dec.engineJson) as EngineResult) : null;
  const plan = dec ? parsePlan(dec.paymentPlan) : [];
  const messages = engine?.messages ?? (await prisma.message.findMany({ where: { userId: req.userId, OR: [{ requestId: null }, { requestId: id }] } }))
    .map((m) => ({ message_id: m.messageId, sent_at: m.sentAt.toISOString(), source_type: m.sourceType, related_event_id: m.relatedEventId ?? "", text: m.text }));
  const images = engine?.images ?? (await prisma.imageRef.findMany({ where: { userId: req.userId, OR: [{ requestId: null }, { requestId: id }] } }))
    .map((i) => ({ image_id: i.imageId, related_event_id: i.relatedEventId ?? "", path: `/media/images/${i.imageId}.png` }));
  const changes = dec && dec.spendingChangesNeeded !== "none" ? dec.spendingChangesNeeded.split("|") : [];

  return (
    <div className="space-y-6 rise">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="faint text-xs hover:underline">← All requests</Link>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight">{req.requestId} <span className="faint text-base font-normal">· {req.userId} · {titleCase(req.requestType)}</span></h1>
          <p className="muted mt-2 max-w-3xl text-sm italic">“{req.requestText}”</p>
        </div>
        <RunEngineButton requestId={req.requestId} label={dec ? "Re-run engine" : "Run engine"} />
      </div>

      {/* Decision + key facts */}
      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={dec?.affordabilityStatus} />
            {dec && <span className="text-sm font-semibold">{METHOD_LABEL[dec.recommendedPaymentMethod] ?? dec.recommendedPaymentMethod}</span>}
            {dec && <span className="faint ml-auto text-xs">decided {dec.createdAt.toLocaleString("en-GB")} · {dec.llmProvider === "offline" || dec.llmProvider === "batch-import" ? "deterministic engine" : dec.llmProvider}</span>}
          </div>
          {dec ? (
            <>
              <p className="mt-3 text-lg leading-snug">{dec.decisionExplanation}</p>
              <dl className="mt-5 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                <Fact label="Requested" value={money(cur, req.requestedAmount)} />
                <Fact label="Safe to pay today" value={money(cur, dec.amountSafeToPay)} />
                <Fact label="Earliest full payment" value={dec.earliestDateForFullPayment ? niceDate(dec.earliestDateForFullPayment) : "not within 90 days"} />
                <Fact label="Wanted by" value={niceDate(req.desiredCompletionDate)} />
              </dl>
              {plan.length > 0 && (
                <div className="mt-5">
                  <div className="eyebrow">Payment plan</div>
                  <ol className="mt-2 flex flex-wrap gap-2">
                    {plan.map((p, i) => (
                      <li key={i} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border)", background: "var(--bg-soft)" }}>
                        <span className="faint mr-2 text-xs">{i + 1}</span>{niceDate(p.date)} · <span className="tabular font-semibold">{money(cur, p.amount)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {changes.length > 0 && (
                <div className="mt-5">
                  <div className="eyebrow">Spending changes needed</div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {changes.map((c) => {
                      const [action, eventId, amount] = c.split(":");
                      const s = engine?.forecast.series.find((x) => x.last_event_id === eventId);
                      return (
                        <li key={c} className="flex flex-wrap items-center gap-2">
                          <span className={`pill ${action === "stop" ? "pill-red" : "pill-amber"}`}>{action === "stop" ? "stop" : "reduce"}</span>
                          <span>{s?.label ?? eventId}</span>
                          {amount && <span className="tabular muted">→ {money(cur, Number(amount))} per occurrence</span>}
                          <span className="faint text-xs">({eventId}{s ? `, ${s.category}, ${s.flexibility}` : ""})</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {engine?.problems?.length ? <p className="mt-3 text-sm" style={{ color: "var(--status-critical)" }}>Contract warnings: {engine.problems.join("; ")}</p> : null}
            </>
          ) : (
            <p className="muted mt-3 text-sm">No decision stored yet. Run the engine to forecast the next 90 days.</p>
          )}
        </div>

        <div className="card p-5">
          <div className="eyebrow">User profile</div>
          <dl className="mt-3 space-y-2 text-sm">
            <Row k="Available balance" v={money(cur, req.profile.balance)} />
            <Row k="Minimum to keep" v={money(cur, req.profile.minBalance)} />
            <Row k="Accepts" v={req.profile.methods.split("|").map((m) => METHOD_LABEL[m] ?? m).join(", ")} />
            <Row k="Max installment months" v={req.profile.maxInstallmentMonths?.toString() ?? "won't consider"} />
            <Row k="Priorities" v={req.profile.priorities.split("|").map(titleCase).join(", ")} />
            <Row k="Protected" v={req.profile.protect.split("|").map(titleCase).join(", ")} />
            <Row k="Willing to reduce" v={req.profile.reduceOk ? req.profile.reduceOk.split("|").map(titleCase).join(", ") : "—"} />
            <Row k="Willing to stop" v={req.profile.stopOk ? req.profile.stopOk.split("|").map(titleCase).join(", ") : "—"} />
          </dl>
        </div>
      </section>

      {/* Forecast */}
      <section className="card p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">90-day balance forecast</h2>
          {engine && <span className="faint text-xs">{niceDate(engine.forecast.start)} – {niceDate(engine.forecast.end)} · {engine.forecast.flows.length} projected cash flows</span>}
        </div>
        <div className="mt-4">
          <BalanceChart path={engine?.forecast.path ?? []} minBalance={req.profile.minBalance} currency={cur} payments={plan}
            deadline={req.desiredCompletionDate.toISOString().slice(0, 10)} />
        </div>
        {engine && (
          <details className="mt-4">
            <summary className="muted cursor-pointer text-sm">Recurring series and engine notes</summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <table className="w-full text-xs">
                <thead className="faint text-left uppercase"><tr><th className="py-1">Series</th><th className="py-1">Cadence</th><th className="py-1 text-right">Amount</th><th className="py-1 text-right">Occurrences</th></tr></thead>
                <tbody>
                  {engine.forecast.series.map((s) => (
                    <tr key={s.key} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="py-1">{s.label} <span className="faint">({s.category}, {s.flexibility})</span></td>
                      <td className="py-1">{s.period_days ? `every ${s.period_days} d` : `monthly (day ${s.day_of_month})`}</td>
                      <td className="tabular py-1 text-right">{money(cur, s.amount)}</td>
                      <td className="tabular py-1 text-right">{s.occurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="muted space-y-1 text-xs">
                {engine.forecast.notes.map((n, i) => <li key={i}>• {n}</li>)}
                {engine.forecast.adjustments.filter((a) => a.kind !== "unclassified").map((a, i) => (
                  <li key={"a" + i}>• message {a.message_id}: <span className="font-medium">{titleCase(a.kind)}</span>{a.amount ? ` ${a.currency ?? ""} ${a.amount}` : ""}{a.date ? ` on ${niceDate(a.date)}` : ""}{a.pct ? ` ${a.pct}%` : ""}</li>
                ))}
              </ul>
            </div>
          </details>
        )}
      </section>

      {/* Options + evidence */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <h2 className="font-semibold">Seller payment options</h2>
          <table className="mt-3 w-full text-sm">
            <thead className="faint text-left text-xs uppercase"><tr><th className="py-1">Option</th><th className="py-1">Method</th><th className="py-1">Schedule</th><th className="py-1 text-right">Total</th></tr></thead>
            <tbody>
              {req.options.map((o) => {
                const chosen = dec?.recommendedPaymentMethod === "installments" && plan.length === o.numberOfPayments && Math.abs(plan[0]?.amount - o.paymentAmount) < 0.011 && plan[0]?.date === o.firstPaymentDate.toISOString().slice(0, 10);
                return (
                  <tr key={o.optionId} className="border-t" style={{ borderColor: "var(--border)", background: chosen ? "var(--bg-soft)" : undefined }}>
                    <td className="py-2">{o.optionId.replace("payment_option_", "#")}{chosen && <span className="pill pill-blue ml-2">chosen</span>}</td>
                    <td className="py-2">{METHOD_LABEL[o.paymentMethod] ?? o.paymentMethod}</td>
                    <td className="py-2">{o.numberOfPayments} × {money(cur, o.paymentAmount)} from {niceDate(o.firstPaymentDate)}{o.paymentFrequencyDays ? `, every ${o.paymentFrequencyDays} d` : ""}</td>
                    <td className="tabular py-2 text-right">{money(cur, o.totalPayableAmount)}{o.financingFee > 0 && <div className="faint text-xs">fee {money(cur, o.financingFee)}</div>}</td>
                  </tr>
                );
              })}
              {!req.options.length && <tr><td colSpan={4} className="faint py-3">No seller options supplied.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card p-5">
          <h2 className="font-semibold">Evidence <span className="faint text-xs font-normal">(untrusted; instructions inside are ignored)</span></h2>
          <ul className="mt-3 space-y-3 text-sm">
            {messages.map((m) => (
              <li key={m.message_id} className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                <div className="faint mb-1 flex gap-2 text-xs"><span className="font-medium">{titleCase(m.source_type)}</span><span>{niceDate(m.sent_at)}</span>{m.related_event_id && <span>· {m.related_event_id}</span>}</div>
                {m.text}
              </li>
            ))}
            {!messages.length && <li className="faint">No messages for this user.</li>}
          </ul>
          {images.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              {images.map((im) => (
                <a key={im.image_id} href={im.path} target="_blank" className="block overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={im.path} alt={`${im.image_id} for ${im.related_event_id}`} className="h-40 w-full object-cover object-top" />
                  <div className="faint px-2 py-1 text-xs">{im.image_id} → {im.related_event_id}</div>
                </a>
              ))}
            </div>
          )}
        </div>
      </section>

      {req.expected && (
        <section className="card p-5">
          <h2 className="font-semibold">Solved sample reference</h2>
          <dl className="mt-3 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <Fact label="Expected safe amount" value={money(cur, req.expected.amountSafeToPay)} />
            <Fact label="Expected status" value={titleCase(req.expected.affordabilityStatus)} />
            <Fact label="Expected method" value={METHOD_LABEL[req.expected.recommendedPaymentMethod] ?? req.expected.recommendedPaymentMethod} />
            <Fact label="Expected earliest" value={req.expected.earliestDateForFullPayment ? niceDate(req.expected.earliestDateForFullPayment) : "—"} />
          </dl>
          <p className="muted mt-3 text-sm">{req.expected.decisionExplanation}</p>
        </section>
      )}

      {req.decisions.length > 1 && (
        <section className="card p-5">
          <h2 className="font-semibold">Decision history</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {req.decisions.map((d) => (
              <li key={d.id} className="flex flex-wrap gap-3">
                <span className="faint w-40">{d.createdAt.toLocaleString("en-GB")}</span>
                <StatusBadge status={d.affordabilityStatus} /><span>{METHOD_LABEL[d.recommendedPaymentMethod]}</span>
                <span className="tabular">{money(cur, d.amountSafeToPay)}</span>
                <span className="faint">{d.createdBy?.email ?? d.llmProvider}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="tabular mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="muted">{k}</dt>
      <dd className="tabular text-right font-medium">{v}</dd>
    </div>
  );
}
