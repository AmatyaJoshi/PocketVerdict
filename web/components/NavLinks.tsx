"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Requests", match: (p: string) => p === "/" || p.startsWith("/requests") },
  { href: "/ask", label: "Ask", match: (p: string) => p.startsWith("/ask") },
  { href: "/evaluation", label: "Evaluation", match: (p: string) => p.startsWith("/evaluation") },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav aria-label="Primary" className="flex items-center gap-1 text-sm">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="nav-link" aria-current={l.match(path) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
