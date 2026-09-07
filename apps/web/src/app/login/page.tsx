"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Radar, Loader2, ShieldCheck, Activity, Zap } from "lucide-react";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { ConnectionCheck } from "@/components/login/connection-check";
import { LiveDot } from "@/components/ui/live-dot";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { useAuth } from "@/lib/auth";
import { useWarmApi } from "@/hooks/use-warm-api";
import { API_URL, ApiError, apiFetch, isDemoMode } from "@/lib/api";

const highlights = [
  {
    icon: Activity,
    title: "Live operational telemetry",
    copy: "Payments, KYC, incidents and MT5 health in one command center.",
  },
  {
    icon: ShieldCheck,
    title: "Risk-aware by default",
    copy: "Every transaction scored, every alert routed to the right desk.",
  },
  {
    icon: Zap,
    title: "Built for the shift floor",
    copy: "Sub-second search, keyboard-first, tuned for high-tempo ops.",
  },
];

/**
 * Turns a sign-in failure into something the reader can act on.
 *
 * A request that never reached the server surfaces as `Failed to fetch` and
 * nothing else — no status, no body, and the detail is only in the browser
 * console. On a correct password that message points at the credentials, which
 * is the wrong place to look. Naming the URL and the likely cause turns a dead
 * end into a five-minute fix.
 *
 * It has to match on ApiError, not on TypeError. The API client wraps every
 * network-level failure in an ApiError with status 0, so the TypeError this
 * used to look for never arrives — and the bare browser string was shown
 * instead of any of the below, which is exactly the "Failed to fetch" that was
 * reported from the desk.
 *
 * The two cases read differently on purpose. A *timeout* is an API that is
 * there and slow, which happens when a sleeping function and a suspended
 * database are woken by the same request; pressing the button again works, and
 * the message should say so rather than sending somebody to check settings.
 * Anything else at status 0 is a request the browser refused to complete, which
 * is a configuration matter and does need the connection check.
 */
type SignInError = {
  message: string;
  /** Whether the connection check is worth offering, or would be a red herring. */
  worthDiagnosing: boolean;
};

function describeSignInError(err: unknown): SignInError {
  const unreachable = {
    message: `Could not reach the API at ${API_URL || "(not configured)"}. Run the connection check below — it names which step failed and what to change.`,
    worthDiagnosing: true,
  };
  if (err instanceof ApiError && err.status === 0) {
    if (/did not answer/i.test(err.message)) {
      return {
        message:
          "The API is taking longer than usual to answer — it goes to sleep when idle and is waking up. Press Sign in again in a moment.",
        worthDiagnosing: false,
      };
    }
    return unreachable;
  }
  if (err instanceof TypeError) return unreachable;
  return {
    message: err instanceof Error ? err.message : "Sign in failed",
    // A refused password is not a connectivity problem, and a diagnostic panel
    // under it invites somebody to go looking in the wrong place.
    worthDiagnosing: false,
  };
}

/**
 * The reason a refused Google sign-in redirected back here with.
 *
 * Read through useSyncExternalStore rather than an effect. The value only
 * exists in the browser, so an effect would be the obvious place — but setting
 * state from an effect renders the page twice, once without the message and
 * once with, and that flash is exactly what React now refuses to compile.
 * useSyncExternalStore has a server snapshot for the prerender and a client
 * snapshot for the browser, so there is one render and no mismatch.
 *
 * The first read is cached because the effect below strips the parameter out of
 * the address bar; without the cache the very next render would read a clean
 * URL and the message would disappear while the person was still reading it.
 * A module-level cache is safe here because the redirect that sets the
 * parameter is a full browser navigation from the API — this module is loaded
 * fresh every time it can be true.
 */
let redirectReason: string | null | undefined;

function readRedirectReason(): string | null {
  if (redirectReason === undefined) {
    const q = new URLSearchParams(window.location.search);
    redirectReason =
      q.get("error") ??
      // Arriving here mid-shift because the session ran out. Said plainly:
      // being dropped onto a sign-in page with no explanation reads as the
      // dashboard having broken, and the first instinct is to report a fault
      // rather than to sign in again.
      (q.get("expired")
        ? "Your session expired, which happens once a shift. Sign in again — nothing was lost."
        : null);
  }
  return redirectReason;
}

/** Nothing ever changes this value after the page loads. */
const neverChanges = () => () => {};

