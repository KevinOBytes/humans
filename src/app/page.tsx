import Link from "next/link";

import { ParallaxNetwork } from "@/components/marketing/parallax-network";

const productLinks = [
  { href: "#graph", label: "Graph" },
  { href: "#evidence", label: "Evidence" },
  { href: "#analysis", label: "AI analyst" },
];

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-xl border border-cyan-200/35 bg-cyan-300/10 text-cyan-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <circle cx="7" cy="7" r="2.25" />
          <circle cx="17" cy="8" r="2.25" />
          <circle cx="12" cy="17" r="2.25" />
          <path d="m8.9 8.3 6.2-.6M8.2 9l2.8 6M15.7 10l-2.5 5" />
        </svg>
      </span>
      <span
        className={
          compact
            ? "text-lg font-semibold tracking-tight"
            : "text-xl font-semibold tracking-tight"
        }
      >
        Humans
      </span>
    </span>
  );
}

function NetworkNode({
  x,
  y,
  tone = "cyan",
  size = 13,
}: {
  x: number;
  y: number;
  tone?: "cyan" | "amber" | "violet";
  size?: number;
}) {
  const colors = { cyan: "#67e8f9", amber: "#f5b94c", violet: "#a5b4fc" };
  return (
    <circle
      cx={x}
      cy={y}
      r={size}
      fill="#0c1114"
      stroke={colors[tone]}
      strokeWidth="1.6"
    />
  );
}

function ProductGraph() {
  return (
    <div className="relative aspect-[1.28] overflow-hidden rounded-2xl border border-white/10 bg-[#0d1215] shadow-2xl shadow-black/30">
      <div className="flex h-10 items-center gap-3 border-b border-white/10 px-4 text-[10px] text-zinc-500">
        <span className="font-semibold text-zinc-200">
          Westbridge investigation
        </span>
        <span className="ml-auto rounded-md border border-white/10 px-2 py-1">
          Search the graph…
        </span>
        <span className="size-2 rounded-full bg-cyan-300" />
      </div>
      <div className="grid h-[calc(100%-2.5rem)] grid-cols-[6.5rem_1fr_8.5rem]">
        <div className="hidden border-r border-white/10 p-3 text-[9px] text-zinc-500 sm:block">
          <p className="mb-3 tracking-[0.18em] uppercase">Workspace</p>
          <p className="rounded bg-cyan-300/10 px-2 py-1.5 text-cyan-100">
            Graph
          </p>
          <p className="mt-2 px-2 py-1.5">Table</p>
          <p className="px-2 py-1.5">Timeline</p>
          <p className="mt-5 mb-2 tracking-[0.18em] uppercase">Kinds</p>
          <p className="px-2 py-1">Key person</p>
          <p className="px-2 py-1">Organization</p>
          <p className="px-2 py-1">Evidence</p>
        </div>
        <div className="relative overflow-hidden">
          <svg
            viewBox="0 0 520 300"
            className="h-full w-full"
            fill="none"
            aria-hidden="true"
          >
            <g stroke="#4b6870" strokeWidth="1.2" strokeDasharray="4 4">
              <path d="M86 96 234 62l164 42-68 118-156-16Z" />
              <path d="M234 62 250 204m148-100-68 118M86 96l164 108m-70 0 154-100" />
            </g>
            <g stroke="#67e8f9" strokeWidth="1.8">
              <path d="M234 62 398 104" />
              <path d="M234 62 250 204" />
            </g>
            <g stroke="#f5b94c" strokeWidth="1.4" strokeDasharray="5 4">
              <path d="M250 204 196 260" />
              <path d="M250 204 332 260" />
            </g>
            <NetworkNode x={86} y={96} size={20} tone="cyan" />
            <NetworkNode x={234} y={62} size={24} tone="cyan" />
            <NetworkNode x={398} y={104} size={21} tone="violet" />
            <NetworkNode x={250} y={204} size={23} tone="cyan" />
            <NetworkNode x={182} y={188} size={18} tone="violet" />
            <NetworkNode x={352} y={222} size={18} tone="violet" />
            <NetworkNode x={196} y={260} size={10} tone="amber" />
            <NetworkNode x={332} y={260} size={10} tone="amber" />
            <g fill="#d6e3e5" fontSize="9" fontFamily="ui-monospace, monospace">
              <text x="234" y="34" textAnchor="middle">
                Jonathan Hale
              </text>
              <text x="250" y="244" textAnchor="middle">
                Westbridge Ltd.
              </text>
              <text x="86" y="130" textAnchor="middle">
                Marisa Chen
              </text>
              <text x="398" y="140" textAnchor="middle">
                David Lorne
              </text>
              <text x="196" y="282" textAnchor="middle" fill="#f5b94c">
                Transcript
              </text>
              <text x="332" y="282" textAnchor="middle" fill="#f5b94c">
                Contract.pdf
              </text>
            </g>
          </svg>
          <div className="absolute right-3 bottom-3 rounded-lg border border-white/10 bg-black/35 px-2 py-1 text-[9px] text-zinc-500">
            12 entities · 18 links
          </div>
        </div>
        <div className="border-l border-white/10 p-3 text-[9px] text-zinc-500">
          <p className="mb-3 font-semibold text-zinc-200">Inspector</p>
          <p className="text-cyan-200">Jonathan Hale</p>
          <p className="mt-2 leading-4">CEO, Westbridge Ltd.</p>
          <p className="mt-4 tracking-[0.16em] uppercase">Relationships</p>
          <p className="mt-2">reports to · board</p>
          <p>linked evidence · 3</p>
          <p className="mt-4 tracking-[0.16em] uppercase">Evidence</p>
          <p className="mt-2 text-amber-200">Hale interview transcript</p>
          <p className="mt-1 text-amber-200">Q4 advisory contract</p>
        </div>
      </div>
    </div>
  );
}

