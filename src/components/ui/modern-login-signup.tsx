import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Mail } from "lucide-react";

export default function ModernLoginSignup() {
  const [isSignup, setIsSignup] = useState(true);
  const [notice, setNotice] = useState("");
  return (
    <main className="auth-page">
      <Link to="/" className="absolute left-6 top-6 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft size={16} /> Back to workspace</Link>
      <section className="auth-card">
        <img src="/calvras-logo.png" alt="Calvras" className="mx-auto mb-6 h-12 w-12 object-contain" />
        <h1 className="text-center text-2xl font-semibold tracking-tight">{isSignup ? "Make room for your next idea" : "Welcome back to Calvras"}</h1>
        <p className="mb-7 mt-2 text-center text-sm text-muted-foreground">{isSignup ? "Create your Calvras account to get started." : "Sign in to pick up where you left off."}</p>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); setNotice("Account registration is not available yet. You can continue using the workspace."); }}>
          {isSignup && <label className="text-xs text-muted-foreground">Full name<input className="auth-input" autoComplete="name" name="name" placeholder="Your name" required /></label>}
          <label className="text-xs text-muted-foreground">Email address<input className="auth-input" autoComplete="email" type="email" name="email" placeholder="you@example.com" required /></label>
          <button className="auth-primary" type="submit"><Mail size={16} /> Continue with email</button>
        </form>
        {notice && <p role="status" className="mt-4 text-sm text-muted-foreground">{notice} <Link to="/" className="underline">Open workspace</Link></p>}
        <p className="mt-7 text-center text-sm text-muted-foreground">{isSignup ? "Already have an account?" : "New to Calvras?"} <button className="text-foreground underline underline-offset-4" onClick={() => { setIsSignup(!isSignup); setNotice(""); }}>{isSignup ? "Sign in" : "Sign up"}</button></p>
      </section>
    </main>
  );
}
