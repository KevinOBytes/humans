"use client";

import { Moon, Monitor, Sun } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

const themes = [
  { label: "Light", value: "light", icon: Sun },
  { label: "Dark", value: "dark", icon: Moon },
  { label: "System", value: "system", icon: Monitor },
] as const;

export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label="Choose theme">
          <Sun aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="border-border bg-popover text-popover-foreground min-w-40 rounded-xl border p-1.5 shadow-xl"
        >
          <DropdownMenu.Group>
            {themes.map(({ icon: Icon, label, value }) => (
              <DropdownMenu.Item
                key={value}
                className="focus:bg-muted flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm outline-none"
                onSelect={() => setTheme(value)}
              >
                <Icon aria-hidden="true" />
                {label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
