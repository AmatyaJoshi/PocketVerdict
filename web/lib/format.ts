export function money(cur: string, x: number | string | null | undefined, opts: { compact?: boolean } = {}) {
  if (x === null || x === undefined || x === "") return "—";
  const v = typeof x === "string" ? Number(x) : x;
  if (Number.isNaN(v)) return String(x);
  const digits = ["IDR", "INR"].includes(cur) ? 0 : 2;
  const s = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: v % 1 === 0 ? 0 : Math.min(2, digits === 0 ? 2 : digits),
    maximumFractionDigits: 2,
    notation: opts.compact ? "compact" : "standard",
  }).format(v);
  return `${cur} ${s}`;
}

export function niceDate(s: string | Date | null | undefined) {
  if (!s) return "—";
  const d = typeof s === "string" ? new Date(s.slice(0, 10) + "T00:00:00Z") : s;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export const STATUS_LABEL: Record<string, string> = {
  affordable_now: "Affordable now",
  affordable_with_plan: "Affordable with a plan",
  affordable_later: "Affordable later",
  not_affordable: "Not affordable",
};

export const METHOD_LABEL: Record<string, string> = {
  full_payment: "Pay in full",
  partial_payment: "Partial payment",
  installments: "Installments",
  wait: "Wait",
  not_recommended: "Do not proceed",
};

/** status -> reserved status colours (good / warning / serious / critical), never series colours */
export const STATUS_TONE: Record<string, string> = {
  affordable_now: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-200 dark:ring-emerald-800",
  affordable_with_plan: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/60 dark:text-sky-200 dark:ring-sky-800",
  affordable_later: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-800",
  not_affordable: "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/60 dark:text-rose-200 dark:ring-rose-800",
};

export function parsePlan(plan: string): { date: string; amount: number }[] {
  if (!plan || plan === "none") return [];
  return plan.split("|").map((t) => {
    const [date, amount] = t.split(":");
    return { date, amount: Number(amount) };
  });
}

export function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
