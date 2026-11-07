import { createFileRoute } from "@tanstack/react-router";
import SignIn1 from "@/components/ui/modern-login-signup";

export const Route = createFileRoute("/signin")({
  head: () => ({
    meta: [{ title: "Sign in — Calvras" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: SignIn1,
});

