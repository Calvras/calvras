import { marketingHead } from "@/lib/marketing-seo";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Check, Minus } from "lucide-react";
import { MarketingHeader, MarketingFooter, DOWNLOAD_URL } from "@/components/MarketingLayout";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export const Route = createFileRoute("/pricing")({ head: () => marketingHead("/pricing", "Pricing & Plans — Calvras", "Start with Calvras desktop tools and upgrade to a paid plan, sold by Payments AI as merchant of record."), component: PricingPage });

/** The same shape the local server answers with after reading the merchant's live catalogue. */
type StorePlan = { planId: string; planName: string; productName: string; amount: number; currency: string; interval: string; checkoutUrl: string };
type Catalog = { ok: boolean; plans: StorePlan[]; error: string };

const openExternally = (url: string) => {
  const bridge = (window as unknown as { __electron?: { openExternal?: (target: string) => Promise<unknown> } }).__electron;
  if (bridge?.openExternal) void bridge.openExternal(url); else window.open(url, "_blank", "noopener,noreferrer");
};

const plans = [
  { name: "Starter", price: 0, yearlyPrice: 0, subtitle: "A place to start.", description: "Current desktop tools for working with projects and code.", includes: "Current desktop capabilities", features: ["Read and list project files", "Create, write, and edit files", "Run local project commands", "Review file changes and tool output", "Multi-step agent workflow"] },
  { name: "Pro", price: 9, yearlyPrice: 79, subtitle: "Keeps the build going.", description: "Sold through Payments AI as merchant of record. Everything in Starter, plus the Pro benefits as each release ships them.", includes: "Supports Calvras development", features: ["Everything in Starter", "Pro benefits ship in the release that enables them", "Priority reading of the issues you report", "Usage allowance once quotas are enforced", "Receipt and refund handling by Payments AI"] },
  { name: "Ultra", price: 20, yearlyPrice: 179, subtitle: "For the heaviest weeks.", description: "Sold through Payments AI as merchant of record. The same desktop, with the Ultra benefits as they land.", includes: "Supports Calvras development", features: ["Everything in Pro", "Ultra benefits ship in the release that enables them", "Higher allowance when quotas are enforced", "Priority reading of the issues you report", "Receipt and refund handling by Payments AI"] },
];
const comparison = [
  ["Availability", "Current desktop", "Sold by Payments AI", "Sold by Payments AI"],
  ["Read and edit project files", true, true, true],
  ["Local command execution", true, true, true],
  ["Changes and tool output", true, true, true],
  ["Multi-step agent workflow", true, true, true],
  ["Tier-specific usage quotas", "Not enforced", "Not enforced yet", "Not enforced yet"],
  ["Provider usage limits", "Provider-dependent", "Provider-dependent", "Provider-dependent"],
] as const;

