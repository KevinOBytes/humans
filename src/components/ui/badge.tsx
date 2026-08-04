import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/12 text-primary",
        neutral: "border-border bg-muted text-muted-foreground",
        asserted: "border-asserted/30 bg-asserted/10 text-asserted-foreground",
        disputed: "border-disputed/30 bg-disputed/10 text-disputed-foreground",
        disproven:
          "border-disproven/30 bg-disproven/10 text-disproven-foreground",
        selected: "border-selected/40 bg-selected/12 text-selected-foreground",
        superseded:
          "border-superseded/30 bg-superseded/10 text-superseded-foreground",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
