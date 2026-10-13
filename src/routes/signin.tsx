import { createFileRoute } from "@tanstack/react-router";
import SignIn1 from "@/components/ui/modern-stunning-sign-in";

export const Route = createFileRoute("/signin")({
  head: () => ({
    meta: [{ title: "Sign in — Calvras" }],
  }),
  component: SignIn1,
});
