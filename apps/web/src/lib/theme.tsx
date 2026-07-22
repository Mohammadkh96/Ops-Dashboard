"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "opsos-theme";

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* storage may be unavailable (private mode) — the attribute alone still works */
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The inline head script sets data-theme before hydration; default here matches SSR.
  const [theme, setThemeState] = useState<Theme>("dark");

  // Sync from the DOM attribute the no-FOUC script already applied. Deferred off
  // the synchronous effect body to satisfy the set-state-in-effect lint rule.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      const current = document.documentElement.getAttribute("data-theme");
      if (current === "light" || current === "dark") setThemeState(current);
    });
    return () => {
      active = false;
    };
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyTheme(t);
  };

  const toggle = () => setTheme(theme === "dark" ? "light" : "dark");

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
