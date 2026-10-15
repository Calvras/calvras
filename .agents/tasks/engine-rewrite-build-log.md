# Engine Rewrite — Build Log

**Command:** `npm run build:electron` from `c:\Users\darka\Desktop\Calvras`

**Result:** ✅ Exit 0 — No TypeScript errors

**Changes implemented:**

1. **src/lib/agent-run.ts** — Added `extractJson` brace-matching helper before `parseAgentReply`; replaced regex strip with `extractJson` call. Added `if (step > 0) options.onFeedback('')` after `throwIfAborted()` in the for loop.

2. **src/lib/gemini.ts** — Added `gemini-2.0-flash` and `gemini-1.5-flash` to `GEMINI_MODELS`. Added `timeoutMs: number = 12_000` parameter to `callDirectGeminiEngine`. Rewrote non-image cascade in `callAI` to: (1) Direct Gemini 8s, (2) Backend /api/v1/chat/completions 20s, (3) Direct OpenRouter 10s, (4) Last-resort Gemini 12s.

3. **src/routes/index.tsx** — Moved `workingPhase` creation + `phases.push` + `publish()` to the top of `execute` callback before `!activePath` guard (immediate spinner). Added `.slice(-8)` to `conversationHistory` before building `historyStr`.

4. **src/components/CalvrasSidebar.tsx** — Removed `Bell` and `Search` from lucide-react import. Replaced header div containing both icon buttons with a minimal self-closing spacer div.

5. **src/lib/system-prompt.ts** — Replaced `# THE WORK LOOP` section (including "Rules of the loop") with `# THINK-ACT LOOP (follow this exactly)` section.

6. **src/components/ui/ai-agent-response.tsx** — No changes needed; dynamic label logic already implemented in `ThinkingState`.

**Build output summary:**
- Client build: 2408 modules, ✓ built in 2.69s
- SSR build: 109 modules, ✓ built in 1.35s
- Nitro build: 2430 modules, ✓ built in 1.63s
- No TypeScript errors in any changed file
