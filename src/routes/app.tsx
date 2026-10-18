import { createFileRoute } from "@tanstack/react-router";
import { LaunchGate } from "@/components/LaunchScreen";
import { Index } from "./index";
export const Route = createFileRoute("/app")({
  head: () => ({ meta: [{ title: "Calvras Workspace" }, { name: "robots", content: "noindex, nofollow" }] }),
  component: () => <LaunchGate><Index /></LaunchGate>,
});
