"use client";

import { AnimatePresence, motion } from "framer-motion";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LiveDot } from "@/components/ui/live-dot";
import type { QueueItem } from "@/lib/dashboard";

const statusBadge = {
  review: { variant: "orange" as const, label: "Review" },
  processing: { variant: "blue" as const, label: "Processing" },
  pending: { variant: "purple" as const, label: "Pending" },
  escalated: { variant: "red" as const, label: "Escalated" },
};

export function LiveQueueCard({ rows, newestId }: { rows: QueueItem[]; newestId?: string }) {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Live Queue</CardTitle>
        <span className="flex items-center gap-1.5 text-xs text-accent-green">
          <LiveDot tone="green" />
          Live
        </span>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted">
              <th className="pb-2 font-medium">ID</th>
              <th className="pb-2 font-medium">Type</th>
              <th className="pb-2 font-medium">Client</th>
              <th className="pb-2 font-medium">Amount</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
              {rows.map((item) => (
                <motion.tr
                  key={item.id}
                  layout
                  initial={{ opacity: 0, backgroundColor: "var(--accent-blue-soft)" }}
                  animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="py-2.5 font-mono text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      {item.id === newestId ? <LiveDot tone="blue" /> : null}
                      {item.id}
                    </span>
                  </td>
                  <td className="py-2.5 text-foreground">{item.type}</td>
                  <td className="py-2.5 text-muted-foreground">{item.client}</td>
                  <td className="py-2.5 text-foreground">{item.amount}</td>
                  <td className="py-2.5">
                    <Badge variant={statusBadge[item.status].variant}>
                      {statusBadge[item.status].label}
                    </Badge>
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
