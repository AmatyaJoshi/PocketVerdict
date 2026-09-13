import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/** GET /api/requests/:id -> request, profile, payment options and the latest decision */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const { id } = await ctx.params;
  const request = await prisma.financeRequest.findUnique({
    where: { requestId: id },
    include: { profile: true, options: true, expected: true, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(request);
}
