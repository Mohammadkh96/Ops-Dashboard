"use client";

import Link from "next/link";
import { ArrowRight, Landmark } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { age, money } from "@/components/providers/balance";
import { cn } from "@/lib/utils";
import { usePspDirectory } from "@/hooks/use-psps";

/**
 * What is sitting at each payment provider, on the dashboard.
 *
 * EVERY FIGURE HERE IS AN ESTIMATE, and the card says so twice — once in the
 * header and once per row, with the age of the anchor it is built on. That is
 * not caution for its own sake. Providers like ForumPay and Match2Pay publish
 * no balance we can read, so these are anchored figures somebody typed in and
 * then moved by the transactions we hold; they cannot see the provider's fees,
 * conversion spread, settlements out to the bank, or anything done by hand in
 * the portal. A dashboard tile is the most-believed surface in the product, so
 * an unlabelled number here would be quoted to a provider inside a week.
 *
 * NOT TOTALLED. Several of these are in different currencies, and even where
 * they are not, adding estimates produces a bigger estimate with the errors
 * added too — a single "total across providers" figure is the one number on
 * this screen nobody could defend.
 */
export function PspBalancesCard() {
  const { data } = usePspDirectory();

  const rows = (data ?? [])
    .filter((p) => p.balance?.anchor && p.balance.estimate !== null)
    .sort((a, b) => (b.balance?.estimate ?? 0) - (a.balance?.estimate ?? 0));

  // Nothing anchored yet means no card. An empty "Provider balances" panel
  // reading "—" is a worse answer than the question not being asked.
  if (!rows.length) return null;

  return (
    <Card className="glass card-seam h-full">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="flex items-center gap-2">
            <Landmark className="size-3.5" />
            Provider balances
          </CardTitle>
          <span className="text-[11px] text-muted">
            Estimated from the last figure entered — not read from the provider
          </span>
        </div>
        <Link
          href="/providers"
          className="text-muted transition-colors hover:text-foreground"
        >
          <ArrowRight className="size-4" />
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {rows.map((p) => {
          const b = p.balance!;
          const stale = (b.ageHours ?? 0) > 24 * 7;
          return (
            <Link
              key={p.id}
              href={`/providers/transactions/?id=${p.id}`}
              className="flex items-baseline justify-between gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-elevated"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm">{p.label}</span>
                <span
                  className={cn(
                    "text-[11px]",
                    stale ? "text-accent-orange" : "text-muted",
                  )}
                >
                  {/* The age, every time. A figure anchored three weeks ago and
                      one anchored this morning look identical otherwise. */}
                  anchored {age(b.ageHours)}
                  {b.configured ? "" : " · no rules, not moving"}
                </span>
              </div>
              <span className="tnum shrink-0 text-sm font-semibold">
                ≈ {money(b.estimate!, b.currency)}
              </span>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
