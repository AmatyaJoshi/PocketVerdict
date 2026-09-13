"use client";

export function Pagination({
  page, pageSize, total, onPage, onPageSize, id,
}: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize: (n: number) => void; id: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const windowPages = Array.from({ length: pages }, (_, i) => i + 1).filter((p) => p === 1 || p === pages || Math.abs(p - page) <= 1);
  return (
    <nav className="flex flex-wrap items-center gap-3 border-t px-3 py-2.5 text-sm" style={{ borderColor: "var(--border)", background: "var(--bg-soft)" }} aria-label="Pagination">
      <p className="muted text-xs" role="status" aria-live="polite">Showing {from}–{to} of {total}</p>
      <label className="faint ml-auto flex items-center gap-2 text-xs">
        Rows
        <select className="input !w-20 !py-1 !text-xs" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Rows per page">
          {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-1" role="group" aria-label="Pages">
        <button className="btn !px-2.5 !py-1 text-xs" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">‹</button>
        {windowPages.map((p, i) => (
          <span key={p} className="flex items-center">
            {i > 0 && windowPages[i - 1] !== p - 1 && <span className="faint px-1" aria-hidden>…</span>}
            <button
              className={`btn !min-w-8 !px-2.5 !py-1 text-xs ${p === page ? "btn-primary" : ""}`}
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              aria-label={`Page ${p}`}
              id={`${id}-p${p}`}
            >
              {p}
            </button>
          </span>
        ))}
        <button className="btn !px-2.5 !py-1 text-xs" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">›</button>
      </div>
    </nav>
  );
}

export function usePageSlice<T>(rows: T[], page: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  return { slice: rows.slice((p - 1) * pageSize, p * pageSize), page: p, pages };
}
