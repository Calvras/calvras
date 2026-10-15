import { createFileRoute } from "@tanstack/react-router";
import { Index } from "./index";
export const Route = createFileRoute("/app")({ head: () => ({ meta: [{ title: "Calvras Workspace" }, { name: "robots", content: "noindex, nofollow" }] }), component: Index });
