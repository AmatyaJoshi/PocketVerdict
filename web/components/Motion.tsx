"use client";

import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** Fades/slides page content in on every route change. */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={path}
        initial={reduce ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? undefined : { opacity: 0, y: -6 }}
        transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/** Staggers its children in as they mount. */
export function Stagger({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : "hidden"}
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: delay } } }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={{ hidden: { opacity: 0, y: 12, scale: 0.985 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.35, ease: [0.2, 0.7, 0.2, 1] } } }}>
      {children}
    </motion.div>
  );
}

/** Number that counts up to its value with a spring. */
export function Counter({ value, className, suffix = "" }: { value: number; className?: string; suffix?: string }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? value : 0);
  const spring = useSpring(mv, { stiffness: 90, damping: 20 });
  const text = useTransform(spring, (v) => Math.round(v).toLocaleString() + suffix);
  useEffect(() => { mv.set(value); }, [value, mv]);
  return <motion.span className={className} aria-label={`${value}${suffix}`}>{text}</motion.span>;
}

/** Progress bar that animates to its width. */
export function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--bg-soft)" }} aria-hidden>
      <motion.div className="h-full rounded-full" style={{ background: color }} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1], delay: 0.2 }} />
    </div>
  );
}

/** Subtle floating decoration for hero areas (pure motion, respects reduced motion). */
export function FloatingOrbs() {
  const reduce = useReducedMotion();
  const orbs = [
    { size: 220, x: "-6%", y: "-30%", color: "rgba(56,126,209,0.10)", d: 14 },
    { size: 160, x: "70%", y: "-20%", color: "rgba(255,87,34,0.10)", d: 18 },
    { size: 120, x: "40%", y: "60%", color: "rgba(46,157,93,0.10)", d: 16 },
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {orbs.map((o, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full blur-2xl"
          style={{ width: o.size, height: o.size, left: o.x, top: o.y, background: o.color }}
          animate={reduce ? undefined : { y: [0, -18, 0], x: [0, 10, 0] }}
          transition={{ duration: o.d, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

export { motion, AnimatePresence };
