import { createFileRoute } from "@tanstack/react-router";
import Feature from "@/components/ui/feature-24";

export const Route = createFileRoute("/capabilities")({
  head: () => ({
    meta: [{ title: "Capabilities — Calvras" }],
  }),
  component: CapabilitiesPage,
});

function CapabilitiesPage() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Feature />
    </div>
  );
}
