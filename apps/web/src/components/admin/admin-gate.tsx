"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Lock, LockOpen, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { apiFetch, isDemoMode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAdminLock, type LockStatus } from "@/lib/admin-lock";

const field =
  "h-10 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong";

/**
 * The second password in front of the Admin tab.
 *
 * Three states, and which one somebody is in is asked rather than guessed at:
 * they have never set a passphrase, they have one to type, or they have run out
 * of attempts. Making a person discover which by failing is the difference
 * between a lock and an obstacle.
 *
 * None of this is the security control — the API refuses every admin route
 * without the unlock, whatever this component renders. What it does is make the
 * state visible, and give somebody a way to shut it again deliberately.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { unlocked, unlock, lock } = useAdminLock();
  const [passphrase, setPassphrase] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [current, setCurrent] = useState("");
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["admin-lock-status"],
    queryFn: () => apiFetch<LockStatus>("/auth/admin/lock"),
    enabled: !isDemoMode && user?.role === "ADMIN",
    // A lockout counts down server-side; without this the page would still be
    // saying "locked for 14 minutes" long after it opened.
    refetchInterval: unlocked ? false : 30_000,
    retry: false,
  });

  const setPass = useMutation({
    mutationFn: (body: { current?: string; next: string }) =>
      apiFetch("/auth/admin/lock", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setNext("");
      setConfirm("");
      setCurrent("");
      setChanging(false);
      setError(null);
      await status.refetch();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
  });

  const doUnlock = useMutation({
    mutationFn: (p: string) => unlock(p),
    onSuccess: () => {
      setPassphrase("");
      setError(null);
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      void status.refetch();
    },
  });

  if (isDemoMode) {
    return (
      <Shell icon={<ShieldAlert className="size-5 text-accent-orange" />} title="Not available in demo mode">
        The Admin tab works against real accounts and the real audit trail, so it
        is switched off when there is no API behind the dashboard.
      </Shell>
    );
  }

  // Said plainly rather than by hiding the tab. Somebody who cannot get in
  // should be told why and what to do, not left wondering whether it is broken.
  if (user && user.role !== "ADMIN") {
    return (
      <Shell icon={<ShieldAlert className="size-5 text-accent-orange" />} title="Administrators only">
        This tab changes roles, reads the audit trail and holds provider
        credentials. Your account is {user.role.replace(/_/g, " ").toLowerCase()} —
        ask an administrator if you need it.
      </Shell>
    );
  }

  if (unlocked) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent-green/25 bg-accent-green-soft px-3 py-2">
          <span className="flex items-center gap-2 text-xs text-accent-green">
            <LockOpen className="size-3.5" />
            Unlocked — stays open until you lock it
          </span>
          <button
            type="button"
            onClick={lock}
            className="text-xs text-accent-green underline underline-offset-2"
          >
            Lock now
          </button>
        </div>
        {children}
      </div>
    );
  }

  if (status.isLoading) {
    return <Shell icon={<Lock className="size-5 text-muted" />} title="Checking the lock…" />;
  }

  const s = status.data;
  const lockedOut = (s?.lockedForSeconds ?? 0) > 0;

  // Never set one. Not a warning — it is the first thing anybody sees here.
  if (s && !s.configured) {
    const tooShort = next.length > 0 && next.length < s.minLength;
    const mismatch = confirm.length > 0 && confirm !== next;
    return (
      <Shell icon={<Lock className="size-5 text-accent-blue" />} title="Set an admin passphrase">
        <p>
          A second password, for this tab only. It is separate from how you sign
          in — including Google — so that a session left open on an unlocked
          machine is not the same thing as being able to change roles or read the
          audit trail.
        </p>
        <p className="text-muted">
          At least {s.minLength} characters. There is no master key and no reset
          link: if you forget it, another administrator has to clear it for you.
        </p>
        <div className="flex flex-col gap-2 pt-1">
          <input
            type="password"
            autoFocus
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="New admin passphrase"
            className={field}
          />
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Again, to be sure"
            className={field}
          />
          {tooShort ? (
            <span className="text-[11px] text-muted">
              {s.minLength - next.length} more character
              {s.minLength - next.length === 1 ? "" : "s"}.
            </span>
          ) : null}
          {mismatch ? (
            <span className="text-[11px] text-accent-orange">
              These two do not match.
            </span>
          ) : null}
          <Button
            disabled={
              setPass.isPending || tooShort || !next || next !== confirm
            }
            onClick={() => setPass.mutate({ next })}
          >
            {setPass.isPending ? "Saving…" : "Set it"}
          </Button>
        </div>
        {error ? <Problem>{error}</Problem> : null}
      </Shell>
    );
  }

  return (
    <Shell icon={<Lock className="size-5 text-accent-blue" />} title="Admin tab is locked">
      {lockedOut ? (
        <>
          <p className="text-accent-orange">
            Too many wrong attempts. This opens again in{" "}
            {mmss(s?.lockedForSeconds ?? 0)}.
          </p>
          <p className="text-muted">
            If that was not you, the attempts are in the audit trail.
          </p>
        </>
      ) : (
        <>
          <p>
            Enter your admin passphrase. It stays unlocked until you press Lock
            — or until you close this tab, since the unlock is only ever held in
            memory.
          </p>
          <form
            className="flex flex-col gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (passphrase) doUnlock.mutate(passphrase);
            }}
          >
            <input
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Admin passphrase"
              className={field}
            />
            <Button type="submit" disabled={doUnlock.isPending || !passphrase}>
              {doUnlock.isPending ? "Checking…" : "Unlock"}
            </Button>
          </form>
          {/* Only when there is no error on screen — a failed attempt already
              says how many are left, and printing it twice reads as two
              different warnings. */}
          {!error && typeof s?.attemptsLeft === "number" && s.attemptsLeft < 5 ? (
            <p className="text-[11px] text-accent-orange">
              {s.attemptsLeft} attempt{s.attemptsLeft === 1 ? "" : "s"} left
              before this locks for a while.
            </p>
          ) : null}
        </>
      )}

      {error ? <Problem>{error}</Problem> : null}

      {!lockedOut ? (
        <div className="border-t border-border pt-3">
          {changing ? (
            <div className="flex flex-col gap-2">
              <input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="Current passphrase"
                className={field}
              />
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="New passphrase"
                className={field}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={setPass.isPending || !current || next.length < (s?.minLength ?? 10)}
                  onClick={() => setPass.mutate({ current, next })}
                >
                  {setPass.isPending ? "Saving…" : "Change it"}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setChanging(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setChanging(true);
                setError(null);
              }}
              className="text-[11px] text-muted underline underline-offset-2 hover:text-foreground"
            >
              Change my admin passphrase
            </button>
          )}
        </div>
      ) : null}
    </Shell>
  );
}

function Shell({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex justify-center py-8">
      <Card className="glass card-seam w-full max-w-md">
        <CardContent className="flex flex-col gap-3 py-6 text-sm">
          <div className="flex items-center gap-2.5">
            {icon}
            <span className="font-medium">{title}</span>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
      {children}
    </p>
  );
}

/** Seconds as m:ss — used for the lockout, which is the only clock left here. */
function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
