import type { ReactNode } from "react";

export function SettingsHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header>
      <p className="text-primary text-sm font-semibold">{eyebrow}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-6">
        {description}
      </p>
    </header>
  );
}

export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-2xl border p-5 sm:p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? (
        <p className="text-muted-foreground mt-1 text-sm leading-6">
          {description}
        </p>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function ReadOnlyAdministrationNotice() {
  return (
    <div
      role="note"
      className="border-border bg-muted/50 rounded-xl border p-4 text-sm leading-6"
    >
      <p className="font-semibold">Administration is read-only</p>
      <p className="text-muted-foreground mt-1">
        Changes are withheld until Better Auth mutations can preserve owner
        invariants and application audit records atomically.
      </p>
    </div>
  );
}

export function DefinitionList({
  items,
}: {
  items: readonly { label: string; value: ReactNode }[];
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {item.label}
          </dt>
          <dd className="mt-1 text-sm font-medium break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
