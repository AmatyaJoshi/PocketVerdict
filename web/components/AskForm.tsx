"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { money } from "@/lib/format";

const TYPES = ["purchase", "travel", "education", "family_transfer", "debt_repayment", "investment", "housing", "emergency_expense", "other"];

export function AskForm({ users }: { users: { userId: string; homeCurrency: string; balance: number; minBalance: number }[] }) {
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [userId, setUserId] = useState(users[0]?.userId ?? "");
  const [amount, setAmount] = useState("");
  const u = users.find((x) => x.userId === userId);
  const today = new Date().toISOString().slice(0, 10);
  const inSixWeeks = new Date(Date.now() + 42 * 864e5).toISOString().slice(0, 10);
  const amt = Number(amount);
  const room = u ? u.balance - u.minBalance : 0;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const fd = new FormData(e.currentTarget);
    const body = {
      user_id: fd.get("user_id"), request_type: fd.get("request_type"), requested_amount: Number(fd.get("requested_amount")),
      request_date: fd.get("request_date"), desired_completion_date: fd.get("desired_completion_date"),
      allows_partial_payment: fd.get("allows_partial_payment") === "on", request_text: fd.get("request_text"),
    };
    const res = await fetch("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) { setBusy(false); return setErr(typeof j.error === "string" ? j.error : "Please check the form values."); }
    router.push(`/requests/${j.request_id}`);
  }

  return (
    <form onSubmit={submit} className="card pop p-6 sm:p-8" aria-describedby={`${id}-help`}>
      <ol className="mb-6 flex items-center gap-3 text-xs" aria-label="Steps">
        {["Who", "What", "When"].map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span aria-hidden className="grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold text-white" style={{ background: "var(--blue)" }}>{i + 1}</span>
            <span className="muted font-medium">{s}</span>
            {i < 2 && <span aria-hidden className="mx-1 h-px w-8" style={{ background: "var(--border-strong)" }} />}
          </li>
        ))}
      </ol>

      <div className="space-y-5">
        <label className="block">
          <span className="lbl">1 · Who is asking?</span>
          <select name="user_id" className="input" value={userId} onChange={(e) => setUserId(e.target.value)} required>
            {users.map((x) => <option key={x.userId} value={x.userId}>{x.userId} · {x.homeCurrency}</option>)}
          </select>
          {u && <span className="faint mt-1 block text-xs">Available {money(u.homeCurrency, u.balance)} · keeps at least {money(u.homeCurrency, u.minBalance)}</span>}
        </label>

        <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
          <label className="block">
            <span className="lbl">2 · How much? ({u?.homeCurrency ?? "amount"})</span>
            <input name="requested_amount" type="number" inputMode="decimal" step="0.01" min="0.01" required className="input text-lg font-semibold" placeholder="25 000" value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby={`${id}-room`} />
            <span id={`${id}-room`} className="mt-1 block text-xs" style={{ color: amt > room && amt > 0 ? "var(--orange)" : "var(--text-3)" }}>
              {amt > 0 && u ? (amt > room ? `More than today’s headroom of ${money(u.homeCurrency, Math.max(0, room))} – the forecast will look for a plan.` : `Within today’s headroom of ${money(u.homeCurrency, room)}.`) : "Headroom = available balance − minimum to keep, before upcoming bills."}
            </span>
          </label>
          <label className="block">
            <span className="lbl">For</span>
            <select name="request_type" className="input" defaultValue="purchase">{TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select>
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block"><span className="lbl">3 · Deciding on</span><input name="request_date" type="date" required className="input" defaultValue={today} /></label>
          <label className="block"><span className="lbl">Needed by</span><input name="desired_completion_date" type="date" required className="input" defaultValue={inSixWeeks} /></label>
        </div>

        <details className="rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
          <summary className="muted cursor-pointer text-sm font-medium">More options</summary>
          <div className="mt-3 space-y-3">
            <label className="flex items-center gap-2 text-sm"><input name="allows_partial_payment" type="checkbox" className="h-4 w-4 accent-[var(--blue)]" /> The seller accepts part now, the rest later</label>
            <label className="block"><span className="lbl">Your question, in your words</span><textarea name="request_text" rows={2} className="input" placeholder="Can I afford this laptop without touching the balance I want to keep?" /></label>
          </div>
        </details>

        {err && <p role="alert" className="text-sm" style={{ color: "var(--red)" }}>{err}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary !px-5 !py-2.5" disabled={busy} aria-busy={busy}>
            {busy ? <><span className="chat-dot" /><span className="chat-dot" /><span className="chat-dot" /><span className="ml-1">Forecasting 90 days…</span></> : "Get recommendation"}
          </button>
          <p id={`${id}-help`} className="faint text-xs">Takes a few seconds. Balances are snapshots at each user’s original request date, so pick a nearby decision date.</p>
        </div>
      </div>
    </form>
  );
}
