import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { EvaluationTable, type EvalRow } from "@/components/EvaluationTable";
import { Counter, Stagger, StaggerItem } from "@/components/Motion";

export const dynamic = "force-dynamic";

/** Agreement between the engine and the 25 solved samples shipped with the dataset. */
export default async function EvaluationPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const samples = await prisma.financeRequest.findMany({
    where: { source: "sample" },
    include: { expected: true, profile: { select: { homeCurrency: true } }, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const rows: EvalRow[] = samples
    .sort((a, b) => Number(a.requestId.split("_")[1]) - Number(b.requestId.split("_")[1]))
    .map((s) => {
      const d = s.decisions[0]; const e = s.expected!;
      return {
        requestId: s.requestId, userId: s.userId, currency: s.profile.homeCurrency,
        engine: d ? { status: d.affordabilityStatus, method: d.recommendedPaymentMethod, safe: d.amountSafeToPay, earliest: d.earliestDateForFullPayment } : null,
        expected: { status: e.affordabilityStatus, method: e.recommendedPaymentMethod, safe: e.amountSafeToPay, earliest: e.earliestDateForFullPayment },
      };
    });
  const ev = rows.filter((r) => r.engine);
  const tiles: [string, number][] = [
    ["Status", ev.filter((r) => r.engine!.status === r.expected.status).length],
    ["Method", ev.filter((r) => r.engine!.method === r.expected.method).length],
    ["Earliest date", ev.filter((r) => (r.engine!.earliest ?? "") === (r.expected.earliest ?? "")).length],
    ["Safe amount within 5%", ev.filter((r) => Math.abs(r.engine!.safe - r.expected.safe) / Math.max(1, r.expected.safe) < 0.05).length],
  ];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Evaluation workflow</h1>
        <p className="muted mt-1 max-w-3xl text-sm">The 25 solved samples are never used as labels for the evaluation set. They calibrate the forecaster and measure agreement here, and from the terminal with <code className="rounded bg-[var(--bg-soft)] px-1 py-0.5 text-xs">python code/evaluation/main.py</code> (scoring, <code className="text-xs">--tune</code>, <code className="text-xs">--validate output.csv</code>, <code className="text-xs">--usage-report</code>).</p>
      </div>
      <Stagger className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([k, v]) => (
          <StaggerItem key={k} className="card card-hover p-4">
            <div className="eyebrow">{k}</div>
            <div className="mt-1 flex items-baseline gap-1 text-2xl font-semibold tabular">
              {ev.length ? <><Counter value={v} /><span className="faint text-sm font-normal">/ {ev.length}</span></> : <span className="faint text-base font-normal">run the samples</span>}
            </div>
          </StaggerItem>
        ))}
      </Stagger>
      <EvaluationTable rows={rows} />
    </div>
  );
}
