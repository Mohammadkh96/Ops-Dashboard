"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";

/**
 * The handover document, as the API builds it for the email.
 *
 * Shared rather than duplicated, so the copy read at Start shift and the copy
 * read from the history are the same request — react-query dedupes on the key,
 * so a component that only needs to know whether it LOADED can ask without
 * fetching it twice.
 */
export function useHandover(shiftId: string | null) {
  return useQuery({
    queryKey: ["shift-handover", shiftId],
    queryFn: () =>
      apiFetch<{ subject: string; html: string }>(`/shifts/${shiftId}/handover`),
    enabled: Boolean(shiftId),
  });
}

/**
 * The handover, read in the dashboard instead of an inbox.
 *
 * Rendered inside a sandboxed frame with no allowances at all — not scripts,
 * not forms, not same-origin. The document is built from notes and ticket
 * subjects people typed, and although the builder escapes them, "we escape it"
 * is a claim that has to stay true through every future edit to a 400-line
 * HTML template. The sandbox is the part that does not depend on remembering.
 *
 * srcDoc rather than a URL, so the content never becomes a page the browser
 * would treat as belonging to this origin.
 */
export function HandoverView({
  shiftId,
  height = "70vh",
}: {
  shiftId: string;
  height?: string;
}) {
  const handover = useHandover(shiftId);

  if (handover.isLoading) {
    return <p className="py-8 text-center text-sm text-muted">Building the handover…</p>;
  }
  if (handover.isError || !handover.data) {
    return (
      <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
        Could not build the handover: {String(handover.error)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
          Subject
        </span>
        <span className="text-xs">{handover.data.subject}</span>
      </div>
      <iframe
        title="Shift handover"
        sandbox=""
        srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#F8FAFC">${handover.data.html}</body>`}
        style={{ height }}
        className="w-full rounded-lg border border-border bg-white"
      />
    </div>
  );
}