function EvidencePreview() {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0d1215] p-4 shadow-xl shadow-black/20 sm:p-5">
      <div className="flex items-start gap-3 border-b border-white/10 pb-4">
        <span className="grid size-9 place-items-center rounded-lg bg-amber-300/10 text-amber-200">
          ▤
        </span>
        <div>
          <p className="text-xs font-semibold text-zinc-100">
            Hale interview transcript
          </p>
          <p className="mt-1 text-[10px] text-zinc-500">
            Document · captured Jan 14, 2024
          </p>
        </div>
        <span className="ml-auto rounded-full border border-amber-200/20 px-2 py-1 text-[9px] text-amber-200">
          Observed
        </span>
      </div>
      <div className="grid gap-4 pt-4 text-[10px] text-zinc-500 sm:grid-cols-2">
        <div>
          <p className="tracking-[0.16em] uppercase">Source</p>
          <p className="mt-2 text-zinc-300">Interview with Jonathan Hale</p>
          <p className="mt-3 tracking-[0.16em] uppercase">Hash</p>
          <p className="mt-2 font-mono text-zinc-400">a7b2…d91c</p>
        </div>
        <div>
          <p className="tracking-[0.16em] uppercase">Linked to</p>
          <p className="mt-2 text-cyan-200">Jonathan Hale</p>
          <p className="mt-2 text-cyan-200">Westbridge Ltd.</p>
          <p className="mt-2 text-cyan-200">Q4 advisory contract</p>
        </div>
      </div>
    </div>
  );
}

