"use client";

import { CheckCircle2, CircleSlash, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { useAdminIntegrations, type Integration } from "@/hooks/use-admin";
import { cn } from "@/lib/utils";

const TONE: Record<Integration["status"], { icon: typeof CheckCircle2; cls: string; word: string }> = {
  ok: { icon: CheckCircle2, cls: "text-accent-green", word: "Working" },
  degraded: { icon: TriangleAlert, cls: "text-accent-orange", word: "Needs attention" },
  off: { icon: CircleSlash, cls: "text-muted", word: "Not set up" },
};

/**
 * What this dashboard is actually connected to.
 *
 * This screen used to be a mock-up: three invented API keys with
 * plausible-looking tokens, and "Stripe — connected — sk_live_••••4821" beside
 * "MT5 Manager API — connected" on a deployment connected to neither. A
 * placeholder on a marketing page is harmless; on the admin screen somebody
 * checks before a shift, it is a false statement about whether the money is
 * being watched.
 *
 * It now reports the truth, and only the truth. NO SECRETS, not even masked
 * ones — a mask is a promise about a value the reader cannot check, and the
 * last four characters of a live key are enough to confirm a guess.
 *
 * Nothing here is editable. Credentials live in the host's environment, where
 * the platform holds them encrypted and out of the database; a form that wrote
 * live payment keys into a table would put them in the blast radius of every
 * backup, to save a redeploy.
 */
export default function IntegrationsPage() {
  const { data, isLoading, isError, error } = useAdminIntegrations();
  const items = data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integrations"
        description="What this dashboard is connected to, and whether it is working."
      />

      {isError ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          Could not read the integrations: {String(error)}
        </p>
      ) : null}

      {isLoading ? (
        <Card className="glass card-seam">
          <CardContent className="py-10 text-center text-sm text-muted">
            Checking what is connected…
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3">
        {items.map((i) => {
          const tone = TONE[i.status];
          const Icon = tone.icon;
          return (
            <Card key={i.key} className="glass card-seam">
              <CardContent className="flex flex-col gap-2 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon className={cn("size-4", tone.cls)} />
                    {i.name}
                  </span>
                  {/* The word as well as the colour: a status told only by
                      colour is no status at all for one reader in twelve. */}
                  <span className={cn("text-[11px] font-medium uppercase tracking-wider", tone.cls)}>
                    {tone.word}
                  </span>
                </div>
                <span className="text-xs text-muted">{i.what}</span>
                <p className="text-sm text-muted-foreground">{i.detail}</p>
                {i.needs?.length ? (
                  <p className="text-[11px] text-muted">
                    Set{" "}
                    {i.needs.map((n, idx) => (
                      <span key={n}>
                        {idx > 0 ? ", " : ""}
                        <code className="rounded bg-elevated px-1 py-0.5 font-mono text-[10px]">
                          {n}
                        </code>
                      </span>
                    ))}{" "}
                    in the API environment and redeploy.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Credentials are not shown or edited here — not even masked. They live in
        the API&rsquo;s environment variables, which is where the host can keep
        them encrypted and out of the database.
      </p>
    </div>
  );
}
