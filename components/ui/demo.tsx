"use client";

import * as React from "react";
import {
  AgentWorkflow,
  type AgentPhase,
  type ToolDefinition,
} from "@/components/ui/ai-agent-response";
import { RotateCcw, Database, ShieldCheck, Cpu } from "lucide-react";

const CUSTOM_TOOLS: Record<string, ToolDefinition> = {
  db_inspect: { name: "db_inspect", label: "Inspect Schema", icon: Database, monoChip: true },
  vuln_scan: { name: "vuln_scan", label: "Security Audit", icon: ShieldCheck },
  cluster_exec: { name: "cluster_exec", label: "Deploy Canary", icon: Cpu, monoChip: true },
};

export const DEMO_PHASES: AgentPhase[] = [
  {
    trace: [
      {
        type: "reasoning",
        sentences: [
          "Auditing the authentication middleware for algorithm injection vulnerabilities.",
          "The `jwt.verify` call accepts undefined algorithms — classic algorithm-confusion vector.",
          "Formulating a strict HS256-only allowlist plus a sliding LRU revocation cache.",
        ],
        durationSeconds: 9.8,
      },
      {
        type: "tool",
        toolName: "read_file",
        args: { path: "src/middleware/auth.ts" },
        lineStart: 36,
        lineEnd: 72,
        code: `export function authMiddleware(req, res, next) {\n  const token = req.headers.authorization;\n  // verify token here\n  return next();\n}`,
      },
      {
        type: "tool",
        toolName: "vuln_scan",
        primary: "Audit",
        secondary: "AST check · 3 files",
        details: [
          { text: "✓ HIGH  jwt.verify at src/middleware/auth.ts:42 — algorithms unpinned" },
          { text: "✓ PASS  JWT_SECRET never crosses a debug/log sink" },
        ],
      },
    ],
    message: "Audit complete — one high-severity finding: **unpinned verify algorithms**. Pinning HS256 and adding revocation next.",
  },
  {
    trace: [
      {
        type: "tool",
        toolName: "edit_file",
        args: { path: "src/auth/verify-options.ts" },
        add: 4,
        del: 1,
        diffFile: "src/auth/verify-options.ts",
        diffRows: [
          { old: 13, cur: null, type: "del", text: "  algorithms: undefined," },
          { old: null, cur: 12, type: "add", text: "  algorithms: ['HS256']," },
          { old: null, cur: 13, type: "add", text: "  issuer: 'api.internal'," },
          { old: null, cur: 14, type: "add", text: "  audience: 'internal-services'," },
        ],
      },
      {
        type: "terminal",
        command: "npm run test:auth -- --coverage",
        exitCode: 0,
        output: "PASS tests/auth/jwt-verifier.test.ts\n  ✓ should pin HS256 algorithm (18 ms)\n  ✓ should reject unsigned tokens (12 ms)\nTests: 14 passed",
      },
    ],
    message: "Patch applied — **14/14 tests passing**, 100% branch coverage.",
  },
];

export default function Demo() {
  const [replayKey, setReplayKey] = React.useState(0);

  return (
    <div className="min-h-screen w-full bg-background px-4 pt-14 pb-28 text-foreground flex flex-col items-center justify-start antialiased sm:px-6">
      <div className="fixed top-6 left-6 z-20">
        <button
          type="button"
          onClick={() => setReplayKey((k) => k + 1)}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 bg-background/80 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:border-border hover:text-foreground"
        >
          <RotateCcw className="size-3" aria-hidden="true" />
          <span>Replay</span>
        </button>
      </div>

      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-[14px] leading-relaxed text-foreground shadow-sm">
            Audit our auth middleware for security vulnerabilities, patch any algorithm bypasses, and add regression tests.
          </div>
        </div>

        <div className="flex flex-col">
          <AgentWorkflow key={replayKey} phases={DEMO_PHASES} tools={CUSTOM_TOOLS} />
        </div>
      </div>
    </div>
  );
}
