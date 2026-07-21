import { cn } from "@/lib/utils";

const toneMap = {
  green: "bg-accent-green",
  blue: "bg-accent-blue",
  orange: "bg-accent-orange",
  red: "bg-accent-red",
} as const;

export function LiveDot({
  tone = "green",
  className,
}: {
  tone?: keyof typeof toneMap;
  className?: string;
}) {
  return (
    <span className={cn("relative flex size-2", className)}>
      <span className={cn("pulse-dot absolute inline-flex size-2 rounded-full", toneMap[tone])} />
      <span className={cn("relative inline-flex size-2 rounded-full", toneMap[tone])} />
    </span>
  );
}
