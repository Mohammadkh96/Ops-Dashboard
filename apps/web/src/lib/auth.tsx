"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { apiFetch, clearToken, getToken, isDemoMode, setToken } from "@/lib/api";

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
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(!isDemoMode);

  useEffect(() => {
    if (isDemoMode) return;
    let active = true;
    void (async () => {
      const token = getToken();
      try {
        if (!token) return;
        const me = await apiFetch<SessionUser>("/auth/me");
        if (active) setUser(me);
      } catch {
        clearToken();
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const login = async (email: string, password: string) => {
    const res = await apiFetch<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(res.accessToken);
    setUser({ userId: res.user.id, email: res.user.email, role: res.user.role });
  };

  const logout = () => {
    clearToken();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isDemo: isDemoMode, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
