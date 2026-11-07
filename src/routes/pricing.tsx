import { marketingHead } from "@/lib/marketing-seo";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Check, Minus } from "lucide-react";
import { MarketingHeader, MarketingFooter, DOWNLOAD_URL } from "@/components/MarketingLayout";
import { checkoutFor } from "@/lib/plans";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export const Route = createFileRoute("/pricing")({ head: () => marketingHead("/pricing", "Pricing & Plans — Calvras", "Start with Calvras desktop tools and upgrade to a paid plan, billed securely through RevenueCat."), component: PricingPage });

const openExternally = (url: string) => {
  const bridge = (window as unknown as { __electron?: { openExternal?: (target: string) => Promise<unknown> } }).__electron;
  if (bridge?.openExternal) void bridge.openExternal(url); else window.open(url, "_blank", "noopener,noreferrer");
};

const plans = [
  { name: "Starter", price: 0, yearlyPrice: 0, subtitle: "A place to start.", description: "Current desktop tools for working with projects and code.", includes: "Current desktop capabilities", features: ["Read and list project files", "Create, write, and edit files", "Run local project commands", "Review file changes and tool output", "Multi-step agent workflow"] },
  { name: "Pro", price: 9, yearlyPrice: 79, subtitle: "Keeps the build going.", description: "Billed securely through RevenueCat. Everything in Starter, plus the Pro benefits as each release ships them.", includes: "Supports Calvras development", features: ["Everything in Starter", "Pro benefits ship in the release that enables them", "Priority reading of the issues you report", "Usage allowance once quotas are enforced", "Receipt and refund handling by RevenueCat"] },
  { name: "Ultra", price: 20, yearlyPrice: 179, subtitle: "For the heaviest weeks.", description: "Billed securely through RevenueCat. The same desktop, with the Ultra benefits as they land.", includes: "Supports Calvras development", features: ["Everything in Pro", "Ultra benefits ship in the release that enables them", "Higher allowance when quotas are enforced", "Priority reading of the issues you report", "Receipt and refund handling by RevenueCat"] },
];
const comparison = [
  ["Availability", "Current desktop", "Billed by RevenueCat", "Billed by RevenueCat"],
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
  const reducedMotion = useReducedMotion();

  const billing = yearly ? "year" as const : "month" as const;
  const checkoutForCycle = (name: string) => checkoutFor(name, billing);
  const shown = (plan: (typeof plans)[number]) => ({
    amount: `$${yearly ? plan.yearlyPrice : plan.price}`,
    period: `/${billing}`,
    detail: checkoutForCycle(plan.name) ? "Billed securely through RevenueCat" : plan.price === 0 ? "Free to get started" : "Not on sale in this billing period yet",
  });
  const choose = (name: string) => {
    const checkout = checkoutForCycle(name);
    if (checkout) { openExternally(checkout); return; }
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
        {plans.map((plan, i) => { const live = Boolean(checkoutForCycle(plan.name)); const offer = shown(plan); return <motion.article key={plan.name} className={`pricing-card ${i === 1 ? "pricing-card-featured" : ""}`} initial={{ opacity: 0, y: reducedMotion ? 0 : 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : .6, delay: reducedMotion ? 0 : .15 + i * .1 }}>
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
      <p className="pricing-note">Prices in USD. Paid plans are billed securely through RevenueCat, so the card is handled by the payment processor and your receipt comes from RevenueCat. Tier benefits apply from the release that enables them, and model-provider usage or charges may apply separately.</p>
      <section className="pricing-comparison">
        <div className="pricing-section-heading"><span className="landing-eyebrow">THE DETAILS, SIDE BY SIDE</span><h2>Find your fit.</h2><p>A closer look at what each plan includes.</p></div>
        <div className="pricing-table-scroll"><table><caption className="sr-only">Compare Calvras plan features</caption><thead><tr><th scope="col">Included</th>{plans.map(plan => <th key={plan.name} scope="col">{plan.name}</th>)}</tr></thead><tbody>{comparison.map(([label, ...values]) => <tr key={label}><th scope="row">{label}</th>{values.map((value, i) => <td key={i}>{typeof value === "boolean" ? value ? <><Check size={15} aria-hidden="true" /><span className="sr-only">Included</span></> : <><Minus size={15} aria-hidden="true" /><span className="sr-only">Not included</span></> : value}</td>)}</tr>)}</tbody></table></div>
      </section>
      <section className="pricing-faq"><div className="pricing-section-heading"><span className="landing-eyebrow">GOOD TO KNOW</span><h2>A little clarity.</h2></div><div>
        <details><summary>How does yearly billing work?</summary><p>Yearly prices cover a full year: $79 for Pro and $179 for Ultra. Switch the toggle above to Yearly and the checkout charges that annual price once; switch back to Monthly and it charges the monthly price. Both periods renew automatically through RevenueCat until cancelled.</p></details>
        <details><summary>Can I use Calvras for free?</summary><p>The desktop app is available at $0 with project file actions, local commands, change review, and a multi-step agent workflow. Model access depends on configured providers, which may have their own charges and limits. No two-workspace quota is currently enforced.</p></details>
        <details><summary>Can I upgrade today?</summary><p>Choosing a paid plan opens the checkout in this page, where the card details are entered and never pass through Calvras. RevenueCat handles the payment and issues the receipt. The plan is put on the account whose email you enter there, so use the address you sign in to Calvras with.</p></details>
        <details><summary>Does local mean my prompts stay on my computer?</summary><p>Your desktop projects are local, but AI requests may send prompts and selected project context to external model providers. Read the Privacy Policy before sharing sensitive information.</p></details>
      </div></section>
    </main>
    <MarketingFooter />
    <Dialog open={selectedPlan !== null} onOpenChange={open => { if (!open) setSelectedPlan(null); }}><DialogContent className="pricing-dialog"><span className="landing-eyebrow">YOUR NEXT STEP</span><DialogTitle>Build more with {selectedPlan}.</DialogTitle><DialogDescription>Checkout for {selectedPlan} could not be opened just now, so no payment has been taken. Try again from the plan card.</DialogDescription>{selectedPlan && <a className="landing-download" href={`mailto:calvrasnoreply@gmail.com?subject=${encodeURIComponent(`Plan question: ${selectedPlan}`)}`}>Ask about billing <ArrowUpRight size={16} /></a>}</DialogContent></Dialog>
  </div>;
}
