import { createFileRoute } from "@tanstack/react-router";
import { CompanyPage } from "@/components/CompanyPage";
import { marketingHead } from "@/lib/marketing-seo";
export const Route = createFileRoute("/partner")({
  head: () => marketingHead("/partner", "Partner — Calvras", "Explore Calvras partnerships for developer tools, education, and product collaboration."),
  component: () => <CompanyPage kind="partner" />,
});