"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { ApiError, apiFetch, clearToken, getToken, isDemoMode, setToken } from "@/lib/api";

export type SessionUser = {
  userId: string;
  email: string;
  role: string;
};

type LoginResponse = {
  accessToken: string;
  user: { id: string; email: string; firstName: string; lastName: string; role: string };
};

type AuthContextValue = {
  user: SessionUser | null;
  isDemo: boolean;
  isLoading: boolean;
  /**
   * We hold a session but cannot reach the API to confirm it. Distinct from
   * being signed out: the right response is to wait and retry, not to send
   * somebody back to a login form their credentials will not fix.
   */
  unreachable: string | null;
  retry: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(!isDemoMode);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (isDemoMode) return;
    let active = true;
    void (async () => {
      const token = getToken();
      try {
        if (!token) return;
        const me = await apiFetch<SessionUser>("/auth/me");
        if (!active) return;
        setUser(me);
        setUnreachable(null);
      } catch (e) {
        if (!active) return;
        // ONLY a refusal ends a session. This used to clear the token on any
        // failure at all, so a cold start or a sleeping database signed the
        // operator out — which is why the dashboard had to be reloaded over and
        // over until one attempt happened to land on a warm function. A token
        // the server has not rejected is still a valid token.
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 401 || status === 403) {
          clearToken();
          setUnreachable(null);
        } else {
          setUnreachable(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);

  const login = async (email: string, password: string) => {
    const res = await apiFetch<LoginResponse>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
      // Safe to send again: a sign-in that fails creates nothing. Without this
      // the first press woke the function, failed, and the operator pressed the
      // button a second time to do what the code should have done itself.
      { retries: 2 },
    );
    setToken(res.accessToken);
    setUser({ userId: res.user.id, email: res.user.email, role: res.user.role });
    setUnreachable(null);
  };

  const logout = () => {
    clearToken();
    setUser(null);
    setUnreachable(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isDemo: isDemoMode,
        isLoading,
        unreachable,
        retry: () => {
          setIsLoading(true);
          setUnreachable(null);
          setAttempt((n) => n + 1);
        },
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
