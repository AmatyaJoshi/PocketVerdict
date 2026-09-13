import Link from "next/link";
import { signOut } from "@/auth";
import { NavLinks } from "./NavLinks";

export function Nav({ user }: { user: { name: string | null; email: string | null } | null }) {
  return (
    <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur" style={{ borderColor: "var(--border)" }}>
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight" aria-label="PocketVerdict home">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md text-sm font-bold text-white" style={{ background: "var(--orange)" }}>P</span>
          <span>PocketVerdict</span>
        </Link>
        {user ? (
          <>
            <NavLinks />
            <div className="ml-auto flex items-center gap-3">
              <span className="faint hidden text-xs sm:inline" aria-label={`Signed in as ${user.email}`}>{user.name ?? user.email}</span>
              <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
                <button className="btn btn-ghost !px-3 !py-1.5 text-xs">Sign out</button>
              </form>
            </div>
          </>
        ) : (
          <Link href="/login" className="btn btn-primary ml-auto !py-1.5">Sign in</Link>
        )}
      </div>
    </header>
  );
}
