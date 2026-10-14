import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Download, Terminal, FolderOpen, Cpu, Shield, Zap, CheckCircle2, Github } from "lucide-react";
import ResponsiveHeroBanner from "@/components/ui/responsive-hero-banner";

export const Route = createFileRoute("/landing")({
  head: () => ({
    meta: [{ title: "Calvras — Native AI Coding Agent" }],
  }),
  component: LandingPage,
});

const easeOut = [0.22, 1, 0.36, 1] as const;

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1, delayChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 12, filter: "blur(6px)" },
  visible: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.5, ease: easeOut } },
};

const mediaItem = {
  hidden: { opacity: 0, y: 24, filter: "blur(8px)" },
  visible: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.6, delay: 0.15, ease: easeOut } },
};

const DOWNLOAD_URL = "https://github.com/SHIKARI-hey/Calvras/releases/latest/download/Calvras-win-Setup.exe";

function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans overflow-x-hidden">

      {/* Hero with built-in nav */}
      <ResponsiveHeroBanner
        logoUrl="/calvras-logo.png"
        backgroundImageUrl="https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1600&q=80"
        navLinks={[
          { label: "Home", href: "/landing", isActive: true },
          { label: "Capabilities", href: "/capabilities" },
          { label: "Pricing", href: "/pricing" },
          { label: "GitHub", href: "https://github.com/SHIKARI-hey/Calvras" },
        ]}
        ctaButtonText="Download"
        ctaButtonHref={DOWNLOAD_URL}
        badgeLabel="New"
        badgeText="100% Native Windows & Cross-Platform Desktop App"
        title="Build Real Projects"
        titleLine2="With AI Autonomy"
        description="Calvras is a native desktop AI coding agent that reads, writes, and runs code directly on your machine. Full filesystem access, local CLI execution, and zero sandbox restrictions."
        primaryButtonText="Download for Windows (.exe)"
        primaryButtonHref={DOWNLOAD_URL}
        partnersTitle="Built on high-performance native technology"
        partners={[
          { logoUrl: "https://cdn.21st.dev/assets/mirror/96/964eca0b0415aebc2718799b530b39d6f552b39634f3fb2072e769df17c6668f.png", href: "#" },
          { logoUrl: "https://cdn.21st.dev/assets/mirror/90/900ad16bdb8bd723836996d2283c47420e719ba8c9a4f7d24ff67e59056e88fe.png", href: "#" },
          { logoUrl: "https://cdn.21st.dev/assets/mirror/1b/1b66b155997cb81da3bdabeb8da22771b07f4ac5273d6a19d629c77cf75a861f.png", href: "#" },
          { logoUrl: "https://cdn.21st.dev/assets/mirror/cb/cb112906d9fa8a57380201b1385c5534075020542dab48d5f29f2e35a3e19bc1.png", href: "#" },
          { logoUrl: "https://cdn.21st.dev/assets/mirror/f6/f68e2933c2f24ef4b28fb81328350831eb56bf42244dee50e2b7f6efd7497783.png", href: "#" },
        ]}
      />

      {/* Main pitch body */}
      <section className="bg-[#0a0a0a] relative isolate w-full overflow-hidden">
        <motion.div
          className="relative z-10 mx-auto flex max-w-6xl flex-col items-center px-6 py-20 sm:py-28 gap-10 sm:gap-14"
          variants={container}
          initial="hidden"
          whileInView="visible"
          viewport={{once: true, margin: "-80px"}}
        >
          <div className="flex w-full max-w-2xl flex-col items-center gap-5 sm:gap-6">
            <motion.div variants={item} className="flex flex-col items-center text-center gap-3 sm:gap-4">
              <h2 className="text-foreground text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-center text-white">
                Describe the task.<br />Ship the code.
              </h2>
              <p className="text-white/55 text-sm sm:text-base max-w-xl text-center">
                Turn a plain-language task into production-ready code across multiple files. Calvras reads, writes, runs commands, and self-corrects — autonomously directly on your computer.
              </p>
            </motion.div>
            <motion.div variants={item} className="flex flex-wrap items-center justify-center gap-3">
              <a
                href={DOWNLOAD_URL}
                download="Calvras-win-Setup.exe"
                className="inline-flex items-center gap-2 rounded-full bg-indigo-600 hover:bg-indigo-500 px-7 py-3.5 text-sm font-semibold text-white transition-all active:scale-[0.97] shadow-lg shadow-indigo-500/30"
              >
                <Download className="size-4" />
                Download for Windows (.exe)
              </a>
            </motion.div>
          </div>

          {/* App screenshot */}
          <motion.div variants={mediaItem} className="w-full">
            <div className="relative w-full overflow-hidden rounded-2xl outline outline-white/10">
              <img
                src="https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=1200&q=80"
                alt="Calvras coding agent in action"
                className="w-full h-[400px] object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <a
                  href={DOWNLOAD_URL}
                  download="Calvras-win-Setup.exe"
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600/40 border border-indigo-500/40 px-6 py-3 text-[14px] font-semibold text-white hover:bg-indigo-600/60 transition-colors backdrop-blur-md shadow-lg"
                >
                  <Download className="size-4" />
                  Download Calvras Desktop
                </a>
              </div>
            </div>
          </motion.div>

          {/* Technology badges */}
          <motion.div
            variants={item}
            className="flex w-full flex-wrap items-center justify-center border-t border-white/8 gap-x-10 gap-y-4 pt-8 sm:pt-10"
          >
            {[".NET 8", "Avalonia UI", "C#", "DirectX", "Skia", "Velopack", "SQLite"].map((tech) => (
              <span key={tech} className="text-white/30 text-sm font-semibold tracking-tight">{tech}</span>
            ))}
          </motion.div>
        </motion.div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 px-4 max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">Everything a local agent should be</h2>
          <p className="text-white/45 text-[16px]">Full control. Real access. No sandbox.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="group rounded-2xl border border-white/7 bg-white/3 p-6 hover:bg-white/5 hover:border-white/12 transition-all duration-200">
              <div className="mb-4 inline-flex size-10 items-center justify-center rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                <f.Icon className="size-5" />
              </div>
              <h3 className="text-[15px] font-semibold text-white mb-2">{f.title}</h3>
              <p className="text-[13px] text-white/45 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="py-24 px-4 max-w-3xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">How it works</h2>
          <p className="text-white/45 text-[16px]">Install once. Use forever. No cloud dependency.</p>
        </div>
        <div className="space-y-6">
          {STEPS.map((step, i) => (
            <div key={i} className="flex gap-5 items-start">
              <div className="shrink-0 size-9 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-[13px] font-bold text-indigo-400">{i + 1}</div>
              <div>
                <p className="text-[15px] font-semibold text-white mb-1">{step.title}</p>
                <p className="text-[13px] text-white/45 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 px-4">
        <div className="max-w-2xl mx-auto rounded-2xl border border-indigo-500/20 bg-gradient-to-br from-indigo-900/30 to-violet-900/20 p-10 text-center shadow-xl shadow-indigo-500/10">
          <h2 className="text-3xl font-bold text-white mb-4">Ready to build with Calvras?</h2>
          <p className="text-white/50 text-[15px] mb-8 leading-relaxed">Download the app. Open it. Start building. That's it.</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a
              href={DOWNLOAD_URL}
              download="Calvras-win-Setup.exe"
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-8 py-4 text-[15px] font-bold text-white transition-all active:scale-[0.97] shadow-lg shadow-indigo-500/30"
            >
              <Download className="size-5" />
              Download Calvras for Windows
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10 px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-[12px] text-white/25">
        <div className="flex items-center gap-2">
          <div className="size-5 rounded bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <Cpu className="size-3 text-white" />
          </div>
          <span className="font-semibold text-white/40">Calvras</span>
          <span>— Native Desktop AI Coding Agent</span>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/capabilities" className="hover:text-white/60 transition-colors">Capabilities</Link>
          <Link to="/pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          <a href="https://github.com/SHIKARI-hey/Calvras" target="_blank" rel="noopener noreferrer" className="hover:text-white/60 transition-colors flex items-center gap-1">
            <Github className="size-3.5" /> GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

const FEATURES = [
  { Icon: FolderOpen, title: "Real Filesystem Access", desc: "Calvras reads, creates, edits, and deletes files directly on your machine — just like any native app." },
  { Icon: Terminal, title: "Live Terminal Control", desc: "Run shell commands, start servers, install packages. Calvras executes real commands in your system terminal." },
  { Icon: Cpu, title: "Autonomous Agent Loop", desc: "Calvras thinks, plans, acts, and verifies — working autonomously for up to 8 iterations until your task is complete." },
  { Icon: Zap, title: "Blazing Fast Responses", desc: "Powered by the latest AI models with 16k token output. See code appear in real time as Calvras works." },
  { Icon: Shield, title: "Your Data Stays Local", desc: "Your files and code never leave your machine. Calvras operates entirely within your local environment." },
  { Icon: CheckCircle2, title: "Self-Correcting", desc: "After every command, Calvras reads the output and fixes errors automatically — no manual intervention needed." },
];

const STEPS = [
  { title: "Download & install", desc: "Run the installer (Calvras-win-Setup.exe on Windows). Takes under a minute. No Docker, no Python, no Node required." },
  { title: "Open Calvras", desc: "Launch the app like any other desktop program. A beautiful dark interface greets you, ready to work." },
  { title: "Give it a task", desc: "Type what you want to build — a web app, a script, a game. Calvras figures out the plan and gets to work." },
  { title: "Watch it build", desc: "Calvras creates files, runs commands, and iterates automatically. You see every step in real time." },
];
