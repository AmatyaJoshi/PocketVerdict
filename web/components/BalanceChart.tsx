"use client";

import {
  CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useEffect, useState } from "react";
import { money, niceDate } from "@/lib/format";

export interface PathPoint { date: string; balance: number }
export interface PlanPayment { date: string; amount: number }

/**
 * Single-series line: projected balance over the 90-day window, the minimum-balance floor as a
 * reference line, and the recommended payments as marked points. One axis, thin marks, crosshair tooltip.
 */
export function BalanceChart({
  path, minBalance, currency, payments, deadline,
}: { path: PathPoint[]; minBalance: number; currency: string; payments: PlanPayment[]; deadline?: string }) {
  const [animate, setAnimate] = useState(false);
  useEffect(() => { setAnimate(!window.matchMedia("(prefers-reduced-motion: reduce)").matches); }, []);
  if (!path?.length) return <p className="faint text-sm">No forecast stored for this decision yet.</p>;
  const byDate = new Map(path.map((p) => [p.date, p.balance]));
  const data = path.map((p) => ({ ...p, label: niceDate(p.date) }));
  const min = Math.min(minBalance, ...path.map((p) => p.balance));
  const max = Math.max(...path.map((p) => p.balance));
  const pad = (max - min) * 0.08 || 1;
  const fmt = (v: number) => money(currency, v, { compact: true }).replace(`${currency} `, "");
  const step = Math.max(1, Math.floor(path.length / 6));
  return (
    <figure aria-label="Projected balance over the next 90 days">
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} strokeDasharray="0" />
            <XAxis dataKey="date" tickFormatter={(d) => niceDate(d).replace(/ \d{4}$/, "")} interval={step - 1}
              tick={{ fill: "var(--text-2)", fontSize: 12 }} axisLine={{ stroke: "var(--grid)" }} tickLine={false} />
            <YAxis domain={[min - pad, max + pad]} tickFormatter={fmt} width={64}
              tick={{ fill: "var(--text-2)", fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ stroke: "var(--text-3)", strokeWidth: 1 }}
              contentStyle={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 12 }}
              labelStyle={{ color: "var(--text-2)" }}
              labelFormatter={(d) => niceDate(String(d))}
              formatter={(v) => [money(currency, Number(v)), "Projected balance"]}
            />
            <ReferenceLine y={minBalance} stroke="var(--status-critical)" strokeDasharray="4 4" strokeWidth={1.5}
              label={{ value: `minimum ${fmt(minBalance)}`, position: "insideTopRight", fill: "var(--text-2)", fontSize: 11 }} />
            {deadline && byDate.has(deadline) && (
              <ReferenceLine x={deadline} stroke="var(--text-3)" strokeDasharray="2 4"
                label={{ value: "deadline", position: "insideTop", fill: "var(--text-2)", fontSize: 11 }} />
            )}
            <Line type="monotone" dataKey="balance" stroke="var(--series-1)" strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff" }} isAnimationActive={animate} animationDuration={900} />
            {payments.filter((p) => byDate.has(p.date)).map((p) => (
              <ReferenceDot key={p.date + p.amount} x={p.date} y={byDate.get(p.date)!} r={6} fill="var(--series-2)" stroke="#fff" strokeWidth={2}
                label={{ value: `pay ${fmt(p.amount)}`, position: "top", fill: "var(--text)", fontSize: 11, fontWeight: 600 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="faint mt-2 flex flex-wrap gap-4 text-xs">
        <span><span className="mr-1 inline-block h-2 w-4 rounded-sm align-middle" style={{ background: "var(--series-1)" }} />Projected balance</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--series-2)" }} />Recommended payment</span>
        <span><span className="mr-1 inline-block h-0 w-4 border-t border-dashed align-middle" style={{ borderColor: "var(--status-critical)" }} />Minimum balance to keep</span>
      </figcaption>
    </figure>
  );
}
