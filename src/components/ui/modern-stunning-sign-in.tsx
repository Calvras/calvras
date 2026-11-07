"use client";

import * as React from "react";
import { useState } from "react";
import { Chrome } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Avatar URLs (Unsplash) ───────────────────────────────────────────────────
const AVATARS = [
  "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&crop=face",
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=80&h=80&fit=crop&crop=face",
  "https://images.unsplash.com/photo-1527980965255-d3b416303d12?w=80&h=80&fit=crop&crop=face",
  "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=80&h=80&fit=crop&crop=face",
];

// ─── Logo SVG (Lucide-style, inline) ─────────────────────────────────────────
function CalvrasLogo() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Calvras logo"
    >
      <rect width="32" height="32" rx="8" fill="white" fillOpacity="0.12" />
      <path
        d="M10 16C10 12.686 12.686 10 16 10C18.21 10 20.144 11.196 21.196 13"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M16 10V16L20 20"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="2" fill="white" />
    </svg>
  );
}

const SignIn1 = () => {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");

  const validateEmail = (email: string) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const handleSignIn = () => {
    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }
    if (!validateEmail(email)) {
      setError("Please enter a valid email address.");
      return;
    }
    setError("");
    alert("Sign in successful! (Demo)");
  };

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center bg-[oklch(0.182_0_0)] px-4 py-12">

      {/* ── Centered content (no card) ────────────────────────────────── */}
      <div className="relative z-10 w-full max-w-[360px]">

        {/* Title */}
        <h1 className="mb-7 text-center text-[22px] font-semibold tracking-tight text-white">
          Calvras
        </h1>

        {/* ── Form ────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2.5">
          <input
            type="email"
            value={email}
            placeholder="Email"
            onChange={(e) => setEmail(e.target.value)}
            className={cn(
              "w-full rounded-xl border border-white/[0.1] bg-white/[0.06]",
              "px-4 py-2.5 text-sm text-white placeholder:text-white/30",
              "outline-none ring-0 transition-colors",
              "focus:border-white/20 focus:bg-white/[0.09]"
            )}
          />
          <input
            type="password"
            value={password}
            placeholder="Password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSignIn()}
            className={cn(
              "w-full rounded-xl border border-white/[0.1] bg-white/[0.06]",
              "px-4 py-2.5 text-sm text-white placeholder:text-white/30",
              "outline-none ring-0 transition-colors",
              "focus:border-white/20 focus:bg-white/[0.09]"
            )}
          />

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>

        {/* ── Divider ──────────────────────────────────────────────────── */}
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-white/[0.08]" />
          <span className="text-[11px] text-white/20">or</span>
          <div className="h-px flex-1 bg-white/[0.08]" />
        </div>

        {/* ── Buttons ──────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2.5">
          <button
            onClick={handleSignIn}
            className={cn(
              "w-full rounded-xl bg-white py-2.5",
              "text-sm font-semibold text-[oklch(0.13_0_0)]",
              "transition-opacity hover:opacity-90 active:opacity-75"
            )}
          >
            Sign in
          </button>

          <button
            className={cn(
              "flex w-full items-center justify-center gap-2.5 rounded-xl",
              "border border-white/[0.1] bg-white/[0.04] py-2.5",
              "text-sm font-medium text-white/70",
              "transition-colors hover:bg-white/[0.08] hover:text-white"
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M15.68 8.182c0-.568-.05-1.114-.142-1.637H8v3.098h4.305a3.68 3.68 0 0 1-1.596 2.415v2.007h2.583c1.51-1.391 2.388-3.44 2.388-5.883Z" fill="#4285F4"/>
              <path d="M8 16c2.16 0 3.972-.716 5.295-1.935l-2.583-2.007c-.716.48-1.633.763-2.712.763-2.086 0-3.853-1.41-4.484-3.3H.844v2.073A8 8 0 0 0 8 16Z" fill="#34A853"/>
              <path d="M3.516 9.521A4.807 4.807 0 0 1 3.265 8c0-.528.09-1.04.251-1.521V4.406H.844A8 8 0 0 0 0 8c0 1.29.308 2.512.844 3.594l2.672-2.073Z" fill="#FBBC05"/>
              <path d="M8 3.18c1.175 0 2.23.404 3.059 1.198l2.295-2.295C11.967.792 10.155 0 8 0A8 8 0 0 0 .844 4.406L3.516 6.48C4.147 4.589 5.914 3.18 8 3.18Z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          <p className="mt-1 text-center text-xs text-white/30">
            Don't have an account?{" "}
            <a href="#" className="text-white/60 transition-colors hover:text-white">
              Sign up, it's free!
            </a>
          </p>
        </div>
      </div>

      {/* ── User count and avatars ────────────────────────────────────── */}
      <div className="relative z-10 mt-10 flex flex-col items-center gap-3">
        <p className="max-w-[180px] text-center text-[12px] leading-5 text-white/30">
          Join thousands of developers who are already using Calvras.
        </p>
        <div className="flex items-center">
          {AVATARS.map((src, i) => (
            <img
              key={src}
              src={src}
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 rounded-full border-[2px] border-[oklch(0.182_0_0)] object-cover"
              style={{ marginLeft: i === 0 ? 0 : -8, zIndex: AVATARS.length - i, position: "relative" }}
            />
          ))}
        </div>
      </div>

    </div>
  );
};

export { SignIn1 };
export default SignIn1;
