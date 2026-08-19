"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, XCircle, MinusCircle } from "lucide-react";

import { API_URL } from "@/lib/api";

type Outcome = "pass" | "fail" | "skip";

type Step = {
  name: string;
  outcome: Outcome;
  detail: string;
};

type Connectivity = {
  origin: string | null;
  originAllowed: boolean | null;
  allowedOrigins: string[];
  webOriginConfigured: boolean;
  env: Record<string, boolean>;
};

/**
 * Turns a fetch failure into the sentence that names the cause.
 *
 * A cross-origin refusal and a dead host are the same `TypeError` to the
 * caller, so the distinction has to come from what already succeeded: if an
 * earlier request to the same host got a reply, the host is up and the refusal
 * is about this particular request.
 */
function failureDetail(err: unknown, hostKnownUp: boolean): string {
  if (err instanceof TypeError) {
    return hostKnownUp
      ? "Blocked by the browser. The API is up, so this is the cross-origin check refusing this request."
      : "No reply. Either the address is wrong, the API is not deployed, or the browser blocked the request before it left.";
  }
  return err instanceof Error ? err.message : String(err);
}

async function runChecks(): Promise<{ steps: Step[]; info: Connectivity | null }> {
  const steps: Step[] = [];
  let info: Connectivity | null = null;

  if (!API_URL) {
    steps.push({
      name: "API address",
      outcome: "fail",
      detail:
        "NEXT_PUBLIC_API_URL was empty when this site was built. It is read at build time, so setting it in Vercel only takes effect after a redeploy.",
    });
    return { steps, info };
  }
  steps.push({ name: "API address", outcome: "pass", detail: API_URL });

  // Step 1 — the API's own report, which it serves to any origin. This has to
  // come first: everything after it can be blocked by the misconfiguration
  // being diagnosed, so a failure here means the host itself is unreachable
  // and the rest of the sequence would only produce misleading symptoms.
  let hostUp = false;
  try {
    const res = await fetch(`${API_URL}/health/connectivity`);
    info = (await res.json()) as Connectivity;
    hostUp = true;
    steps.push({
      name: "This site's origin accepted",
      outcome: info.originAllowed === false ? "fail" : "pass",
      detail:
        info.originAllowed === false
          ? `The API refuses "${info.origin}". It allows: ${info.allowedOrigins.join(", ")}`
          : `The API sees "${info.origin}" and allows it.`,
    });
  } catch (err) {
    steps.push({
      name: "API reachable",
      outcome: "fail",
      detail: failureDetail(err, false),
    });
    return { steps, info };
  }

  // Step 2 — a plain GET on a normally-configured route. Simple requests skip
  // the preflight, so this separates "the origin is allowed" from "the
  // preflight works", which fail in different places for different reasons.
  try {
    const res = await fetch(`${API_URL}/health`);
    const body = (await res.json()) as { status?: string; database?: string };
    steps.push({
      name: "API reachable",
      outcome: res.ok ? "pass" : "fail",
      detail: res.ok
        ? `HTTP ${res.status} · database ${body.database ?? "unknown"}`
        : `HTTP ${res.status}`,
    });
  } catch (err) {
    steps.push({
      name: "API reachable",
      outcome: "fail",
      detail: failureDetail(err, hostUp),
    });
  }

  // Step 3 — the shape of request sign-in actually makes. A JSON POST is not a
  // simple request, so the browser sends an OPTIONS preflight first; that is a
  // separate round trip with its own way of failing.
  try {
    const res = await fetch(`${API_URL}/health/connectivity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    steps.push({
      name: "Preflight for POST",
      outcome: res.ok ? "pass" : "fail",
      detail: res.ok ? "OPTIONS and POST both allowed." : `HTTP ${res.status}`,
    });
  } catch (err) {
    steps.push({
      name: "Preflight for POST",
      outcome: "fail",
      detail: failureDetail(err, hostUp),
    });
  }

  // Step 4 — the sign-in route itself. Any HTTP status means the request
  // completed, which moves the problem from the network to the password.
  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "connection-check@invalid", password: "x" }),
    });
    steps.push({
      name: "Sign-in route responds",
      // A 5xx is still a completed request, so the transport is fine — but it
      // is the API failing, not the password, and saying otherwise would send
      // whoever reads this to re-type a password that was never the problem.
      outcome: res.status >= 500 ? "fail" : "pass",
      detail:
        res.status >= 500
          ? `HTTP ${res.status}. The request arrived, so this is the API failing — usually it cannot reach its database.`
          : `HTTP ${res.status} to a deliberately invalid login — the route is reachable, so a failed sign-in is about the credentials.`,
    });
  } catch (err) {
    steps.push({
      name: "Sign-in route responds",
      outcome: "fail",
      detail: failureDetail(err, hostUp),
    });
  }

  return { steps, info };
}

const ICON: Record<Outcome, typeof CheckCircle2> = {
  pass: CheckCircle2,
  fail: XCircle,
  skip: MinusCircle,
};

const TONE: Record<Outcome, string> = {
  pass: "text-accent-green",
  fail: "text-accent-red",
  skip: "text-muted",
};

/**
 * Diagnoses a sign-in that fails before it reaches the server.
 *
 * The information needed to fix this — the browser's origin, the API's
 * allow-list, which leg of the request failed — is otherwise spread across the
 * DevTools console and two Vercel dashboards. Putting it on the page that
 * failed means whoever hit the problem can read the answer off the screen.
 */
export function ConnectionCheck() {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [info, setInfo] = useState<Connectivity | null>(null);
  const [running, setRunning] = useState(false);

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function run() {
    setRunning(true);
    try {
      const result = await runChecks();
      setSteps(result.steps);
      setInfo(result.info);
    } finally {
      setRunning(false);
    }
  }

  const misconfigured =
    info && (info.originAllowed === false || !info.webOriginConfigured);

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted">
          This page: <span className="text-muted-foreground">{origin}</span>
        </span>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : null}
          {running ? "Checking…" : "Run connection check"}
        </button>
      </div>

      {steps ? (
        <ul className="flex flex-col gap-2">
          {steps.map((s) => {
            const Icon = ICON[s.outcome];
            return (
              <li key={s.name} className="flex items-start gap-2">
                <Icon className={`mt-0.5 size-3.5 shrink-0 ${TONE[s.outcome]}`} />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-medium">{s.name}</span>
                  <span className="text-[11px] leading-relaxed text-muted">
                    {s.detail}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {misconfigured ? (
        <p className="rounded-md border border-accent-orange/20 bg-accent-orange-soft px-2.5 py-2 text-[11px] leading-relaxed text-accent-orange">
          Fix: in the API project&rsquo;s environment variables, set{" "}
          <span className="font-medium">WEB_ORIGIN</span> to{" "}
          <span className="font-medium">{origin}</span>, then redeploy the API.
        </p>
      ) : null}

      {info && Object.values(info.env).some((v) => !v) ? (
        <p className="text-[11px] leading-relaxed text-muted">
          Missing on the API:{" "}
          {Object.entries(info.env)
            .filter(([, present]) => !present)
            .map(([name]) => name)
            .join(", ")}
          .
        </p>
      ) : null}
    </div>
  );
}
