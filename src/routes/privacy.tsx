import { createFileRoute } from "@tanstack/react-router";
import { CompanyPage } from "@/components/CompanyPage";
import { marketingHead } from "@/lib/marketing-seo";
export const Route = createFileRoute("/privacy")({
  head: () => marketingHead("/privacy", "Privacy Policy — Calvras", "Understand Calvras local storage, AI-provider requests, project context, and privacy choices."),
  component: () => <CompanyPage kind="privacy" />,
});