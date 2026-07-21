"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Radar, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { login, user, isDemo } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("mohammad@tradin.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isDemo || user) router.replace("/");
  }, [isDemo, user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="glass card-seam w-full max-w-sm rounded-2xl border border-border p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-accent-blue-soft">
            <Radar className="size-5 text-accent-blue" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sign in to OpsOS</h1>
            <p className="text-xs text-muted">Operations command center</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-border-strong"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted focus:border-border-strong"
            />
          </label>

          {error ? (
            <p className="rounded-lg border border-accent-red/20 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
              {error}
            </p>
          ) : null}

          <Button type="submit" size="lg" disabled={submitting} className="mt-1">
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-muted">
          Seeded dev login: <span className="text-muted-foreground">mohammad@tradin.com</span> /
          <span className="text-muted-foreground"> OpsOS!2026</span>
        </p>
      </div>
    </div>
  );
}
