"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Radar, Loader2, ShieldCheck, Activity, Zap } from "lucide-react";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { LiveDot } from "@/components/ui/live-dot";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { useAuth } from "@/lib/auth";
import { API_URL, isDemoMode } from "@/lib/api";

const highlights = [
  { icon: Activity, title: "Live operational telemetry", copy: "Payments, KYC, incidents and MT5 health in one command center." },
  { icon: ShieldCheck, title: "Risk-aware by default", copy: "Every transaction scored, every alert routed to the right desk." },
  { icon: Zap, title: "Built for the shift floor", copy: "Sub-second search, keyboard-first, tuned for high-tempo ops." },
];

/**
 * Turns a sign-in failure into something the reader can act on.
 *
 * A blocked cross-origin request surfaces as `TypeError: Failed to fetch` and
 * nothing else — no status, no body, and the CORS detail is only in the browser
 * console. On a correct password that message points at the credentials, which
 * is the wrong place to look: the request never reached the server. Naming the
 * URL and the likely cause turns a dead end into a five-minute fix.
 */
function describeSignInError(err: unknown): string {
  if (err instanceof TypeError) {
    return `Could not reach the API at ${API_URL || "(not configured)"}. It is usually one of: WEB_ORIGIN on the API does not list this site's address, NEXT_PUBLIC_API_URL is wrong, or the API is down. Check the browser console for the exact CORS message.`;
  }
  return err instanceof Error ? err.message : "Sign in failed";
}

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
      setError(describeSignInError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Brand / showcase panel */}
      <div className="relative hidden overflow-hidden border-r border-border lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 -top-24 size-[28rem] rounded-full bg-accent-blue/10 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 right-0 size-[24rem] rounded-full bg-accent-magenta/10 blur-3xl"
        />

        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="relative flex items-center gap-2.5"
        >
          <div className="flex size-9 items-center justify-center rounded-xl bg-accent-blue-soft ring-1 ring-accent-blue/20">
            <Radar className="size-4.5 text-accent-blue" />
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-sm font-semibold tracking-tight">OpsOS</span>
            <span className="text-[11px] text-muted">Operations OS</span>
          </div>
        </motion.div>

        <div className="relative flex flex-col gap-10">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          >
            <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight">
              The operational command center for modern brokerage.
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
              One surface for payments, compliance, incidents and trading health — so
              your desk sees everything and reacts in seconds.
            </p>
          </motion.div>

          <div className="flex flex-col gap-5">
            {highlights.map((h, i) => {
              const Icon = h.icon;
              return (
                <motion.div
                  key={h.title}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: 0.2 + i * 0.1, ease: [0.22, 1, 0.36, 1] }}
                  className="flex items-start gap-3.5"
                >
                  <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                    <Icon className="size-4 text-accent-blue" />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{h.title}</span>
                    <span className="text-xs leading-relaxed text-muted">{h.copy}</span>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.6 }}
          className="relative flex items-center gap-6 rounded-xl border border-border bg-card/50 px-5 py-4"
        >
          <div className="flex flex-col">
            <span className="tnum text-lg font-semibold text-foreground">
              $<AnimatedNumber value={4.82} format={(n) => n.toFixed(2)} />M
            </span>
            <span className="text-[11px] text-muted">Volume today</span>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="flex flex-col">
            <span className="tnum text-lg font-semibold text-foreground">
              <AnimatedNumber value={97.8} format={(n) => n.toFixed(1)} />%
            </span>
            <span className="text-[11px] text-muted">Success rate</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <LiveDot tone="green" />
            <span className="text-[11px] text-muted">All systems operational</span>
          </div>
        </motion.div>
      </div>

      {/* Sign-in panel */}
      <div className="flex items-center justify-center px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="glass card-seam w-full max-w-sm rounded-2xl border border-border p-8"
        >
          <div className="mb-6 flex flex-col items-center gap-3 text-center lg:hidden">
            <div className="flex size-11 items-center justify-center rounded-xl bg-accent-blue-soft">
              <Radar className="size-5 text-accent-blue" />
            </div>
          </div>

          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
            <p className="mt-1 text-xs text-muted">Sign in to your operations command center.</p>
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

          {/*
            Demo mode only. This printed a working email and password on the
            sign-in page of a live deployment — handing the credential to anyone
            who opened the URL. Useful on a standalone preview with no real data
            behind it; indefensible in front of payment records.
          */}
          {isDemoMode ? (
            <p className="mt-5 rounded-lg border border-border bg-card/40 px-3 py-2.5 text-center text-[11px] leading-relaxed text-muted">
              Demo login: <span className="text-muted-foreground">mohammad@tradin.com</span> /
              <span className="text-muted-foreground"> OpsOS!2026</span>
            </p>
          ) : null}
        </motion.div>
      </div>
    </div>
  );
}
