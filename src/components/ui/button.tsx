import { Slot } from "radix-ui";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-55 motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        ghost: "text-foreground hover:bg-muted",
        outline:
          "border border-border bg-background text-foreground hover:bg-muted",
        secondary: "bg-muted text-foreground hover:bg-muted/75",
      },
      size: {
        default: "h-11",
        icon: "size-11 px-0",
        sm: "min-h-9 px-3 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, className, size, variant, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot.Root
          className={cn(buttonVariants({ size, variant }), className)}
          {...(props as ComponentPropsWithoutRef<typeof Slot.Root>)}
        />
      );
    }
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ size, variant }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
