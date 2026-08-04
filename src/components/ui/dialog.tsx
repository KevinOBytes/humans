"use client";

import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="bg-foreground/35 fixed inset-0 z-50 backdrop-blur-[2px] data-[state=closed]:animate-none" />
      <DialogPrimitive.Content
        className={cn(
          "border-border bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 max-h-[90svh] w-[min(92vw,36rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border p-6 shadow-2xl outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-lg font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground mt-1 text-sm leading-6", className)}
      {...props}
    />
  );
}
