import { marketingHead } from "@/lib/marketing-seo";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Check, Minus } from "lucide-react";
import { MarketingHeader, MarketingFooter, DOWNLOAD_URL } from "@/components/MarketingLayout";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export const Route = createFileRoute("/pricing")({ head: () => marketingHead("/pricing", "Pricing & Plans — Calvras", "Start with Calvras desktop tools and explore proposed Pro and Ultra plans. Compare current capabilities and planned tier availability."), component: PricingPage });

const plans = [
  { name: "Starter", price: 0, yearlyPrice: 0, subtitle: "A place to start.", description: "Current desktop tools for working with projects and code.", includes: "Current desktop capabilities", features: ["Read and list project files", "Create, write, and edit files", "Run local project commands", "Review file changes and tool output", "Multi-step agent workflow"] },
  { name: "Pro", price: 9, yearlyPrice: 79, subtitle: "A planned next step.", description: "A proposed paid tier. Additional benefits are being defined.", includes: "To be confirmed before launch", features: ["Tier-specific usage allowance", "Additional model access", "Project context benefits", "Support arrangements", "Availability and upgrade terms"] },
  { name: "Ultra", price: 20, yearlyPrice: 179, subtitle: "A planned higher tier.", description: "A proposed paid tier for heavier workflows. Benefits are not yet verified.", includes: "To be confirmed before launch", features: ["Tier-specific usage allowance", "Compute and routing benefits", "Workspace allowances", "Support arrangements", "Availability and upgrade terms"] },
];
const comparison = [
  ["Availability", "Current desktop", "Planned", "Planned"],
  ["Read and edit project files", true, "Not announced", "Not announced"],
  ["Local command execution", true, "Not announced", "Not announced"],
  ["Changes and tool output", true, "Not announced", "Not announced"],
  ["Multi-step agent workflow", true, "Not announced", "Not announced"],
  ["Tier-specific usage quotas", "Not enforced", "Not announced", "Not announced"],
  ["Provider usage limits", "Provider-dependent", "To be confirmed", "To be confirmed"],
] as const;

function PricingPage() {
  const [yearly, setYearly] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
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
        {plans.map((plan, i) => <motion.article key={plan.name} className={`pricing-card ${i === 1 ? "pricing-card-featured" : ""}`} initial={{ opacity: 0, y: reducedMotion ? 0 : 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : .6, delay: reducedMotion ? 0 : .15 + i * .1 }}>
          <div className="pricing-card-heading"><h2>{plan.name}</h2>{i > 0 && <span>Planned</span>}</div>
          <p className="pricing-subtitle">{plan.subtitle}</p>
          <div className="pricing-amount" aria-live="polite"><span>${yearly ? plan.yearlyPrice : plan.price}</span><span>/{yearly ? "year" : "month"}</span></div>
          <div className="pricing-billing-detail">{plan.price === 0 ? "Free to get started" : yearly ? `$${(plan.yearlyPrice / 12).toFixed(2)}/month equivalent · proposed price` : "Proposed monthly price"}</div>
          <p className="pricing-plan-description">{plan.description}</p>
          {i === 0 ? <a className="pricing-plan-button" href={DOWNLOAD_URL}>Download Starter <ArrowUpRight size={16} /></a> : <button className="pricing-plan-button" type="button" onClick={() => setSelectedPlan(plan.name)}>Explore {plan.name} <ArrowUpRight size={16} /></button>}
          <div className="pricing-includes">{plan.includes}</div>
          <ul>{plan.features.map(feature => <li key={feature}>{i === 0 ? <Check size={14} /> : <Minus size={14} />}<span>{feature}</span></li>)}</ul>
        </motion.article>)}
      </section>
      <p className="pricing-note">Prices in USD. Pro and Ultra are proposed tiers; benefits and limits are not yet confirmed. Model-provider usage or charges may apply separately.</p>
      <section className="pricing-comparison">
        <div className="pricing-section-heading"><span className="landing-eyebrow">THE DETAILS, SIDE BY SIDE</span><h2>Find your fit.</h2><p>A closer look at what each plan includes.</p></div>
        <div className="pricing-table-scroll"><table><caption className="sr-only">Compare Calvras plan features</caption><thead><tr><th scope="col">Included</th>{plans.map(plan => <th key={plan.name} scope="col">{plan.name}</th>)}</tr></thead><tbody>{comparison.map(([label, ...values]) => <tr key={label}><th scope="row">{label}</th>{values.map((value, i) => <td key={i}>{typeof value === "boolean" ? value ? <><Check size={15} aria-hidden="true" /><span className="sr-only">Included</span></> : <><Minus size={15} aria-hidden="true" /><span className="sr-only">Not included</span></> : value}</td>)}</tr>)}</tbody></table></div>
      </section>
      <section className="pricing-faq"><div className="pricing-section-heading"><span className="landing-eyebrow">GOOD TO KNOW</span><h2>A little clarity.</h2></div><div>
        <details><summary>How does yearly billing work?</summary><p>Yearly prices cover a full year: $79 for Pro and $179 for Ultra. Monthly equivalents are shown for comparison; the yearly amount is billed together when checkout becomes available.</p></details>
        <details><summary>Can I use Calvras for free?</summary><p>The desktop app is available at $0 with project file actions, local commands, change review, and a multi-step agent workflow. Model access depends on configured providers, which may have their own charges and limits. No two-workspace quota is currently enforced.</p></details>
        <details><summary>Can I upgrade today?</summary><p>Paid checkout is not connected yet. Pro and Ultra are planned tiers whose benefits are still being defined; selecting a plan does not charge you or activate a subscription.</p></details>
        <details><summary>Does local mean my prompts stay on my computer?</summary><p>Your desktop projects are local, but AI requests may send prompts and selected project context to external model providers. Read the Privacy Policy before sharing sensitive information.</p></details>
      </div></section>
    </main>
    <MarketingFooter />
    <Dialog open={selectedPlan !== null} onOpenChange={open => { if (!open) setSelectedPlan(null); }}><DialogContent className="pricing-dialog"><span className="landing-eyebrow">YOUR NEXT STEP</span><DialogTitle>Build more with {selectedPlan}.</DialogTitle><DialogDescription>Paid checkout is not available yet. No payment has been taken and your plan has not changed. You can start building with the Starter desktop app.</DialogDescription><a className="landing-download" href={DOWNLOAD_URL}>Download Starter <ArrowUpRight size={16} /></a></DialogContent></Dialog>
  </div>;
}
