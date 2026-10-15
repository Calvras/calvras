import { createFileRoute } from "@tanstack/react-router";
import { CompanyPage } from "@/components/CompanyPage";
import { marketingHead } from "@/lib/marketing-seo";
export const Route = createFileRoute("/terms")({
  head: () => marketingHead("/terms", "Terms and Services — Calvras", "Read the Calvras terms covering authorized use, local commands, AI output, external services, and plans."),
  component: () => <CompanyPage kind="terms" />,
});