function PricingPage() {
  const [yearly, setYearly] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const reducedMotion = useReducedMotion();

  // The offer comes from the payment store, not from this file: whatever the merchant has
  // published is what the page sells, and nothing is shown as buyable until the store says so.
  useEffect(() => {
    let alive = true;
    void fetch("/api/agent/payments/catalog")
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (alive && body && Array.isArray(body.plans)) setCatalog({ ok: Boolean(body.ok), plans: body.plans as StorePlan[], error: String(body.error || "") }); })
      .catch(() => { /* a page without the local server simply has no catalogue to read */ });
    return () => { alive = false; };
  }, []);

  const liveFor = (name: string) => catalog?.plans.find((plan) => `${plan.productName} ${plan.planName}`.toLowerCase().includes(name.toLowerCase())) || null;
  const shown = (plan: (typeof plans)[number]) => {
    const live = liveFor(plan.name);
    if (live) return { amount: `$${live.amount.toFixed(2)}`, period: live.interval === "one-time" ? "one-time" : `per ${live.interval}`, detail: "Sold by Payments AI, the merchant of record" };
    return { amount: `$${yearly ? plan.yearlyPrice : plan.price}`, period: `/${yearly ? "year" : "month"}`, detail: plan.price === 0 ? "Free to get started" : yearly ? `$${(plan.yearlyPrice / 12).toFixed(2)}/month equivalent` : "Monthly price" };
  };
  const choose = (name: string) => {
    const live = liveFor(name);
    if (live) { openExternally(live.checkoutUrl); return; }
    setSelectedPlan(name);
  };
  return <div className="calvras-landing pricing-page">
    <div className="pricing-backdrop" aria-hidden="true"><div className="landing-grain" /><img src="/calvras-logo.png" alt="" /></div>
    <MarketingHeader />
    <main className="pricing-main">
      <motion.div className="pricing-intro" initial={{ opacity: 0, y: reducedMotion ? 0 : 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : .7 }}>
        <span className="landing-eyebrow">A PLAN FOR YOUR NEXT IDEA</span>
        <h1>Start small.<br /><span>Build with clarity.</span></h1>
        <p>Start with the current desktop tools. Explore the proposed paid tiers as their benefits take shape.</p>
        <div className="pricing-billing" role="group" aria-label="Billing period">
          <button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button>
          <button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly <span>Save up to 27%</span></button>
        </div>
      </motion.div>
      <section className="pricing-cards" aria-label="Available plans">
        {plans.map((plan, i) => { const live = liveFor(plan.name); const offer = shown(plan); return <motion.article key={plan.name} className={`pricing-card ${i === 1 ? "pricing-card-featured" : ""}`} initial={{ opacity: 0, y: reducedMotion ? 0 : 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : .6, delay: reducedMotion ? 0 : .15 + i * .1 }}>
          <div className="pricing-card-heading"><h2>{plan.name}</h2>{i > 0 && <span>{live ? "In the store" : "Not on sale yet"}</span>}</div>
          <p className="pricing-subtitle">{plan.subtitle}</p>
          <div className="pricing-amount" aria-live="polite"><span>{offer.amount}</span><span>{offer.period}</span></div>
          <div className="pricing-billing-detail">{offer.detail}</div>
          <p className="pricing-plan-description">{plan.description}</p>
          {i === 0 ? <a className="pricing-plan-button" href={DOWNLOAD_URL}>Download Starter <ArrowUpRight size={16} /></a> : <button className="pricing-plan-button" type="button" onClick={() => choose(plan.name)}>{live ? `Upgrade to ${plan.name}` : `Explore ${plan.name}`} <ArrowUpRight size={16} /></button>}
          <div className="pricing-includes">{plan.includes}</div>
          <ul>{plan.features.map(feature => <li key={feature}>{i === 0 ? <Check size={14} /> : <Minus size={14} />}<span>{feature}</span></li>)}</ul>
        </motion.article>;})}
      </section>
      <p className="pricing-note">Prices in USD. Paid plans are sold by Payments AI as merchant of record, so the card is handled by them and your receipt comes from them. Tier benefits apply from the release that enables them, and model-provider usage or charges may apply separately.</p>
      <section className="pricing-comparison">
        <div className="pricing-section-heading"><span className="landing-eyebrow">THE DETAILS, SIDE BY SIDE</span><h2>Find your fit.</h2><p>A closer look at what each plan includes.</p></div>
        <div className="pricing-table-scroll"><table><caption className="sr-only">Compare Calvras plan features</caption><thead><tr><th scope="col">Included</th>{plans.map(plan => <th key={plan.name} scope="col">{plan.name}</th>)}</tr></thead><tbody>{comparison.map(([label, ...values]) => <tr key={label}><th scope="row">{label}</th>{values.map((value, i) => <td key={i}>{typeof value === "boolean" ? value ? <><Check size={15} aria-hidden="true" /><span className="sr-only">Included</span></> : <><Minus size={15} aria-hidden="true" /><span className="sr-only">Not included</span></> : value}</td>)}</tr>)}</tbody></table></div>
      </section>
      <section className="pricing-faq"><div className="pricing-section-heading"><span className="landing-eyebrow">GOOD TO KNOW</span><h2>A little clarity.</h2></div><div>
        <details><summary>How does yearly billing work?</summary><p>Yearly prices cover a full year: $79 for Pro and $179 for Ultra. Monthly equivalents are shown for comparison. Which interval a plan is sold on is set in the Payments AI catalogue, and that is the interval this page displays once it can read the store.</p></details>
        <details><summary>Can I use Calvras for free?</summary><p>The desktop app is available at $0 with project file actions, local commands, change review, and a multi-step agent workflow. Model access depends on configured providers, which may have their own charges and limits. No two-workspace quota is currently enforced.</p></details>
        <details><summary>Can I upgrade today?</summary><p>Yes, when this build can read the store. The desktop app keeps the Payments AI credential in its own folder on your computer and asks that service for the live catalogue; choosing a plan that is on sale opens the Payments AI checkout in a separate window, where the card details are entered and never pass through Calvras. If the plan shows as not on sale, no payment can be taken from this page.</p></details>
        <details><summary>Does local mean my prompts stay on my computer?</summary><p>Your desktop projects are local, but AI requests may send prompts and selected project context to external model providers. Read the Privacy Policy before sharing sensitive information.</p></details>
      </div></section>
    </main>
    <MarketingFooter />
    <Dialog open={selectedPlan !== null} onOpenChange={open => { if (!open) setSelectedPlan(null); }}><DialogContent className="pricing-dialog"><span className="landing-eyebrow">YOUR NEXT STEP</span><DialogTitle>Build more with {selectedPlan}.</DialogTitle><DialogDescription>{catalog?.error ? `Calvras asked the Payments AI store for this plan and the store answered: ${catalog.error}. No payment has been taken.` : catalog ? `The Payments AI catalogue this build can read has no ${selectedPlan} plan on sale yet, so there is nothing to check out. No payment has been taken.` : "Checkout runs through Payments AI, and this page could not reach a Calvras server that holds the store credential, so no plan is on offer here. No payment has been taken."} Upgrade below, and nothing is charged inside this page either way.</DialogDescription>{selectedPlan && (() => { const live = liveFor(selectedPlan); return <a className="landing-download" href={live ? live.checkoutUrl : `mailto:calvrasnoreply@gmail.com?subject=${encodeURIComponent(`Upgrade to ${selectedPlan}`)}`}>Upgrade <ArrowUpRight size={16} /></a>; })()}</DialogContent></Dialog>
  </div>;
}
