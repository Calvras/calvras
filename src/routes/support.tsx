import { createFileRoute } from "@tanstack/react-router";
import { CompanyPage } from "@/components/CompanyPage";
import { marketingHead } from "@/lib/marketing-seo";
export const Route = createFileRoute("/support")({
  head: () => marketingHead("/support", "Support — Calvras", "Get help with Calvras installation, project workflows, privacy questions, and reproducible issues."),
  component: () => <CompanyPage kind="support" />,
});