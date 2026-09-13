import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decideAndStore } from "@/lib/engine";

export const runtime = "nodejs";
export const maxDuration = 180;

const Body = z.union([
  z.object({ request_id: z.string().min(1) }),
  z.object({
    user_id: z.string().min(1),
    request_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    request_type: z.string().min(1),
    requested_amount: z.coerce.number().positive(),
    desired_completion_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    allows_partial_payment: z.coerce.boolean(),
    request_text: z.string().max(2000).optional().default(""),
  }),
]);

/** POST /api/decide  -> runs the engine for an existing request_id or an ad-hoc request */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const body = parsed.data;
  let requestId: string;
  if ("request_id" in body) {
    requestId = body.request_id;
  } else {
    const profile = await prisma.profile.findUnique({ where: { userId: body.user_id } });
    if (!profile) return NextResponse.json({ error: `unknown user ${body.user_id}` }, { status: 404 });
    requestId = `adhoc_${Date.now().toString(36)}`;
    await prisma.financeRequest.create({
      data: {
        requestId, userId: body.user_id, requestDate: new Date(body.request_date + "T00:00:00Z"), requestType: body.request_type,
        requestedAmount: body.requested_amount, desiredCompletionDate: new Date(body.desired_completion_date + "T00:00:00Z"),
        allowsPartialPayment: body.allows_partial_payment, requestText: body.request_text, source: "adhoc",
      },
    });
  }
  try {
    const { saved, result } = await decideAndStore(requestId, (session.user as { id?: string }).id);
    return NextResponse.json({ request_id: requestId, decision: result.decision, decision_id: saved.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
