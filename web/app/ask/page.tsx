import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { AskForm } from "@/components/AskForm";

export const dynamic = "force-dynamic";

export default async function AskPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const users = await prisma.profile.findMany({ select: { userId: true, homeCurrency: true, balance: true, minBalance: true } });
  const sorted = users.sort((a, b) => Number(a.userId.split("_")[1]) - Number(b.userId.split("_")[1]));
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="rise">
        <h1 className="text-[22px] font-semibold tracking-tight">Can I afford this?</h1>
        <p className="muted mt-1 text-sm">Three quick fields. The engine rebuilds the user’s cash flow, forecasts 90 days and recommends the safest way to pay.</p>
      </div>
      <AskForm users={sorted} />
    </div>
  );
}
