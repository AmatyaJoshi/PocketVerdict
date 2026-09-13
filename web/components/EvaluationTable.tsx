"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { StatusBadge } from "./StatusBadge";
import { Pagination, usePageSlice } from "./Pagination";
import { METHOD_LABEL, money, niceDate } from "@/lib/format";
import { motion } from "motion/react";

export interface EvalRow {
  requestId: string; userId: string; currency: string;
  engine: { status: string; method: string; safe: number; earliest: string | null } | null;
  expected: { status: string; method: string; safe: number; earliest: string | null };
}

export function EvaluationTable({ rows }: { rows: EvalRow[] }) {
  const id = useId();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [running, setRunning] = useState<{ done: number; total: number; current: string } | null>(null);
  const { slice, page: p } = usePageSlice(rows, page, pageSize);

  async function runAll() {
    const todo = rows.map((r) => r.requestId);
    setRunning({ done: 0, total: todo.length, current: todo[0] });
    for (let i = 0; i < todo.length; i++) {
      setRunning({ done: i, total: todo.length, current: todo[i] });
      await fetch("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: todo[i] }) });
    }
    setRunning({ done: todo.length, total: todo.length, current: "" });
    router.refresh();
    setTimeout(() => setRunning(null), 800);
  }

  return (
    <section className="card overflow-hidden" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)", background: "var(--bg-soft)" }}>
        <h2 id={`${id}-title`} className="text-sm font-semibold">Engine vs. expected, per sample</h2>
        <div className="ml-auto flex items-center gap-3">
          {running && (
            <div className="flex items-center gap-2 text-xs" role="status" aria-live="polite">
              <div className="h-1.5 w-32 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                <motion.div className="h-full rounded-full" style={{ background: "var(--blue)" }} animate={{ width: `${(running.done / running.total) * 100}%` }} transition={{ ease: "linear", duration: 0.3 }} />
              </div>
              <span className="muted">{running.done}/{running.total} {running.current && `· ${running.current}`}</span>
            </div>
          )}
          <button className="btn btn-primary !py-1.5 text-xs" onClick={runAll} disabled={!!running} aria-busy={!!running}>
            {running ? "Running…" : rows.some((r) => r.engine) ? "Re-run all samples" : "Run all samples"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="data">
          <caption className="sr-only">Agreement between the engine and the solved sample answers</caption>
          <thead>
            <tr>
              <th scope="col">Sample</th><th scope="col">Engine</th><th scope="col">Expected</th>
              <th scope="col" className="num">Safe amount (engine / expected)</th><th scope="col">Earliest (engine / expected)</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => {
              const okStatus = r.engine?.status === r.expected.status;
              const okEarliest = (r.engine?.earliest ?? "") === (r.expected.earliest ?? "");
              const rel = r.engine ? Math.abs(r.engine.safe - r.expected.safe) / Math.max(1, r.expected.safe) : null;
              return (
                <motion.tr key={r.requestId} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03, duration: 0.25 }}>
                  <td><Link href={`/requests/${r.requestId}`} className="font-medium hover:underline" style={{ color: "var(--blue)" }}>{r.requestId}</Link><div className="faint text-xs">{r.userId}</div></td>
                  <td>{r.engine ? <><StatusBadge status={r.engine.status} /><div className="faint mt-0.5 text-xs">{METHOD_LABEL[r.engine.method]}</div></> : <span className="pill pill-gray">not run</span>}</td>
                  <td><StatusBadge status={r.expected.status} /><div className="faint mt-0.5 text-xs">{METHOD_LABEL[r.expected.method]}</div>{r.engine && !okStatus && <span className="pill pill-red mt-1 !text-[11px]">status differs</span>}</td>
                  <td className="num">{r.engine ? money(r.currency, r.engine.safe) : "—"} <span className="faint">/</span> {money(r.currency, r.expected.safe)}{rel !== null && <div className="text-xs" style={{ color: rel < 0.05 ? "var(--green)" : "var(--amber)" }}>{(rel * 100).toFixed(1)}% off</div>}</td>
                  <td>{r.engine ? (r.engine.earliest ? niceDate(r.engine.earliest) : "—") : "—"} <span className="faint">/</span> {r.expected.earliest ? niceDate(r.expected.earliest) : "—"}{r.engine && !okEarliest && <span className="ml-1 text-xs" style={{ color: "var(--red)" }} aria-label="differs">≠</span>}</td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination id={id} page={p} pageSize={pageSize} total={rows.length} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
    </section>
  );
}
