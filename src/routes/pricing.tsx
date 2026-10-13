import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Sparkles, Zap, Shield, ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [{ title: "Pricing & Plans — Calvras" }],
  }),
  component: PricingPage,
});

function PricingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased selection:bg-muted py-12 px-4 sm:px-6 lg:px-8">
      {/* Top back navigation */}
      <div className="max-w-6xl mx-auto mb-8">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-lg border border-border/80 bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-card transition-colors shadow-xs"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to Calvras</span>
        </Link>
      </div>

      {/* Header section */}
      <div className="max-w-3xl mx-auto text-center mb-16">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground mb-4">
          <Sparkles className="h-3 w-3 text-amber-500" />
          <span>Elevate Your Autonomous Engineering</span>
        </div>
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl text-foreground">
          Predictable Pricing for Autonomous Power
        </h1>
        <p className="mt-4 text-base text-muted-foreground leading-relaxed">
          Scale your local coding speed with continuous inference, unlimited projects, multimodal workspace awareness, and zero queue delays.
        </p>
      </div>

      {/* Pricing Cards Grid */}
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8 items-stretch">
        {/* FREE TIER */}
        <div className="relative flex flex-col justify-between rounded-2xl border border-border bg-card/60 p-7 shadow-xs backdrop-blur-md">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-foreground">Starter</h2>
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                Current Plan
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Essential autonomous coding directly on your local Desktop.
            </p>
            <div className="mt-6 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-foreground">$0</span>
              <span className="text-xs text-muted-foreground">/ month</span>
            </div>

            <ul className="mt-8 space-y-3.5 text-xs text-foreground/90">
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Standard generation speed</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Local Desktop filesystem actions</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Basic multi-engine fallback</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Community support</span>
              </li>
            </ul>
          </div>

          <button
            type="button"
            disabled
            className="mt-8 w-full rounded-xl border border-border bg-muted/40 py-2.5 text-xs font-semibold text-muted-foreground cursor-not-allowed text-center"
          >
            Active Plan
          </button>
        </div>

        {/* PRO TIER — $9 */}
        <div className="relative flex flex-col justify-between rounded-2xl border-2 border-primary/80 bg-card p-7 shadow-xl shadow-primary/5">
          <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-[11px] font-bold text-primary-foreground tracking-wide uppercase shadow-sm">
            Most Popular
          </div>
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                <span>Pro</span>
                <Sparkles className="h-4 w-4 text-amber-500" />
              </h2>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Supercharged intelligence, web search research, and extended memory.
            </p>
            <div className="mt-6 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-foreground">$9</span>
              <span className="text-xs text-muted-foreground">/ month</span>
            </div>

            <ul className="mt-8 space-y-3.5 text-xs text-foreground/90">
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span className="font-medium text-foreground">Significantly higher inference usage limits</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Real-time web search & live documentation research</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Expanded project memory & deep context window</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Early access to newest experimental models & features</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Instant multi-engine router priority</span>
              </li>
            </ul>
          </div>

          <button
            type="button"
            onClick={() => alert("Checkout integration placeholder: Upgrading to Calvras Pro ($9/mo)")}
            className="mt-8 w-full rounded-xl bg-primary py-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-all shadow-md active:scale-[0.98] cursor-pointer"
          >
            Upgrade to Pro
          </button>
        </div>

        {/* ULTRA TIER — $20 */}
        <div className="relative flex flex-col justify-between rounded-2xl border border-border/80 bg-card/80 p-7 shadow-lg backdrop-blur-md">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                <span>Ultra</span>
                <Zap className="h-4 w-4 text-sky-400" />
              </h2>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Unrestricted engineering tier for power users and heavy production builds.
            </p>
            <div className="mt-6 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-foreground">$20</span>
              <span className="text-xs text-muted-foreground">/ month</span>
            </div>

            <ul className="mt-8 space-y-3.5 text-xs text-foreground/90">
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span className="font-semibold text-foreground">10x higher usage limits than Pro & standard users</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Everything included in Pro tier</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Full multimodal video inspection & screen workflow uploads</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Guaranteed zero-queue priority access during peak peak traffic</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <span>Dedicated low-latency inference cluster routing</span>
              </li>
            </ul>
          </div>

          <button
            type="button"
            onClick={() => alert("Checkout integration placeholder: Upgrading to Calvras Ultra ($20/mo)")}
            className="mt-8 w-full rounded-xl border border-border bg-foreground py-2.5 text-xs font-semibold text-background hover:opacity-90 transition-all shadow-md active:scale-[0.98] cursor-pointer"
          >
            Upgrade to Ultra
          </button>
        </div>
      </div>

      {/* Feature comparison guarantee */}
      <div className="max-w-4xl mx-auto mt-20 text-center border-t border-border/60 pt-10">
        <div className="flex flex-wrap items-center justify-center gap-8 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            No long-term commitments, cancel anytime
          </span>
          <span className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Instant feature activation on your account
          </span>
          <span className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Continuous multi-engine uptime guarantee
          </span>
        </div>
      </div>
    </div>
  );
}
