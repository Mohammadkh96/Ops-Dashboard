"use client";

import { useEffect, useState } from "react";

import { isDemoMode, warmUp, type WarmState } from "@/lib/api";

/**
 * Wakes the API as soon as this screen is on show, and says how that went.
 *
 * The state is for the sign-in form. "Waking" is a true and useful thing to
 * show for the two or three seconds a cold function takes; "unreachable" turns
 * a sign-in that is about to fail into something the reader was warned about
 * before they pressed anything.
 *
 * Re-fired on becoming visible and on regaining the network, because both are
 * moments when the API has probably gone back to sleep since the last look.
 */
export function useWarmApi(): WarmState {
  const [state, setState] = useState<WarmState>(isDemoMode ? "ready" : "cold");

  useEffect(() => {
    if (isDemoMode) return;
    let active = true;

    const ping = () => {
      if (document.visibilityState !== "visible") return;
      // Only claim to be waking something if we are about to wait for it; a
      // ping that returns from cache resolves before this ever renders.
      setState((s) => (s === "ready" ? s : "waking"));
      void warmUp().then((next) => {
        if (active) setState(next);
      });
    };

    ping();
    document.addEventListener("visibilitychange", ping);
    window.addEventListener("online", ping);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", ping);
      window.removeEventListener("online", ping);
    };
  }, []);

  return state;
}
