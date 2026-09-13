"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

interface Msg { role: "user" | "assistant"; text: string; links?: { label: string; href: string }[] }

const SUGGESTIONS = [
  "Why is this not affordable now?",
  "How much can I safely pay today?",
  "When is the earliest I can pay in full?",
  "Which installment option is safest?",
];

export function ChatWidget() {
  const path = usePathname();
  const requestId = path.startsWith("/requests/") ? decodeURIComponent(path.split("/")[2] ?? "") : undefined;
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    const history = [...msgs, { role: "user" as const, text: q }];
    setMsgs(history);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: q, request_id: requestId, history: msgs.slice(-8).map((m) => ({ role: m.role, text: m.text })) }),
      });
      const j = await res.json();
      setMsgs([...history, { role: "assistant", text: j.answer ?? j.error ?? "Sorry, something went wrong.", links: j.links }]);
    } catch {
      setMsgs([...history, { role: "assistant", text: "I couldn’t reach the advisor. Please try again." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="advisor-panel"
        aria-label={open ? "Close advisor chat" : "Open advisor chat"}
        className="fixed bottom-5 right-5 z-40 flex h-12 items-center gap-2 rounded-full px-4 text-sm font-semibold text-white shadow-lg transition-transform duration-200 hover:scale-[1.03] active:scale-95"
        style={{ background: "var(--blue)", boxShadow: "var(--shadow-md)" }}
      >
        <span aria-hidden>{open ? "✕" : "✦"}</span>{open ? "Close" : "Ask the advisor"}
      </button>

      <AnimatePresence>
      {open && (
        <motion.section
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
          id="advisor-panel"
          role="dialog"
          aria-modal="false"
          aria-label="Advisor chat"
          className="card fixed bottom-20 right-5 z-40 flex w-[min(400px,calc(100vw-2.5rem))] flex-col overflow-hidden"
          style={{ height: "min(560px, calc(100vh - 7rem))", boxShadow: "var(--shadow-md)" }}
        >
          <header className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)", background: "var(--bg-soft)" }}>
            <span aria-hidden className="grid h-8 w-8 place-items-center rounded-full text-white" style={{ background: "var(--orange)" }}>✦</span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">PocketVerdict advisor</h2>
              <p className="faint truncate text-xs">{requestId ? `Answering about ${requestId}` : "Ask about any request, user or decision"}</p>
            </div>
          </header>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3" role="log" aria-live="polite" aria-relevant="additions">
            {msgs.length === 0 && (
              <div className="fade">
                <p className="muted text-sm">Hi! I explain the engine’s decisions in plain words. Try one of these:</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="btn !rounded-full !px-3 !py-1 text-xs" onClick={() => send(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className="max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed"
                  style={m.role === "user" ? { background: "var(--blue)", color: "#fff", borderBottomRightRadius: 6 } : { background: "var(--bg-soft)", border: "1px solid var(--border)", borderBottomLeftRadius: 6 }}
                >
                  <span className="sr-only">{m.role === "user" ? "You: " : "Advisor: "}</span>
                  {m.text}
                  {m.links?.length ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {m.links.map((l) => <a key={l.href} href={l.href} className="pill pill-blue hover:underline">{l.label}</a>)}
                    </div>
                  ) : null}
                </div>
              </motion.div>
            ))}
            {busy && (
              <div className="flex justify-start" aria-label="Advisor is typing">
                <div className="flex items-center gap-1 rounded-2xl px-4 py-3" style={{ background: "var(--bg-soft)", border: "1px solid var(--border)" }}>
                  <span className="chat-dot" /><span className="chat-dot" /><span className="chat-dot" />
                </div>
              </div>
            )}
          </div>

          <form className="flex items-center gap-2 border-t p-3" style={{ borderColor: "var(--border)" }} onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <label htmlFor="advisor-input" className="sr-only">Message the advisor</label>
            <input id="advisor-input" ref={inputRef} className="input !py-2" placeholder="Ask a question…" value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} autoComplete="off" />
            <button className="btn btn-primary !px-3.5 !py-2" disabled={busy || !input.trim()} aria-label="Send">➤</button>
          </form>
        </motion.section>
      )}
      </AnimatePresence>
    </>
  );
}
