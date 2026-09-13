import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { RequestTable, type RequestRow } from "@/components/RequestTable";
import { STATUS_LABEL } from "@/lib/format";
import { Bar, Counter, FloatingOrbs, Stagger, StaggerItem } from "@/components/Motion";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  affordable_now: "var(--green)", affordable_with_plan: "var(--blue)", affordable_later: "var(--amber)", not_affordable: "var(--red)",
};

export default async function Dashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const requests = await prisma.financeRequest.findMany({
    include: { profile: { select: { homeCurrency: true } }, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const rows: RequestRow[] = requests
    .sort((a, b) => (a.source === b.source ? Number(a.requestId.split("_").pop()) - Number(b.requestId.split("_").pop()) : a.source === "adhoc" ? -1 : b.source === "adhoc" ? 1 : a.source.localeCompare(b.source)))
    .map((r) => {
      const d = r.decisions[0];
      return {
        requestId: r.requestId, userId: r.userId, requestDate: r.requestDate.toISOString(), requestType: r.requestType,
        requestedAmount: r.requestedAmount, desiredCompletionDate: r.desiredCompletionDate.toISOString(),
        currency: r.profile.homeCurrency, source: r.source,
        status: d?.affordabilityStatus ?? null, method: d?.recommendedPaymentMethod ?? null,
        amountSafe: d?.amountSafeToPay ?? null, earliest: d?.earliestDateForFullPayment ?? null, changes: d?.spendingChangesNeeded ?? null,
      };
    });
  const evalRows = rows.filter((r) => r.source === "evaluation");
  const counts = Object.fromEntries(Object.keys(STATUS_LABEL).map((s) => [s, evalRows.filter((r) => r.status === s).length]));
  const total = evalRows.length || 1;

  return (
    <div className="relative space-y-6">
      <FloatingOrbs />
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Requests</h1>
          <p className="muted mt-0.5 text-sm">Each answer is backed by a 90-day forecast that keeps essentials covered and the minimum balance intact.</p>
        </div>
        <Link href="/ask" className="btn btn-orange">Ask “can I afford this?”</Link>
      </section>

      {/* Kite-style summary strip */}
      <Stagger className="grid grid-cols-2 gap-3 md:grid-cols-4" delay={0.05}>
        {Object.entries(STATUS_LABEL).map(([k, label]) => (
          <StaggerItem key={k} className="card card-hover p-4">
            <div className="eyebrow flex items-center gap-1.5"><span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: TONE[k] }} />{label}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <Counter value={counts[k]} className="tabular text-2xl font-semibold" />
              <span className="faint text-xs">{Math.round((counts[k] / total) * 100)}%</span>
            </div>
            <Bar pct={(counts[k] / total) * 100} color={TONE[k]} />
          </StaggerItem>
        ))}
      </Stagger>

      <RequestTable rows={rows} />
    </div>
  );
}
