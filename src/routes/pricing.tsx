import { marketingHead } from "@/lib/marketing-seo";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Check, Minus } from "lucide-react";
import { MarketingHeader, MarketingFooter, DOWNLOAD_URL } from "@/components/MarketingLayout";
import { checkoutFor } from "@/lib/plans";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export const Route = createFileRoute("/pricing")({ head: () => marketingHead("/pricing", "Pricing & Plans — Calvras", "Start with Calvras desktop tools and upgrade to a paid plan, billed securely through Payments AI."), component: PricingPage });

const openExternally = (url: string) => {
  const bridge = (window as unknown as { __electron?: { openExternal?: (target: string) => Promise<unknown> } }).__electron;
  if (bridge?.openExternal) void bridge.openExternal(url); else window.open(url, "_blank", "noopener,noreferrer");
};

const plans = [
  { name: "Free", price: 0, subtitle: "A place to start.", description: "The full desktop with a daily token allowance.", includes: "200k tokens per day", features: ["200k tokens per day", "Read, write and edit project files", "Run local commands and review changes", "Multi-step agent workflow", "Community support"] },
  { name: "Lite", price: 12, subtitle: "More room to build.", description: "Everything in Free, with two and a half times the daily tokens and the bigger capabilities.", includes: "500k tokens per day — 2.5x Free", features: ["Everything in Free", "500k tokens per day — 2.5x Free", "Stronger, faster model", "Unlimited web search", "Voice input", "Larger file and PDF uploads", "Priority email support"] },
  { name: "Pro", price: 30, subtitle: "For the heaviest weeks.", description: "Everything in Lite, with four times the daily tokens and top reasoning.", includes: "800k tokens per day — 4x Free", features: ["Everything in Lite", "800k tokens per day — 4x Free", "Top reasoning model + high effort", "4 concurrent builds", "Full project memory", "Unlimited chat history", "Priority queue and support"] },
];
const comparison = [
  ["Daily tokens", "200k", "500k (2.5x)", "800k (4x)"],
  ["Read and edit project files", true, true, true],
  ["Local command execution", true, true, true],
  ["Multi-step agent workflow", true, true, true],
  ["Web search", "5/day", "Unlimited", "Unlimited"],
  ["Voice input", false, true, true],
  ["Concurrent builds", "1", "2", "4"],
  ["Project memory", "Short", "Long", "Full"],
  ["Chat history", "7 days", "90 days", "Unlimited"],
  ["Support", "Community", "Priority email", "Priority queue"],
] as const;

