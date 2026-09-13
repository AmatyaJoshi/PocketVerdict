"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RunEngineButton({ requestId, label = "Re-run engine" }: { requestId: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      <button
        className="btn btn-primary"
        disabled={busy} aria-busy={busy}
        onClick={async () => {
          setBusy(true); setErr(null);
          const res = await fetch("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: requestId }) });
          const j = await res.json();
          setBusy(false);
          if (!res.ok) return setErr(typeof j.error === "string" ? j.error : "engine error");
          router.refresh();
        }}
      >
        {busy ? <><span className="chat-dot" /><span className="chat-dot" /><span className="chat-dot" /><span className="ml-1">Forecasting…</span></> : label}
      </button>
      {err && <span role="alert" className="text-sm" style={{ color: "var(--red)" }}>{err}</span>}
    </div>
  );
}
