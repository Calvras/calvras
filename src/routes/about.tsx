import { createFileRoute } from "@tanstack/react-router";
import { CompanyPage } from "@/components/CompanyPage";
import { marketingHead } from "@/lib/marketing-seo";
export const Route = createFileRoute("/about")({
  head: () => marketingHead("/about", "About Calvras — Calvras", "Meet Calvras, the desktop AI coding agent for project files, local commands, and visible change review."),
  component: () => <CompanyPage kind="about" />,
});