import { STATUS_LABEL } from "@/lib/format";

const TONE: Record<string, string> = {
  affordable_now: "pill-green",
  affordable_with_plan: "pill-blue",
  affordable_later: "pill-amber",
  not_affordable: "pill-red",
};
const ICON: Record<string, string> = { affordable_now: "✓", affordable_with_plan: "◔", affordable_later: "◷", not_affordable: "✕" };

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="pill pill-gray">Not evaluated</span>;
  return (
    <span className={`pill ${TONE[status] ?? "pill-gray"}`}>
      <span aria-hidden>{ICON[status] ?? "•"}</span>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
