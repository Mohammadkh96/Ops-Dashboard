"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { apiFetch } from "@/lib/api";

/**
 * The Admin tab's unlock, held for as long as it lasts and no longer.
 *
 * IN MEMORY, DELIBERATELY. Not localStorage, not sessionStorage. The whole
 * point of a second password is that being signed in is not the same as being
 * able to change roles and read the audit trail — and storing the unlock beside
 * the session token would make the two the same thing again for anybody who
 * opens the tab. Closing it locks up, which is the behaviour somebody expects
 * from something called a lock.
 *
 * It is also enforced on the server. Everything here is convenience: which
 * screen to show, when to say "locked", when to stop counting down. A browser
 * that skipped all of it would still be refused by the API.
 */

type LockStatus = {
  configured: boolean;
  setAt: string | null;
  lockedForSeconds: number;
  attemptsLeft: number;
  ttlMinutes: number;
  minLength: number;
};

type AdminLock = {
  /** The elevated token, or null when locked. */
  token: string | null;
  unlocked: boolean;
  /** Seconds until it expires by itself. */
  expiresIn: number;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  /** Adds the header to a request, or refuses if there is nothing to add. */
  authFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
};

const Ctx = createContext<AdminLock | null>(null);

export function AdminLockProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [now, setNow] = useState(() => Date.now());

  // Ticks only while a token is held, so a locked tab is not waking up every
  // second for nothing.
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [token]);

  const expiresIn = token ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
  // DERIVED, not cleared by an effect. Expiry is a function of the clock, and
  // the clock is already ticking a state update every second — so "unlocked"
  // becomes false on its own, in the same render, with no second pass that
  // shows the tab unlocked for a frame after it is not.
  const live = Boolean(token) && expiresIn > 0;

  const unlock = useCallback(async (passphrase: string) => {
    const res = await apiFetch<{ adminToken: string; expiresAt: string }>(
      "/auth/admin/unlock",
      { method: "POST", body: JSON.stringify({ passphrase }) },
    );
    setExpiresAt(Date.parse(res.expiresAt));
    setNow(Date.now());
    setToken(res.adminToken);
  }, []);

  const lock = useCallback(() => setToken(null), []);

  const authFetch = useCallback(
    <T,>(path: string, init?: RequestInit): Promise<T> => {
      // `live`, not `token`: an expired one is still in memory until the next
      // unlock, and sending it would spend a round trip to be told what the
      // clock already knows.
      if (!live || !token) {
        return Promise.reject(
          new Error("The Admin tab is locked. Enter your admin passphrase."),
        );
      }
      return apiFetch<T>(path, {
        ...init,
        headers: { ...(init?.headers ?? {}), "X-Admin-Token": token },
      });
    },
    [token, live],
  );

  const value = useMemo<AdminLock>(
    () => ({
      token: live ? token : null,
      unlocked: live,
      expiresIn,
      unlock,
      lock,
      authFetch,
    }),
    [token, live, expiresIn, unlock, lock, authFetch],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdminLock(): AdminLock {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useAdminLock must be used inside the Admin tab.");
  }
  return ctx;
}

/** Where this account stands with the lock: unset, set, or locked out. */
export function useLockStatus() {
  return { fetch: () => apiFetch<LockStatus>("/auth/admin/lock") };
}

export type { LockStatus };
