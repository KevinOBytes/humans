import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/25 min-h-11 w-full rounded-xl border px-3.5 text-[16px] transition-colors outline-none focus-visible:ring-2 disabled:opacity-60 sm:text-sm",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
