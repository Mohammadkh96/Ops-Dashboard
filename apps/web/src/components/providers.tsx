"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TimeRangeProvider } from "@/lib/time-range";

import { AuthProvider } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import { ToastProvider } from "@/components/ui/toast";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 1,
            /**
             * Coming back to the tab re-reads the data.
             *
             * This was off, and it is the whole of "when I leave the dashboard
             * idle I have to keep refreshing to connect". An operations screen
             * left open across a break showed whatever was true when it was
             * last looked at, with no indication the figures had aged — so the
             * only way to trust it was to reload the page by hand, every time.
             *
             * The cost is a burst of requests when a tab is focused, bounded by
             * staleTime: anything read in the last fifteen seconds is left
             * alone. That is the right trade for a desk whose numbers are money
             * moving in real time.
             */
            refetchOnWindowFocus: true,
            /** Same reason, for a laptop that lost its network and found it. */
            refetchOnReconnect: true,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <TimeRangeProvider>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </TimeRangeProvider>
    </QueryClientProvider>
  );
}
