import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Download,
  Terminal,
  FolderOpen,
  Cpu,
  Shield,
  Zap,
  ArrowRight,
  Github,
  Star,
  CheckCircle2,
  ChevronRight,
} from "lucide-react";

export const Route = createFileRoute("/landing")({
  head: () => ({
    meta: [{ title: "Calvras — Your Local AI Coding Agent" }],
  }),
  component: LandingPage,
});

function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans overflow-x-hidden">
      {/* ── Nav ──────────────────────────────────────────────── */}
      <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 py-4 border-b border-white/5 bg-[#0a0a0a]/90 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <Cpu className="size-4 text-white" />
          </div>
          <span className="text-[15px] font-bold tracking-tight text-white">Calvras</span>
        </div>
        <div className="hidden md:flex items-center gap-6 text-[13px] text-white/50">
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a href="#how-it-works" className="hover:text-white transition-colors">How it works</a>
          <Link to="/pricing" className="hover:text-white transition-colors">Pricing</Link>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="hidden sm:inline-flex items-center gap-1.5 text-[13px] text-white/60 hover:text-white transition-colors"
          >
            Open App
            <ChevronRight className="size-3.5" />
          </Link>
          <a
            href="#download"
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-[13px] font-semibold text-white transition-all active:scale-[0.97] shadow-lg shadow-indigo-500/20"
          >
            <Download className="size-3.5" />
            Download
          </a>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="relative flex flex-col items-center justify-center text-center pt-36 pb-24 px-4">
        {/* Glow */}
        <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-indigo-600/10 blur-[120px] rounded-full" />

        {/* Badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3.5 py-1.5 text-[12px] font-medium text-indigo-300">
          <Star className="size-3 fill-indigo-300" />
          Now available for Windows &amp; macOS
        </div>

        <h1 className="relative text-5xl sm:text-6xl md:text-7xl font-extrabold tracking-tight leading-[1.05] max-w-3xl mb-6">
          <span className="text-white">Your AI coding agent,</span>
          <br />
          <span className="bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
            running locally.
          </span>
        </h1>

        <p className="max-w-xl text-[17px] text-white/55 leading-relaxed mb-10">
          Calvras is a desktop application that gives you a full AI coding agent
          with real filesystem access, terminal control, and live code editing —
          no browser, no server, no limits.
        </p>

        {/* CTA buttons */}
        <div id="download" className="flex flex-wrap items-center justify-center gap-3">
          <a
            href="/calvras-setup.exe"
            download
            className="inline-flex items-center gap-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-7 py-3.5 text-[15px] font-bold text-white transition-all active:scale-[0.97] shadow-xl shadow-indigo-500/30"
          >
            <Download className="size-5" />
            Download for Windows
            <span className="ml-1 text-indigo-200/60 text-[12px] font-normal">(.exe)</span>
          </a>
          <a
            href="/calvras-setup.dmg"
            download
            className="inline-flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-7 py-3.5 text-[15px] font-semibold text-white/80 hover:text-white transition-all active:scale-[0.97]"
          >
            Download for macOS
            <span className="ml-1 text-white/30 text-[12px] font-normal">(.dmg)</span>
          </a>
        </div>

        <p className="mt-4 text-[12px] text-white/25">
          Free to download · No account required to start
        </p>

        {/* App screenshot placeholder */}
        <div className="relative mt-16 w-full max-w-4xl mx-auto rounded-2xl border border-white/8 bg-[#141414] shadow-2xl shadow-black/60 overflow-hidden">
          <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/6">
            <span className="size-3 rounded-full bg-red-500/70" />
            <span className="size-3 rounded-full bg-amber-500/70" />
            <span className="size-3 rounded-full bg-emerald-500/70" />
            <span className="ml-3 text-[12px] text-white/30 font-mono">Calvras — AI Coding Agent</span>
          </div>
          <div className="flex h-64 items-center justify-center">
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600/20 border border-indigo-500/30 px-6 py-3 text-[14px] font-medium text-indigo-300 hover:bg-indigo-600/30 transition-colors"
            >
              Open App Preview
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────── */}
      <section id="features" className="py-24 px-4 max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">
            Everything a local agent should be
          </h2>
          <p className="text-white/45 text-[16px]">
            Full control. Real access. No sandbox.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="group rounded-2xl border border-white/7 bg-white/3 p-6 hover:bg-white/5 hover:border-white/12 transition-all duration-200"
            >
              <div className="mb-4 inline-flex size-10 items-center justify-center rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                <f.Icon className="size-5" />
              </div>
              <h3 className="text-[15px] font-semibold text-white mb-2">{f.title}</h3>
              <p className="text-[13px] text-white/45 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────── */}
      <section id="how-it-works" className="py-24 px-4 max-w-3xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">How it works</h2>
          <p className="text-white/45 text-[16px]">
            Install once. Use forever. No cloud dependency.
          </p>
        </div>
        <div className="space-y-6">
          {STEPS.map((step, i) => (
            <div key={i} className="flex gap-5 items-start">
              <div className="shrink-0 size-9 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-[13px] font-bold text-indigo-400">
                {i + 1}
              </div>
              <div>
                <p className="text-[15px] font-semibold text-white mb-1">{step.title}</p>
                <p className="text-[13px] text-white/45 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────── */}
      <section className="py-24 px-4">
        <div className="max-w-2xl mx-auto rounded-2xl border border-indigo-500/20 bg-gradient-to-br from-indigo-900/30 to-violet-900/20 p-10 text-center shadow-xl shadow-indigo-500/10">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to build with Calvras?
          </h2>
          <p className="text-white/50 text-[15px] mb-8 leading-relaxed">
            Download the app. Open it. Start building. That's it.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a
              href="/calvras-setup.exe"
              download
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-7 py-3.5 text-[15px] font-bold text-white transition-all active:scale-[0.97] shadow-lg shadow-indigo-500/30"
            >
              <Download className="size-5" />
              Download Calvras
            </a>
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-[14px] text-white/50 hover:text-white transition-colors"
            >
              Try in browser
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="border-t border-white/5 py-10 px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-[12px] text-white/25">
        <div className="flex items-center gap-2">
          <div className="size-5 rounded bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <Cpu className="size-3 text-white" />
          </div>
          <span className="font-semibold text-white/40">Calvras</span>
          <span>— Local AI Coding Agent</span>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          <Link to="/" className="hover:text-white/60 transition-colors">App</Link>
          <a href="https://github.com/SHIKARI-hey/Calvras" target="_blank" rel="noopener noreferrer" className="hover:text-white/60 transition-colors flex items-center gap-1">
            <Github className="size-3.5" /> GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

const FEATURES = [
  {
    Icon: FolderOpen,
    title: "Real Filesystem Access",
    desc: "Calvras reads, creates, edits, and deletes files directly on your machine — just like any native app.",
  },
  {
    Icon: Terminal,
    title: "Live Terminal Control",
    desc: "Run shell commands, start servers, install packages. Calvras executes real commands in your system terminal.",
  },
  {
    Icon: Cpu,
    title: "Autonomous Agent Loop",
    desc: "Calvras thinks, plans, acts, and verifies — working autonomously until your task is complete without interruption.",
  },
  {
    Icon: Zap,
    title: "Blazing Fast Responses",
    desc: "Powered by the latest AI models with streaming output. See code appear in real time as Calvras works.",
  },
  {
    Icon: Shield,
    title: "Your Data Stays Local",
    desc: "Your files and code never leave your machine. Calvras operates entirely within your local environment.",
  },
  {
    Icon: CheckCircle2,
    title: "Works Offline",
    desc: "Once installed, Calvras works even without an internet connection using its built-in local AI capabilities.",
  },
];

const STEPS = [
  {
    title: "Download & install",
    desc: "Run the installer (.exe on Windows, .dmg on macOS). Takes under a minute. No Docker, no Python, no Node required.",
  },
  {
    title: "Open Calvras",
    desc: "Launch the app like any other desktop program. A beautiful dark interface greets you, ready to work.",
  },
  {
    title: "Give it a task",
    desc: "Type what you want to build — a web app, a script, a game. Calvras figures out the plan and gets to work.",
  },
  {
    title: "Watch it build",
    desc: "Calvras creates files, runs commands, and iterates automatically. You see every step in real time.",
  },
];
