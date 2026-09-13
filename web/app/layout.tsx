import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ChatWidget } from "@/components/ChatWidget";
import { PageTransition } from "@/components/Motion";
import { auth } from "@/auth";

export const metadata: Metadata = {
  title: "PocketVerdict",
  description: "PocketVerdict — buy or wait? Affordability decisions backed by a 90-day safety forecast",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const user = session?.user ? { name: session.user.name ?? null, email: session.user.email ?? null } : null;
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a href="#main" className="skip-link">Skip to main content</a>
        <Nav user={user} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 pb-24 pt-6 sm:px-6 lg:px-8">
          <PageTransition>{children}</PageTransition>
        </main>
        {user && <ChatWidget />}
      </body>
    </html>
  );
}
