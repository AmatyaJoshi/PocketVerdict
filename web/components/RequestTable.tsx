"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { StatusBadge } from "./StatusBadge";
import { METHOD_LABEL, money, niceDate, titleCase } from "@/lib/format";
import { Pagination, usePageSlice } from "./Pagination";
import { motion } from "motion/react";

export interface RequestRow {
  requestId: string; userId: string; requestDate: string; requestType: string; requestedAmount: number;
  desiredCompletionDate: string; currency: string; source: string;
  status: string | null; method: string | null; amountSafe: number | null; earliest: string | null; changes: string | null;
}

const STATUSES = ["affordable_now", "affordable_with_plan", "affordable_later", "not_affordable"];

export function RequestTable({ rows }: { rows: RequestRow[] }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const types = useMemo(() => Array.from(new Set(rows.map((r) => r.requestType))).sort(), [rows]);
  const filtered = rows.filter((r) =>
    (!q || r.requestId.includes(q.trim()) || r.userId.includes(q.trim())) &&
    (!status || r.status === status) && (!type || r.requestType === type) && (!source || r.source === source));
  const { slice: shown, page: p } = usePageSlice(filtered, page, pageSize);

  return (
    <section className="card overflow-hidden" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: "var(--border)", background: "var(--bg-soft)" }}>
        <h2 id={`${id}-title`} className="mr-2 text-sm font-semibold">All requests</h2>
        <label className="sr-only" htmlFor={`${id}-q`}>Search by request or user id</label>
        <input id={`${id}-q`} className="input !w-56 !py-1.5" placeholder="Search request or user…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <label className="sr-only" htmlFor={`${id}-s`}>Filter by status</label>
        <select id={`${id}-s`} className="input !w-48 !py-1.5" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </select>
        <label className="sr-only" htmlFor={`${id}-t`}>Filter by request type</label>
        <select id={`${id}-t`} className="input !w-44 !py-1.5" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">All types</option>
          {types.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
        </select>
        <label className="sr-only" htmlFor={`${id}-src`}>Filter by source</label>
        <select id={`${id}-src`} className="input !w-40 !py-1.5" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }}>
          <option value="">All sources</option>
          <option value="evaluation">Evaluation set</option>
          <option value="sample">Solved samples</option>
          <option value="adhoc">Asked in app</option>
        </select>
        <p className="faint ml-auto text-xs" role="status" aria-live="polite">{filtered.length} of {rows.length}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="data">
          <caption className="sr-only">Affordability requests with the latest engine decision</caption>
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">User</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">Requested</th>
              <th scope="col" className="num">Safe today</th>
              <th scope="col">Status</th>
              <th scope="col">Recommendation</th>
              <th scope="col">Full payment</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <motion.tr key={r.requestId} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.025, duration: 0.25 }}>
                <td>
                  <Link href={`/requests/${r.requestId}`} className="font-medium hover:underline" style={{ color: "var(--blue)" }}>{r.requestId}</Link>
                  <div className="faint text-xs">{niceDate(r.requestDate)} · due {niceDate(r.desiredCompletionDate)}</div>
                </td>
                <td className="muted">{r.userId}</td>
                <td>{titleCase(r.requestType)}</td>
                <td className="num">{money(r.currency, r.requestedAmount)}</td>
                <td className="num">{r.amountSafe === null ? "—" : money(r.currency, r.amountSafe)}</td>
                <td><StatusBadge status={r.status} /></td>
                <td>
                  {r.method ? METHOD_LABEL[r.method] ?? r.method : "—"}
                  {r.changes && r.changes !== "none" && <span className="pill pill-gray ml-2 !text-[11px]">+ spending changes</span>}
                </td>
                <td>{r.earliest ? niceDate(r.earliest) : <span className="faint">not within 90 days</span>}</td>
              </motion.tr>
            ))}
            {!shown.length && <tr><td colSpan={8} className="faint py-10 text-center">No requests match the filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination id={id} page={p} pageSize={pageSize} total={filtered.length} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
    </section>
  );
}