function AnalystPreview() {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0d1215] p-4 shadow-xl shadow-black/20 sm:p-5">
      <div className="mb-4 flex items-center gap-2 text-xs font-semibold text-zinc-100">
        <span className="text-cyan-200">✦</span> AI analyst{" "}
        <span className="ml-auto text-[10px] font-normal text-zinc-600">
          workspace-scoped
        </span>
      </div>
      <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-[10px] leading-5 text-zinc-400">
        Show all entities tied to{" "}
        <span className="text-cyan-200">Apex Strategies</span> and summarize the
        nature of their relationships.
      </div>
      <div className="mt-3 rounded-xl border border-cyan-200/10 bg-cyan-300/[0.03] p-3 text-[10px] text-zinc-300">
        <div className="grid grid-cols-[1fr_0.8fr_1fr] gap-2 border-b border-white/10 pb-2 text-[9px] tracking-[0.12em] text-zinc-600 uppercase">
          <span>Entity</span>
          <span>Type</span>
          <span>Evidence</span>
        </div>
        <div className="grid grid-cols-[1fr_0.8fr_1fr] gap-2 pt-2">
          <span>Westbridge Ltd.</span>
          <span>Organization</span>
          <span className="text-amber-200">Contract.pdf</span>
        </div>
        <div className="mt-2 grid grid-cols-[1fr_0.8fr_1fr] gap-2">
          <span>Marisa Chen</span>
          <span>Key person</span>
          <span className="text-amber-200">Transcript</span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-svh overflow-hidden bg-[#080b0d] text-[#f4f0e9] selection:bg-cyan-200/20">
      <div className="relative isolate">
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[48rem] bg-[radial-gradient(circle_at_70%_25%,rgba(34,211,238,0.12),transparent_33%),radial-gradient(circle_at_10%_15%,rgba(129,140,248,0.08),transparent_28%)]" />
        <div className="pointer-events-none absolute inset-0 -z-10 [background-image:linear-gradient(rgba(255,255,255,0.7)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.7)_1px,transparent_1px)] [mask-image:linear-gradient(to_bottom,black,transparent_55%)] [background-size:64px_64px] opacity-[0.08]" />

        <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
          <Link href="/" aria-label="Humans home">
            <Logo compact />
          </Link>
          <nav
            aria-label="Primary navigation"
            className="hidden items-center gap-8 text-sm text-zinc-400 md:flex"
          >
            {productLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="transition hover:text-white"
              >
                {link.label}
              </a>
            ))}
            <Link
              href="/sign-in"
              className="rounded-lg border border-cyan-200/40 px-4 py-2 text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/10"
            >
              Sign in
            </Link>
          </nav>
          <Link
            href="/sign-in"
            className="rounded-lg border border-cyan-200/40 px-3 py-2 text-xs text-cyan-100 md:hidden"
          >
            Sign in
          </Link>
        </header>

        <section className="relative mx-auto grid max-w-7xl items-center gap-10 px-5 pt-16 pb-20 sm:px-8 sm:pt-24 lg:grid-cols-[0.88fr_1.12fr] lg:gap-14 lg:px-10 lg:pt-28 lg:pb-28">
          <ParallaxNetwork />
          <div className="relative z-10 max-w-2xl">
            <p className="mb-6 text-xs font-semibold tracking-[0.24em] text-cyan-200 uppercase">
              Open-source research workspace
            </p>
            <h1 className="max-w-xl text-5xl leading-[0.98] font-medium tracking-[-0.045em] text-[#f4f0e9] sm:text-6xl lg:text-7xl">
              Map the people, claims, and sources behind a story.
            </h1>
            <p className="mt-7 max-w-lg text-base leading-7 text-zinc-400 sm:text-lg">
              Humans helps research teams connect people, facts, relationships,
              and evidence in one auditable workspace.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/sign-in"
                className="inline-flex min-h-12 items-center justify-center rounded-lg bg-cyan-300 px-5 text-sm font-semibold text-zinc-950 shadow-[0_14px_40px_-16px_rgba(103,232,249,0.9)] transition hover:bg-cyan-200"
              >
                Sign in to your workspace{" "}
                <span aria-hidden="true" className="ml-2">
                  ↗
                </span>
              </Link>
              <a
                href="#graph"
                className="inline-flex min-h-12 items-center justify-center rounded-lg border border-white/15 px-5 text-sm text-zinc-200 transition hover:border-white/30 hover:bg-white/[0.04]"
              >
                See how it works{" "}
                <span aria-hidden="true" className="ml-2">
                  ↓
                </span>
              </a>
            </div>
            <p className="mt-5 text-xs text-zinc-600">
              Private by workspace. Auditable by design.
            </p>
          </div>
          <div className="relative z-10 lg:pt-12">
            <ProductGraph />
          </div>
        </section>
      </div>

      <section
        id="graph"
        className="mx-auto max-w-7xl scroll-mt-10 border-t border-white/10 px-5 py-20 sm:px-8 lg:px-10 lg:py-28"
      >
        <div className="grid items-center gap-10 lg:grid-cols-[0.6fr_1fr] lg:gap-20">
          <div>
            <p className="text-xs font-semibold tracking-[0.2em] text-cyan-200 uppercase">
              01 · Explore the graph
            </p>
            <h2 className="mt-5 max-w-md text-4xl leading-tight font-medium tracking-[-0.03em] sm:text-5xl">
              See how a story connects.
            </h2>
            <p className="mt-5 max-w-md leading-7 text-zinc-400">
              Filter people, organizations, claims, and sources. Trace a
              relationship without losing the context that supports it.
            </p>
            <Link
              href="/graph"
              className="mt-7 inline-flex text-sm text-cyan-200 underline decoration-cyan-200/40 underline-offset-4 hover:text-cyan-100"
            >
              Open the graph workspace{" "}
              <span aria-hidden="true" className="ml-2">
                ↗
              </span>
            </Link>
          </div>
          <ProductGraph />
        </div>
      </section>

      <section
        id="evidence"
        className="scroll-mt-10 border-y border-white/10 bg-white/[0.02]"
      >
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[1fr_0.7fr] lg:gap-24 lg:px-10 lg:py-28">
          <EvidencePreview />
          <div>
            <p className="text-xs font-semibold tracking-[0.2em] text-amber-200 uppercase">
              02 · Link evidence to records
            </p>
            <h2 className="mt-5 max-w-md text-4xl leading-tight font-medium tracking-[-0.03em] sm:text-5xl">
              Keep provenance close to the claim.
            </h2>
            <p className="mt-5 max-w-md leading-7 text-zinc-400">
              Attach documents, transcripts, notes, and sources to any person or
              relationship. Evidence stays addressable, reviewable, and in the
              workspace where it belongs.
            </p>
            <Link
              href="/evidence"
              className="mt-7 inline-flex text-sm text-cyan-200 underline decoration-cyan-200/40 underline-offset-4 hover:text-cyan-100"
            >
              Browse evidence{" "}
              <span aria-hidden="true" className="ml-2">
                ↗
              </span>
            </Link>
          </div>
        </div>
      </section>

      <section
        id="analysis"
        className="mx-auto max-w-7xl scroll-mt-10 px-5 py-20 sm:px-8 lg:px-10 lg:py-28"
      >
        <div className="grid items-center gap-10 lg:grid-cols-[0.6fr_1fr] lg:gap-20">
          <div>
            <p className="text-xs font-semibold tracking-[0.2em] text-indigo-200 uppercase">
              03 · Ask your AI analyst
            </p>
            <h2 className="mt-5 max-w-md text-4xl leading-tight font-medium tracking-[-0.03em] sm:text-5xl">
              Query the graph in plain language.
            </h2>
            <p className="mt-5 max-w-md leading-7 text-zinc-400">
              Use an OpenAI-compatible provider or a local Ollama instance to
              find connections and summarize what the evidence supports. Results
              stay scoped to your workspace.
            </p>
            <Link
              href="/analyst"
              className="mt-7 inline-flex text-sm text-cyan-200 underline decoration-cyan-200/40 underline-offset-4 hover:text-cyan-100"
            >
              Open the AI analyst{" "}
              <span aria-hidden="true" className="ml-2">
                ↗
              </span>
            </Link>
          </div>
          <AnalystPreview />
        </div>
      </section>

      <section className="border-y border-amber-200/20 bg-[radial-gradient(circle_at_50%_0%,rgba(245,185,76,0.1),transparent_45%)] px-5 py-20 text-center sm:px-8 lg:py-24">
        <div className="mx-auto max-w-3xl">
          <div className="mx-auto grid size-12 place-items-center rounded-full border border-amber-200/30 text-amber-200">
            ⌁
          </div>
          <h2 className="mt-6 text-3xl leading-tight font-medium tracking-[-0.03em] sm:text-5xl">
            Research with clarity. Backed by evidence. Private by design.
          </h2>
          <p className="mx-auto mt-5 max-w-xl leading-7 text-zinc-400">
            Humans is built for careful, collaborative investigation—without
            locking your data inside a black box.
          </p>
          <Link
            href="/sign-in"
            className="mt-8 inline-flex min-h-12 items-center justify-center rounded-lg border border-cyan-200/50 px-6 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-200/10"
          >
            Sign in to your workspace{" "}
            <span aria-hidden="true" className="ml-2">
              ↗
            </span>
          </Link>
        </div>
      </section>

      <footer className="mx-auto grid max-w-7xl gap-10 px-5 py-12 text-sm text-zinc-500 sm:px-8 md:grid-cols-[1.3fr_1fr_1fr_1fr] lg:px-10">
        <div>
          <Link href="/" aria-label="Humans home">
            <Logo />
          </Link>
          <p className="mt-4 max-w-xs leading-6">
            An open-source research application for mapping people, claims, and
            sources.
          </p>
        </div>
        <div>
          <p className="mb-4 text-xs font-semibold tracking-[0.16em] text-zinc-300 uppercase">
            Product
          </p>
          <div className="space-y-2">
            <Link className="block hover:text-white" href="/graph">
              Graph
            </Link>
            <Link className="block hover:text-white" href="/people">
              People
            </Link>
            <Link className="block hover:text-white" href="/evidence">
              Evidence
            </Link>
            <Link className="block hover:text-white" href="/search">
              Search
            </Link>
          </div>
        </div>
        <div>
          <p className="mb-4 text-xs font-semibold tracking-[0.16em] text-zinc-300 uppercase">
            Workspace
          </p>
          <div className="space-y-2">
            <Link className="block hover:text-white" href="/sign-in">
              Sign in
            </Link>
            <Link className="block hover:text-white" href="/sign-up">
              Create an account
            </Link>
            <Link className="block hover:text-white" href="/analyst">
              AI analyst
            </Link>
          </div>
        </div>
        <div>
          <p className="mb-4 text-xs font-semibold tracking-[0.16em] text-zinc-300 uppercase">
            Project
          </p>
          <div className="space-y-2">
            <a
              className="block hover:text-white"
              href="https://github.com/KevinOBytes/humans"
            >
              GitHub
            </a>
            <a
              className="block hover:text-white"
              href="https://github.com/KevinOBytes/humans/tree/main/docs"
            >
              Documentation
            </a>
            <p>Open source. Secure. Yours.</p>
          </div>
        </div>
        <div className="border-t border-white/10 pt-6 text-xs text-zinc-600 md:col-span-4 md:flex md:items-center md:justify-between">
          <span>© 2026 Humans Project</span>
          <span className="flex gap-5">
            <a
              href="https://github.com/KevinOBytes/humans/blob/main/SECURITY.md"
              className="hover:text-zinc-300"
            >
              Security
            </a>
            <a
              href="https://github.com/KevinOBytes/humans/blob/main/README.md#security-and-privacy"
              className="hover:text-zinc-300"
            >
              Privacy
            </a>
          </span>
        </div>
      </footer>
    </main>
  );
}
