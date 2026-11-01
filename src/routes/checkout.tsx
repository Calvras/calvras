import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

/**
 * Where a plan is actually paid for. RevenueCat renders its own checkout inside this page, so the
 * card never touches a Calvras form and the site's bundle holds nothing but the public SDK key and
 * package ids.
 *
 * The page is reached from the pricing page and from the desktop app, both with the person's email
 * attached: it becomes the purchase's app user id, which is how the webhook finds the account to put
 * on the plan afterwards.
 */

type CheckoutSearch = { plan: string; billing: "month" | "year"; email: string };

export const Route = createFileRoute("/checkout")({
  head: () => ({
    meta: [
      { title: "Checkout — Calvras" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): CheckoutSearch => ({
    plan: String(search["plan"] ?? "pro").toLowerCase(),
    billing: search["billing"] === "year" ? "year" : "month",
    email: String(search["email"] ?? "").trim().toLowerCase(),
  }),
  component: CheckoutPage,
});

type PackageRow = { plan: string; label: string; billing: "month" | "year"; packageId: string; productId: string; price: string };
type Config = { ok?: boolean; apiKey?: string; offering?: string; packages?: PackageRow[] };

type Sdk = {
  getOfferings: () => Promise<{
    current?: { packagesById: Record<string, unknown> } | null;
    all: Record<string, { availablePackages: { identifier: string }[] }>;
  }>;
  purchase: (params: { rcPackage: unknown; customerEmail?: string; htmlTarget?: HTMLElement; selectedLocale?: string }) => Promise<{ customerInfo: { managementURL?: string | null } }>;
};

type Phase =
  | { kind: "loading" }
  | { kind: "need-email" }
  | { kind: "unconfigured" }
  | { kind: "no-plan" }
  | { kind: "ready"; label: string; price: string; billing: "month" | "year" }
  | { kind: "paying"; label: string; price: string; billing: "month" | "year" }
  | { kind: "done"; manage?: string }
  | { kind: "closed" }
  | { kind: "error"; message: string };

/** The SDK is a browser module; it is imported only when this page runs in a browser. */
async function loadSdk(apiKey: string, email: string): Promise<{ client: Sdk; cancelled: string }> {
  const module = await import("@revenuecat/purchases-js");
  const { Purchases, ErrorCode } = module;
  const client = Purchases.configure({ apiKey, appUserId: email }) as unknown as Sdk;
  return { client, cancelled: String(ErrorCode.UserCancelledError) };
}

function CheckoutPage() {
  const search = Route.useSearch();
  const { plan, billing } = search;
  const [email, setEmail] = useState(search.email);
  const [typed, setTyped] = useState("");
  const [formError, setFormError] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [ready, setReady] = useState<{ client: Sdk; rcPackage: unknown; row: PackageRow; cancelled: string } | null>(null);
  const target = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setReady(null);
    if (!email) { setPhase({ kind: "need-email" }); return; }
    void (async () => {
      setPhase({ kind: "loading" });
      const config = (await fetch("/api/site/billing/config").then((response) => response.json()).catch(() => null)) as Config | null;
      if (!live) return;
      if (!config?.ok || !config.apiKey) {
        // The desktop build serves this page on loopback with no store key of its own; the hosted page
        // is the one that can take a payment.
        setPhase({ kind: "unconfigured" });
        return;
      }
      const row = (config.packages || []).find((entry) => entry.plan === plan && entry.billing === billing);
      if (!row) { setPhase({ kind: "no-plan" }); return; }
      const { client, cancelled } = await loadSdk(config.apiKey, email);
      const offerings = await client.getOfferings();
      if (!live) return;
      const wanted = String(row.packageId);
      const rcPackage = offerings.current?.packagesById?.[wanted]
        ?? Object.values(offerings.all || {}).flatMap((offering) => offering.availablePackages || []).find((entry) => entry.identifier === wanted);
      if (!rcPackage) { setPhase({ kind: "no-plan" }); return; }
      setReady({ client, rcPackage, row, cancelled });
      setPhase({ kind: "ready", label: row.label, price: row.price, billing: row.billing });
    })().catch((error: unknown) => {
      if (live) setPhase({ kind: "error", message: error instanceof Error ? error.message : "The checkout could not be opened." });
    });
    return () => { live = false; };
  }, [plan, billing, email]);

  // Once the flow ends, the SDK's own markup must not stay under the confirmed or closed message.
  useEffect(() => {
    if (phase.kind === "done" || phase.kind === "closed" || phase.kind === "error") target.current?.replaceChildren();
  }, [phase.kind]);

  async function pay() {
    if (!ready) return;
    setPhase({ kind: "paying", label: ready.row.label, price: ready.row.price, billing: ready.row.billing });
    try {
      const result = await ready.client.purchase({
        rcPackage: ready.rcPackage,
        customerEmail: email,
        ...(target.current ? { htmlTarget: target.current } : {}),
        selectedLocale: "en",
      });
      const manage = result.customerInfo?.managementURL || "";
      setPhase(manage ? { kind: "done", manage } : { kind: "done" });
    } catch (error) {
      const code = (error as { errorCode?: string }).errorCode;
      setPhase(code === ready.cancelled
        ? { kind: "closed" }
        : { kind: "error", message: error instanceof Error ? error.message : "The payment did not go through." });
    }
  }

  const hosted = `https://calvras.com/checkout?plan=${encodeURIComponent(plan)}&billing=${billing}${email ? `&email=${encodeURIComponent(email)}` : ""}`;
  // Already on the site that is supposed to hold the store key: a link to this same page would loop.
  const hostedHere = typeof window !== "undefined" && /(^|\.)calvras\.com$/.test(window.location.hostname);
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  const priceText = (price: string, cycle: "month" | "year") => `$${price} a ${cycle === "year" ? "year" : "month"}`;

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-y-auto px-6 py-10" style={{ background: "var(--background)" }}>
      <div className="w-full max-w-[420px] text-center">
        <img src="/calvras-logo.png" alt="Calvras" className="mx-auto size-12 object-contain" />
        <h1 className="mt-6 text-[24px] font-medium tracking-tight text-white/92">{planName} plan</h1>
        <p className="mt-1 text-[13px] text-white/45">{phase.kind === "ready" || phase.kind === "paying" ? `${priceText(phase.price, phase.billing)} · billed by RevenueCat` : "Secure checkout by RevenueCat"}</p>

        {phase.kind === "loading" && <p className="mt-8 text-[13px] text-white/55">Preparing secure checkout…</p>}

        {phase.kind === "need-email" && (
          <form
            className="mt-8 text-left"
            onSubmit={(event) => {
              event.preventDefault();
              const value = typed.trim().toLowerCase();
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { setFormError("Use the email address you sign in to Calvras with."); return; }
              setFormError("");
              setEmail(value);
            }}
          >
            <p className="text-center text-[13px] leading-6 text-white/55">The plan is put on the account with this email — use the one you sign in to Calvras with.</p>
            <input
              type="email"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              aria-label="Email you sign in with"
              className="mt-4 w-full rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-3 text-[13px] text-white/90 outline-none placeholder:text-white/25 focus:border-white/25"
            />
            {formError && <p role="alert" className="mt-2 text-[11px] text-red-300">{formError}</p>}
            <button type="submit" className="mt-3 w-full rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Continue</button>
          </form>
        )}

        {phase.kind === "ready" && <>
          <p className="mt-8 text-[13px] leading-6 text-white/55">Your card is entered below and charged by RevenueCat. Nothing is charged until you confirm there, and the {planName} plan is put on {email}.</p>
          <button type="button" onClick={() => void pay()} className="mt-6 rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Pay {priceText(phase.price, phase.billing)}</button>
        </>}

        {phase.kind === "paying" && <p className="mt-8 text-[13px] text-white/55">Finish the payment below. Nothing is charged until you confirm there.</p>}

        {phase.kind === "closed" && <>
          <p className="mt-8 text-[13px] text-white/55">Checkout closed before a payment was made. Nothing was charged.</p>
          <button type="button" onClick={() => { setPhase(ready ? { kind: "ready", label: ready.row.label, price: ready.row.price, billing: ready.row.billing } : { kind: "loading" }); }} className="mt-6 rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Try again</button>
        </>}

        {phase.kind === "done" && <>
          <p className="mt-8 text-[13px] text-white/70">Payment confirmed. Open Calvras and sign in again — the {planName} plan arrives with that sign-in.</p>
          {phase.manage
            ? <a href={phase.manage} className="mt-6 inline-block rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Manage subscription</a>
            : <a href="https://calvras.com/download" className="mt-6 inline-block rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Back to Calvras</a>}
        </>}

        {phase.kind === "no-plan" && <>
          <p className="mt-8 text-[13px] text-white/55">That plan is not in the store yet. Nothing was charged.</p>
          <a href="mailto:calvrasnoreply@gmail.com?subject=Plan%20checkout" className="mt-6 inline-block rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Ask about billing</a>
        </>}

        {phase.kind === "unconfigured" && <>
          <p className="mt-8 text-[13px] text-white/55">{hostedHere ? "Checkout is not switched on here yet, so no payment can be taken. Your card is safe." : "Checkout runs on calvras.com, where the store key lives. Open this plan there to pay."}</p>
          {hostedHere
            ? <a href="mailto:calvrasnoreply@gmail.com?subject=Plan%20checkout" className="mt-6 inline-block rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Ask about billing</a>
            : <a href={hosted} className="mt-6 inline-block rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Open checkout on calvras.com</a>}
        </>}

        {phase.kind === "error" && <>
          <p role="alert" className="mt-8 text-[13px] text-red-300">{phase.message}</p>
          <button type="button" onClick={() => { setPhase(ready ? { kind: "ready", label: ready.row.label, price: ready.row.price, billing: ready.row.billing } : { kind: "loading" }); }} className="mt-6 rounded-full bg-white px-5 py-2.5 text-[13px] font-medium text-black">Try again</button>
        </>}

        {/* The SDK renders its checkout in here, so this element must survive every render. */}
        <div ref={target} className="mt-6" />

        <p className="mt-10 text-[10px] leading-5 text-white/25">RevenueCat handles the payment and the receipt. Your card details go to the payment processor, never to Calvras.</p>
      </div>
    </div>
  );
}