function PricingPage() {
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();

  const shown = (plan: (typeof plans)[number]) => ({
    amount: `$${plan.price}`,
    period: "/month",
    detail: checkoutFor(plan.name) ? "Billed securely through Payments AI" : "Free to get started",
  });
  const choose = (name: string) => {
    const checkout = checkoutFor(name);
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
        <p>Start free with 200,000 tokens a day. Lite raises that to 500,000 and Pro to 800,000 — plus the capabilities that make heavy builds feel light.</p>
      </motion.div>
      <section className="pricing-cards" aria-label="Available plans">
        {plans.map((plan, i) => { const live = Boolean(checkoutFor(plan.name)); const offer = shown(plan); return <motion.article key={plan.name} className={`pricing-card ${i === 1 ? "pricing-card-featured" : ""}`} initial={{ opacity: 0, y: reducedMotion ? 0 : 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : .6, delay: reducedMotion ? 0 : .15 + i * .1 }}>
          <div className="pricing-card-heading"><h2>{plan.name}</h2>{i > 0 && <span>{live ? "In the store" : "Not on sale yet"}</span>}</div>
          <p className="pricing-subtitle">{plan.subtitle}</p>
          <div className="pricing-amount" aria-live="polite"><span>{offer.amount}</span><span>{offer.period}</span></div>
          <div className="pricing-billing-detail">{offer.detail}</div>
          <p className="pricing-plan-description">{plan.description}</p>
          {i === 0 ? <a className="pricing-plan-button" href={DOWNLOAD_URL}>Download Free <ArrowUpRight size={16} /></a> : <button className="pricing-plan-button" type="button" onClick={() => choose(plan.name)}>{live ? `Upgrade to ${plan.name}` : `Explore ${plan.name}`} <ArrowUpRight size={16} /></button>}
          <div className="pricing-includes">{plan.includes}</div>
          <ul>{plan.features.map(feature => <li key={feature}>{i === 0 ? <Check size={14} /> : <Minus size={14} />}<span>{feature}</span></li>)}</ul>
        </motion.article>;})}
      </section>
      <p className="pricing-note">Prices in USD, billed monthly. Paid plans are billed securely through Payments AI, so the card is handled by the payment processor and your receipt comes from Payments AI. Tier benefits apply from the release that enables them, and model-provider usage or charges may apply separately.</p>
      <section className="pricing-comparison">
        <div className="pricing-section-heading"><span className="landing-eyebrow">THE DETAILS, SIDE BY SIDE</span><h2>Find your fit.</h2><p>A closer look at what each plan includes.</p></div>
        <div className="pricing-table-scroll"><table><caption className="sr-only">Compare Calvras plan features</caption><thead><tr><th scope="col">Included</th>{plans.map(plan => <th key={plan.name} scope="col">{plan.name}</th>)}</tr></thead><tbody>{comparison.map(([label, ...values]) => <tr key={label}><th scope="row">{label}</th>{values.map((value, i) => <td key={i}>{typeof value === "boolean" ? value ? <><Check size={15} aria-hidden="true" /><span className="sr-only">Included</span></> : <><Minus size={15} aria-hidden="true" /><span className="sr-only">Not included</span></> : value}</td>)}</tr>)}</tbody></table></div>
      </section>
      <section className="pricing-faq"><div className="pricing-section-heading"><span className="landing-eyebrow">GOOD TO KNOW</span><h2>A little clarity.</h2></div><div>
        <details><summary>How does billing work?</summary><p>Plans renew monthly at $12 for Lite and $30 for Pro until cancelled. Payments AI handles the charge and issues the receipt; you can cancel from the link in your receipt, and the plan stays active until the end of the period you already paid for.</p></details>
        <details><summary>Can I use Calvras for free?</summary><p>Yes. The free plan includes 200,000 tokens per day with project file actions, local commands, change review and the multi-step agent workflow. Lite raises that to 500,000 tokens a day and Pro to 800,000, alongside the bigger capabilities.</p></details>
        <details><summary>What happens when I reach my daily token limit?</summary><p>Your usage locks for a random 3 to 10 days, drawn once and shown as a countdown in the app, then opens again automatically with a fresh allowance. Upgrading to Lite or Pro raises the daily allowance so you hit the limit far less often.</p></details>
        <details><summary>Can I upgrade today?</summary><p>Choosing a paid plan opens Payments AI's hosted checkout in your browser, where the card details are entered and never pass through Calvras. The plan is put on the account whose email you enter there, so use the address you sign in to Calvras with.</p></details>
        <details><summary>Does local mean my prompts stay on my computer?</summary><p>Your desktop projects are local, but AI requests may send prompts and selected project context to external model providers. Read the Privacy Policy before sharing sensitive information.</p></details>
      </div></section>
    </main>
    <MarketingFooter />
    <Dialog open={selectedPlan !== null} onOpenChange={open => { if (!open) setSelectedPlan(null); }}><DialogContent className="pricing-dialog"><span className="landing-eyebrow">YOUR NEXT STEP</span><DialogTitle>Build more with {selectedPlan}.</DialogTitle><DialogDescription>Checkout for {selectedPlan} could not be opened just now, so no payment has been taken. Try again from the plan card.</DialogDescription>{selectedPlan && <a className="landing-download" href={`mailto:calvrasnoreply@gmail.com?subject=${encodeURIComponent(`Plan question: ${selectedPlan}`)}`}>Ask about billing <ArrowUpRight size={16} /></a>}</DialogContent></Dialog>
  </div>;
}