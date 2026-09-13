/**
 * Imports the challenge dataset (../dataset/*.csv) and the engine output (../output.csv) into MySQL,
 * copies the evidence images into public/media, and creates the demo login.
 *
 *   npm run db:seed
 */
import { PrismaClient } from "@prisma/client";
import { parse } from "csv-parse/sync";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();
const ROOT = path.resolve(process.env.ENGINE_ROOT ?? path.join(process.cwd(), ".."));
const DATASET = path.join(ROOT, "dataset");

function csv(file: string): Record<string, string>[] {
  const p = path.join(DATASET, file);
  return parse(fs.readFileSync(p, "utf8"), { columns: true, skip_empty_lines: true, bom: true });
}
const d = (s: string) => (s ? new Date(s.slice(0, 10) + "T00:00:00Z") : null);
const f = (s: string) => (s === "" || s == null ? null : Number(s));

async function batch<T>(rows: T[], fn: (chunk: T[]) => Promise<unknown>, size = 1000) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

async function main() {
  console.log(`dataset: ${DATASET}`);

  // --- demo login -------------------------------------------------------------
  const email = process.env.ADMIN_EMAIL ?? "demo@buyorwait.app";
  const password = process.env.ADMIN_PASSWORD ?? "demo1234";
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: "Demo analyst", role: "admin", passwordHash: await bcrypt.hash(password, 10) },
  });

  // --- wipe dataset tables (idempotent re-seed) -------------------------------------
  await prisma.decision.deleteMany();
  await prisma.expectedOutput.deleteMany();
  await prisma.paymentOption.deleteMany();
  await prisma.message.deleteMany();
  await prisma.imageRef.deleteMany();
  await prisma.financialEvent.deleteMany();
  await prisma.financeRequest.deleteMany();
  await prisma.exchangeRate.deleteMany();
  await prisma.profile.deleteMany();

  // --- profiles ------------------------------------------------------------------
  const profiles = csv("financial_profiles.csv").map((r) => ({
    userId: r.user_id, homeCurrency: r.home_currency, balance: Number(r.current_available_balance),
    minBalance: Number(r.minimum_balance_to_keep), priorities: r.financial_priorities,
    protect: r.expense_categories_to_protect, reduceOk: r.expense_categories_user_is_willing_to_reduce,
    stopOk: r.expense_categories_user_is_willing_to_stop, methods: r.payment_methods_user_will_consider,
    maxInstallmentMonths: r.max_installment_months ? Number(r.max_installment_months) : null,
  }));
  await prisma.profile.createMany({ data: profiles });
  console.log(`profiles: ${profiles.length}`);

  // --- events ---------------------------------------------------------------------
  const events = csv("financial_events.csv").map((r) => ({
    eventId: r.event_id, userId: r.user_id, eventType: r.event_type, description: r.description,
    category: r.category, direction: r.direction, amount: f(r.amount), currency: r.currency,
    eventDate: d(r.event_date)!, settlementDate: d(r.settlement_date), status: r.status,
    linkedEventId: r.linked_event_id || null, flexibility: r.flexibility, minAllowed: f(r.minimum_allowed_amount),
  }));
  await batch(events, (c) => prisma.financialEvent.createMany({ data: c }));
  console.log(`events: ${events.length}`);

  // --- requests + samples ------------------------------------------------------------
  const toReq = (r: Record<string, string>, source: string) => ({
    requestId: r.request_id, userId: r.user_id, requestDate: d(r.request_date)!, requestType: r.request_type,
    requestedAmount: Number(r.requested_amount), desiredCompletionDate: d(r.desired_completion_date)!,
    allowsPartialPayment: r.allows_partial_payment.toLowerCase() === "true", requestText: r.request_text, source,
  });
  const requests = csv("requests.csv").map((r) => toReq(r, "evaluation"));
  const samples = csv("sample_requests.csv");
  await prisma.financeRequest.createMany({ data: [...requests, ...samples.map((r) => toReq(r, "sample"))] });
  await prisma.expectedOutput.createMany({
    data: samples.map((r) => ({
      requestId: r.request_id, amountSafeToPay: Number(r.amount_safe_to_pay), affordabilityStatus: r.affordability_status,
      recommendedPaymentMethod: r.recommended_payment_method, paymentPlan: r.payment_plan,
      earliestDateForFullPayment: r.earliest_date_for_full_payment || null, spendingChangesNeeded: r.spending_changes_needed,
      decisionExplanation: r.decision_explanation,
    })),
  });
  console.log(`requests: ${requests.length} + ${samples.length} samples`);

  // --- options / messages / images / rates ------------------------------------------------
  await prisma.paymentOption.createMany({
    data: csv("request_payment_options.csv").map((r) => ({
      optionId: r.payment_option_id, requestId: r.request_id, paymentMethod: r.payment_method,
      paymentAmount: Number(r.payment_amount), numberOfPayments: Number(r.number_of_payments),
      firstPaymentDate: d(r.first_payment_date)!, paymentFrequencyDays: r.payment_frequency_days ? Number(r.payment_frequency_days) : null,
      financingFee: Number(r.financing_fee || 0), totalPayableAmount: Number(r.total_payable_amount),
    })),
  });
  await prisma.message.createMany({
    data: csv("messages.csv").map((r) => ({
      messageId: r.message_id, userId: r.user_id, requestId: r.request_id || null, relatedEventId: r.related_event_id || null,
      sentAt: new Date(r.sent_at), sourceType: r.source_type, text: r.message_text,
    })),
  });
  await prisma.imageRef.createMany({
    data: csv("images.csv").map((r) => ({
      imageId: r.image_id, userId: r.user_id, requestId: r.request_id || null, relatedEventId: r.related_event_id || null,
    })),
  });
  await prisma.exchangeRate.createMany({
    data: csv("exchange_rates.csv").map((r) => ({
      rateDate: d(r.rate_date)!, fromCurrency: r.from_currency, toCurrency: r.to_currency, rate: Number(r.rate),
    })),
  });

  // --- decisions from the engine's output.csv (if present) ---------------------------------
  const outPath = path.join(ROOT, "output.csv");
  if (fs.existsSync(outPath)) {
    const rows: Record<string, string>[] = parse(fs.readFileSync(outPath, "utf8"), { columns: true, bom: true });
    await prisma.decision.createMany({
      data: rows.map((r) => ({
        requestId: r.request_id, amountSafeToPay: Number(r.amount_safe_to_pay), affordabilityStatus: r.affordability_status,
        recommendedPaymentMethod: r.recommended_payment_method, paymentPlan: r.payment_plan,
        earliestDateForFullPayment: r.earliest_date_for_full_payment || null, spendingChangesNeeded: r.spending_changes_needed,
        decisionExplanation: r.decision_explanation, llmProvider: "batch-import",
      })),
    });
    console.log(`decisions imported from output.csv: ${rows.length}`);
  }

  // --- evidence images -> public/media/images ----------------------------------------------
  const src = path.join(DATASET, "media", "images");
  const dst = path.join(process.cwd(), "public", "media", "images");
  fs.mkdirSync(dst, { recursive: true });
  for (const fn of fs.readdirSync(src)) fs.copyFileSync(path.join(src, fn), path.join(dst, fn));
  console.log(`images copied: ${fs.readdirSync(dst).length}`);
  console.log(`\nlogin: ${email} / ${password}`);
}

main().finally(() => prisma.$disconnect());
