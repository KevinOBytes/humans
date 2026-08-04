import Link from "next/link";
import type { InputHTMLAttributes, ReactNode } from "react";

type AuthShellProps = {
  children: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
  footer?: ReactNode;
  wide?: boolean;
};

export const primaryButtonClassName =
  "inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_12px_35px_-14px_rgba(103,232,249,0.85)] transition hover:bg-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButtonClassName =
  "inline-flex min-h-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 disabled:cursor-not-allowed disabled:opacity-60";

export const textLinkClassName =
  "font-medium text-cyan-200 underline-offset-4 transition hover:text-cyan-100 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200";

export function AuthShell({
  children,
  eyebrow,
  title,
  description,
  footer,
  wide = false,
}: AuthShellProps) {
  return (
    <main className="relative min-h-svh overflow-hidden bg-zinc-950 text-zinc-50">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle_at_15%_20%,rgba(34,211,238,0.15),transparent_28%),radial-gradient(circle_at_85%_82%,rgba(99,102,241,0.13),transparent_30%)] opacity-80"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [background-image:linear-gradient(rgba(255,255,255,0.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.8)_1px,transparent_1px)] [background-size:44px_44px] opacity-[0.04]"
      />

      <div className="relative mx-auto grid min-h-svh max-w-[1500px] lg:grid-cols-[minmax(0,1.05fr)_minmax(30rem,0.95fr)]">
        <AuthStory />

        <section className="flex min-h-svh items-center justify-center px-5 py-10 sm:px-8 lg:px-12">
          <div className={wide ? "w-full max-w-2xl" : "w-full max-w-md"}>
            <Link
              href="/"
              className="mb-10 inline-flex items-center gap-3 lg:hidden"
              aria-label="Humans home"
            >
              <LogoMark />
              <span className="text-lg font-semibold tracking-tight">
                Humans
              </span>
            </Link>

            <div className="rounded-3xl border border-white/10 bg-zinc-900/75 p-6 shadow-2xl shadow-black/35 backdrop-blur-xl sm:p-8">
              <header className="mb-7">
                {eyebrow ? (
                  <p className="mb-3 text-xs font-semibold tracking-[0.18em] text-cyan-200 uppercase">
                    {eyebrow}
                  </p>
                ) : null}
                <h1 className="text-3xl font-semibold tracking-tight text-white">
                  {title}
                </h1>
                <p className="mt-3 text-sm leading-6 text-zinc-400">
                  {description}
                </p>
              </header>

              {children}
            </div>

            {footer ? (
              <div className="mt-6 text-center text-sm text-zinc-400">
                {footer}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function AuthStory() {
  return (
    <aside className="relative hidden min-h-svh overflow-hidden border-r border-white/[0.07] px-14 py-12 lg:flex lg:flex-col lg:justify-between">
      <Link
        href="/"
        className="relative z-10 inline-flex w-fit items-center gap-3"
        aria-label="Humans home"
      >
        <LogoMark />
        <span className="text-xl font-semibold tracking-tight">Humans</span>
      </Link>

      <div className="relative z-10 max-w-xl pb-8">
        <div className="mb-10 max-w-lg" aria-hidden="true">
          <NetworkGraphic />
        </div>
        <p className="text-xs font-semibold tracking-[0.2em] text-cyan-200 uppercase">
          Evidence in context
        </p>
        <p className="mt-5 text-4xl leading-[1.12] font-medium tracking-tight text-white xl:text-5xl">
          Map the people, claims, and sources behind a story.
        </p>
        <p className="mt-6 max-w-lg text-base leading-7 text-zinc-400">
          Humans gives research teams a secure workspace for building
          evidence-backed social networks without losing provenance.
        </p>
      </div>

      <p className="relative z-10 text-xs text-zinc-600">
        Private by workspace. Auditable by design.
      </p>
    </aside>
  );
}

function LogoMark() {
  return (
    <span className="grid size-9 place-items-center rounded-xl border border-cyan-200/30 bg-cyan-300/10 text-cyan-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <circle cx="7" cy="7" r="2.25" />
        <circle cx="17" cy="8" r="2.25" />
        <circle cx="12" cy="17" r="2.25" />
        <path d="m8.9 8.3 6.2-.6M8.2 9l2.8 6M15.7 10l-2.5 5" />
      </svg>
    </span>
  );
}

function NetworkGraphic() {
  return (
    <svg
      viewBox="0 0 600 310"
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label="A network of connected people and evidence"
    >
      <defs>
        <linearGradient id="auth-network-line" x1="0" x2="1">
          <stop stopColor="#67e8f9" stopOpacity="0.25" />
          <stop offset="1" stopColor="#818cf8" stopOpacity="0.5" />
        </linearGradient>
        <filter
          id="auth-network-glow"
          x="-80%"
          y="-80%"
          width="260%"
          height="260%"
        >
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>
      <g stroke="url(#auth-network-line)" strokeWidth="1.5">
        <path d="M70 158 184 70 306 134 432 54 526 154 416 244 276 250 150 224Z" />
        <path d="m184 70-34 154m156-90-30 116m156-196-16 190M70 158l236-24m-156 90 282-170m-156 196 250-96" />
      </g>
      <g fill="#22d3ee" opacity="0.18" filter="url(#auth-network-glow)">
        <circle cx="306" cy="134" r="28" />
        <circle cx="416" cy="244" r="23" />
      </g>
      <g fill="#09090b" strokeWidth="2">
        <Node cx={70} cy={158} radius={11} label="Source" />
        <Node cx={184} cy={70} radius={14} label="Person" accent />
        <Node cx={306} cy={134} radius={17} label="Person" accent />
        <Node cx={432} cy={54} radius={10} label="Fact" />
        <Node cx={526} cy={154} radius={14} label="Person" accent />
        <Node cx={416} cy={244} radius={12} label="Evidence" />
        <Node cx={276} cy={250} radius={15} label="Person" accent />
        <Node cx={150} cy={224} radius={9} label="Fact" />
      </g>
    </svg>
  );
}

function Node({
  cx,
  cy,
  radius,
  label,
  accent = false,
}: {
  cx: number;
  cy: number;
  radius: number;
  label: string;
  accent?: boolean;
}) {
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        stroke={accent ? "#67e8f9" : "#818cf8"}
      />
      <circle
        cx={cx}
        cy={cy}
        r={Math.max(2, radius / 3)}
        fill={accent ? "#67e8f9" : "#818cf8"}
      />
      <text
        x={cx}
        y={cy + radius + 18}
        textAnchor="middle"
        fill="#71717a"
        stroke="none"
        fontSize="10"
        fontFamily="var(--font-geist-mono)"
      >
        {label}
      </text>
    </g>
  );
}

type FieldProps = {
  label: string;
  hint?: string;
  inputClassName?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export function Field({
  label,
  hint,
  id,
  inputClassName,
  ...inputProps
}: FieldProps) {
  if (!id) {
    throw new Error("Auth form fields require an id");
  }

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block text-sm font-medium text-zinc-200"
      >
        {label}
      </label>
      <input
        id={id}
        {...inputProps}
        aria-describedby={hint ? `${id}-hint` : inputProps["aria-describedby"]}
        className={`min-h-11 w-full rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 text-[16px] text-white transition outline-none placeholder:text-zinc-600 focus:border-cyan-300/60 focus:ring-3 focus:ring-cyan-300/10 sm:text-sm ${inputClassName ?? ""}`}
      />
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs leading-5 text-zinc-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function AuthStatus({
  kind,
  children,
}: {
  kind: "error" | "success" | "info";
  children: ReactNode;
}) {
  const styles = {
    error: "border-rose-300/20 bg-rose-300/10 text-rose-100",
    success: "border-emerald-300/20 bg-emerald-300/10 text-emerald-100",
    info: "border-cyan-300/20 bg-cyan-300/10 text-cyan-100",
  } as const;

  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
      className={`rounded-xl border px-3.5 py-3 text-sm leading-5 ${styles[kind]}`}
    >
      {children}
    </div>
  );
}
