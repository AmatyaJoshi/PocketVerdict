import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { answer } from "@/lib/advisor";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  message: z.string().min(1).max(2000),
  request_id: z.string().max(64).optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(16).optional().default([]),
});

/** POST /api/chat -> advisor answer grounded in the stored decision */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid message" }, { status: 400 });
  const { message, request_id, history } = parsed.data;
  try {
    const a = await answer(message, history, request_id);
    return NextResponse.json(a);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
