import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-muted-foreground",
        blue: "border-accent-blue/20 bg-accent-blue-soft text-accent-blue",
        green: "border-accent-green/20 bg-accent-green-soft text-accent-green",
        red: "border-accent-red/20 bg-accent-red-soft text-accent-red",
        orange: "border-accent-orange/20 bg-accent-orange-soft text-accent-orange",
        purple: "border-accent-purple/20 bg-accent-purple-soft text-accent-purple",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
