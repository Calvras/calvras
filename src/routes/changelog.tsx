import { createFileRoute } from "@tanstack/react-router";
import { CompanyPage } from "@/components/CompanyPage";
import { marketingHead } from "@/lib/marketing-seo";
export const Route = createFileRoute("/changelog")({
  head: () => marketingHead("/changelog", "Changelog — Calvras", "Follow updates to the Calvras website, desktop download information, and product experience."),
  component: () => <CompanyPage kind="changelog" />,
});