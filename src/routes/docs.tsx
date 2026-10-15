import { createFileRoute } from "@tanstack/react-router";
import { CompanyPage } from "@/components/CompanyPage";
import { marketingHead } from "@/lib/marketing-seo";
export const Route = createFileRoute("/docs")({
  head: () => marketingHead("/docs", "Documentation — Calvras", "Get started with Calvras: download the Windows app, choose a project, describe a task, and verify changes."),
  component: () => <CompanyPage kind="docs" />,
});