export default function LoginPage() {
  const { login, user, isDemo } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<SignInError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Wakes the API while the email and password are being typed, so the press
  // of Sign in does not have to pay for a cold function AND a suspended
  // database before it can be answered.
  const warm = useWarmApi();

  // A refused Google sign-in redirects back here with its reason, because the
  // person is in a browser mid-flow and a JSON error page is a dead end.
  const redirected = useSyncExternalStore(
    neverChanges,
    readRedirectReason,
    () => null,
  );
  // Dismissed the moment they try something else, so a stale message does not
  // sit over a fresh attempt.
  const [dismissed, setDismissed] = useState(false);
  const error: SignInError | null =
    formError ??
    // An expired session and a refused Google sign-in both reached the API
    // perfectly well, so neither wants a connectivity diagnostic under it.
    (dismissed || !redirected
      ? null
      : { message: redirected, worthDiagnosing: false });

  // Whether this deployment has Google configured. Asked rather than assumed:
  // a "Continue with Google" button on a deployment without it sends people
  // down a road that ends in an error they cannot act on.
  const { data: providers } = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => apiFetch<{ google: boolean }>("/auth/providers"),
    enabled: !isDemo && !isDemoMode,
    staleTime: 5 * 60_000,
  });
  const hasGoogle = providers?.google ?? false;

  useEffect(() => {
    if (isDemo || user) router.replace("/");
  }, [isDemo, user, router]);

  useEffect(() => {
    // Out of the address bar once it has been read, so a reload does not
    // resurrect an error the person has already dealt with.
    if (redirected) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [redirected]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDismissed(true);
    setFormError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.replace("/");
    } catch (err) {
      setFormError(describeSignInError(err));
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
              One surface for payments, compliance, incidents and trading health
              — so your desk sees everything and reacts in seconds.
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
                  transition={{
                    duration: 0.5,
                    delay: 0.2 + i * 0.1,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="flex items-start gap-3.5"
                >
                  <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                    <Icon className="size-4 text-accent-blue" />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{h.title}</span>
                    <span className="text-xs leading-relaxed text-muted">
                      {h.copy}
                    </span>
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
            <span className="text-[11px] text-muted">
              All systems operational
            </span>
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
            <h1 className="text-xl font-semibold tracking-tight">
              Welcome back
            </h1>
            <p className="mt-1 text-xs text-muted">
              Sign in to your operations command center.
            </p>
          </div>

          {hasGoogle ? (
            <div className="mb-5 flex flex-col gap-3">
              <a
                href={`${API_URL}/auth/google`}
                className="flex h-10 items-center justify-center gap-2.5 rounded-lg border border-border bg-card text-sm font-medium transition-colors hover:bg-card-hover"
              >
                {/* Google's own mark, inline: an external image on a sign-in
                    page is a request to a third party before anybody has
                    agreed to anything. */}
                <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
                  <path
                    fill="#4285F4"
                    d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1 .7-2.3 1.1-4 1.1-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.4a12 12 0 0 0 0 10.8l4-3.1z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"
                  />
                </svg>
                Continue with Google
              </a>
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[10px] uppercase tracking-wider text-muted">
                  or
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </div>
          ) : null}

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Email
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-border-strong"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Password
              </span>
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
                {error.message}
              </p>
            ) : warm === "unreachable" ? (
              /* Said BEFORE the button is pressed. The API was pinged the
                 moment this page opened; if that ping did not come back there
                 is no point letting somebody type a password and blame it. */
              <p className="rounded-lg border border-accent-orange/20 bg-accent-orange-soft px-3 py-2 text-xs text-accent-orange">
                The API is not answering yet. Signing in may need a second
                attempt — or run the connection check below.
              </p>
            ) : warm === "waking" ? (
              /* Two or three seconds of a cold start, named rather than hidden.
                 The alternative is a button that appears to do nothing. */
              <p className="flex items-center gap-2 px-1 text-[11px] text-muted">
                <Loader2 className="size-3 animate-spin" />
                Waking the API…
              </p>
            ) : null}

            <Button
              type="submit"
              size="lg"
              disabled={submitting}
              className="mt-1"
            >
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
          {/*
            Shown once a sign-in has failed, rather than always: on a working
            deployment it is noise, and on a broken one it is the whole answer.
          */}
          {!isDemoMode && (error?.worthDiagnosing || warm === "unreachable") ? (
            <ConnectionCheck />
          ) : null}

          {isDemoMode ? (
            <p className="mt-5 rounded-lg border border-border bg-card/40 px-3 py-2.5 text-center text-[11px] leading-relaxed text-muted">
              Demo login:{" "}
              <span className="text-muted-foreground">mohammad@tradin.com</span>{" "}
              /<span className="text-muted-foreground"> OpsOS!2026</span>
            </p>
          ) : null}
        </motion.div>
      </div>
    </div>
  );
}
