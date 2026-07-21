"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

export function Switch({
  defaultChecked = false,
  label,
  description,
}: {
  defaultChecked?: boolean;
  label?: string;
  description?: string;
}) {
  const [on, setOn] = useState(defaultChecked);
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4">
      {label || description ? (
        <span className="flex flex-col">
          {label ? <span className="text-sm text-foreground">{label}</span> : null}
          {description ? <span className="text-xs text-muted">{description}</span> : null}
        </span>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => setOn((v) => !v)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          on ? "bg-accent-blue" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 translate-x-0.5 rounded-full bg-white transition-transform",
            on && "translate-x-[18px]",
          )}
        />
      </button>
    </label>
  );
}
