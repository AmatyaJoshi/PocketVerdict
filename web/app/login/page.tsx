import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await auth();
  if (session?.user) redirect("/");
  const { error } = await searchParams;

  async function login(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", { email: formData.get("email"), password: formData.get("password"), redirectTo: "/" });
    } catch (e) {
      if (e instanceof AuthError) redirect("/login?error=1");
      throw e;
    }
  }

  return (
    <div className="mx-auto mt-14 grid max-w-4xl gap-10 md:grid-cols-2 md:items-center">
      <section className="rise">
        <p className="eyebrow">PocketVerdict</p>
        <h1 className="mt-2 text-3xl font-semibold leading-tight tracking-tight">Buy or wait? Get a verdict you can bank on.</h1>
        <p className="muted mt-3 max-w-md text-[15px]">Every purchase question gets a 90-day cash-flow forecast, a safe amount for today, and the least disruptive way to complete it.</p>
        <ul className="mt-6 space-y-2 text-sm">
          {["Protects the minimum balance on every day of the forecast", "Uses seller payment options, messages and bills as evidence", "Explains each recommendation in one plain sentence"].map((t) => (
            <li key={t} className="flex items-start gap-2"><span aria-hidden className="mt-1 inline-block h-4 w-4 rounded-full text-center text-[10px] font-bold leading-4 text-white" style={{ background: "var(--green)" }}>✓</span><span className="muted">{t}</span></li>
          ))}
        </ul>
      </section>
      <section className="card pop p-8" aria-labelledby="login-title">
        <h2 id="login-title" className="text-lg font-semibold">Sign in</h2>
        <form action={login} className="mt-5 space-y-4">
          <label className="block">
            <span className="lbl">Email</span>
            <input name="email" type="email" autoComplete="username" required className="input" defaultValue="demo@buyorwait.app" />
          </label>
          <label className="block">
            <span className="lbl">Password</span>
            <input name="password" type="password" autoComplete="current-password" required className="input" aria-describedby={error ? "login-error" : undefined} />
          </label>
          {error && <p id="login-error" role="alert" className="text-sm" style={{ color: "var(--red)" }}>That email and password don’t match.</p>}
          <button className="btn btn-primary w-full !py-2.5">Continue</button>
        </form>
        <p className="faint mt-4 text-xs">Demo credentials are created by the seed script (see web/.env.example).</p>
      </section>
    </div>
  );
}
