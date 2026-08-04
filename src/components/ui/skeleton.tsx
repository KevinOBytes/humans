import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "bg-muted animate-pulse rounded-lg motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}
