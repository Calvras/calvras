import { createFileRoute } from "@tanstack/react-router";
import PricingSection5 from "@/components/ui/pricing";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [{ title: "Pricing & Plans — Calvras" }],
  }),
  component: PricingPage,
});

function PricingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0c] text-foreground antialiased selection:bg-orange-500/30">
      <PricingSection5 />
    </div>
  );
}

export default PricingPage;
