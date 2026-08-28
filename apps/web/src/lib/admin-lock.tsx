"use client";

import {
  createContext,
  useCallback,
  useContext,
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
 * NO AUTO-RELOCK. It stays open until somebody presses Lock, or closes the tab.
 * There used to be a fifteen-minute countdown; it went because relocking under
 * an administrator halfway through a job is an interruption that teaches people
 * to keep the passphrase in a text file, which costs more than the timer ever
 * saved.
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
  minLength: number;
};

type AdminLock = {
  /** The elevated token, or null when locked. */
  token: string | null;
  unlocked: boolean;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  /** Adds the header to a request, or refuses if there is nothing to add. */
  authFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
};

const Ctx = createContext<AdminLock | null>(null);

export function AdminLockProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);

  const unlock = useCallback(async (passphrase: string) => {
    const res = await apiFetch<{ adminToken: string }>("/auth/admin/unlock", {
      method: "POST",
      body: JSON.stringify({ passphrase }),
    });
    setToken(res.adminToken);
  }, []);

  const lock = useCallback(() => setToken(null), []);

  const authFetch = useCallback(
    <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (!token) {
        return Promise.reject(
          new Error("The Admin tab is locked. Enter your admin passphrase."),
        );
      }
      return apiFetch<T>(path, {
        ...init,
        headers: { ...(init?.headers ?? {}), "X-Admin-Token": token },
      });
    },
    [token],
  );

  const value = useMemo<AdminLock>(
    () => ({ token, unlocked: Boolean(token), unlock, lock, authFetch }),
    [token, unlock, lock, authFetch],
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
