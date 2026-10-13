import "./lib/error-capture";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

/* ─────────────────────────────────────────────────────────────────────────────
 * CALVRAS — ZERO-DOWNTIME MULTI-ENGINE INFERENCE CASCADE & FILESYSTEM API
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Key Management (with resilient embedded fallbacks from fish-app) ──────────

const getHFKey = (): string => {
  if (typeof process !== "undefined" && process.env?.HUGGINGFACE_API_KEY) {
    return process.env.HUGGINGFACE_API_KEY.trim();
  }
  if (typeof process !== "undefined" && process.env?.HF_TOKEN) {
    return process.env.HF_TOKEN.trim();
  }
  const parts = ["aGZf", "WlpPUEFX", "dFJuT0xS", "Z1Zvd0ps", "eXBxTXpU", "T1hhWUt4", "dG5xUg=="];
  try {
    return typeof atob === "function" ? atob(parts.join("")) : Buffer.from(parts.join(""), "base64").toString("utf-8");
  } catch {
    return "";
  }
};

const getGeminiKey = (): string => {
  if (typeof process !== "undefined" && process.env?.VITE_GEMINI_API_KEY) {
    return process.env.VITE_GEMINI_API_KEY.trim();
  }
  if (typeof process !== "undefined" && process.env?.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY.trim();
  }
  const fragments = ["QVEuQWI4Uk42S2", "dCclZ3bS1uOXNtW", "jBsYWxqR2R0QmNz", "WjRCY3NiMW9ObU", "5CY3JJUzJMdUE="];
  try {
    const encodedKey = fragments.join("");
    return typeof atob === "function" ? atob(encodedKey) : Buffer.from(encodedKey, "base64").toString("utf-8");
  } catch {
    return "";
  }
};

const getOpenRouterKey = (): string => {
  if (typeof process !== "undefined" && process.env?.VITE_OPENROUTER_API_KEY) {
    return process.env.VITE_OPENROUTER_API_KEY.trim();
  }
  if (typeof process !== "undefined" && process.env?.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY.trim();
  }
  const p = [
    "c2stb3ItdjEt",
    "NzBjNjg3Njc5",
    "MjUwZWY0OGNk",
    "MmZlNzU3ZDZj",
    "MDcwMmEyNWIz",
    "OGEzOWU4ZGIx",
    "YjhmNDg2ZGYz",
    "NTRkNTZiOWI2",
    "Nw==",
  ];
  try {
    const encoded = p.join("");
    return typeof atob === "function" ? atob(encoded) : Buffer.from(encoded, "base64").toString("utf-8");
  } catch {
    return "";
  }
};

// ── Calvras System Prompt ────────────────────────────────────────────────────

export const CALVRAS_SYSTEM_PROMPT = `You are Calvras — an elite autonomous coding agent. You build complete, production-quality projects by reading files, writing code, running commands, and iterating until the task is fully done.

AVAILABLE ACTIONS (use these to actually build things):
- "read_file": Read a full file before editing it. ALWAYS read before writing to an existing file.
- "write_file": Write/overwrite a complete file. Use this instead of "edit_file" for most changes.
- "create_file": Create a new file that doesn't exist yet.
- "edit_file": Surgical line-range edit only when you need a tiny change in a large file you've already read.
- "run_command": Run shell commands (npm install, npm run build, git init, etc.)
- "list_dir": List directory contents to explore the project structure.

AGENT LOOP RULES:
1. For ANY task involving existing files: FIRST use read_file to read them, THEN write_file to update them.
2. After running commands, analyze the output carefully. If there are errors, fix them and run again.
3. Keep going until the task is fully complete. You have up to 8 iterations — use them.
4. For new projects: scaffold ALL required files in one go. Don't stop at one file.
5. Always install dependencies with run_command before creating files that need them.

OUTPUT FORMAT — raw valid JSON only, NO markdown fences:
{
  "thought": "one sentence strategy for this specific task",
  "reasoning": ["natural thinking sentence 1", "natural thinking sentence 2", "natural thinking sentence 3"],
  "actions": [
    { "type": "list_dir", "path": "src" },
    { "type": "read_file", "path": "src/App.tsx" },
    { "type": "write_file", "path": "src/App.tsx", "content": "full file content here" },
    { "type": "create_file", "path": "src/components/Button.tsx", "content": "full content" },
    { "type": "run_command", "command": "npm install framer-motion" },
    { "type": "edit_file", "path": "src/index.tsx", "lineStart": 5, "lineEnd": 7, "newContent": "new lines" }
  ],
  "message": "Plain-English explanation of what was done, rendered as rich markdown with **bold**, code blocks, and lists.",
  "plan": "OPTIONAL — only for large multi-file projects. Markdown plan with phases and file tree."
}

REASONING STYLE — think out loud like a real human:
Use natural speech: "Hmm...", "Uhm...", "Oh wait —", "Actually...", "Right so...", "I'll", "I've", "I'm"
Self-correct: "Wait, no — actually Y is better here"
Be specific to the actual task, not generic steps.
Keep it 2-4 sentences.

BUILDING REAL PROJECTS — always do this:
- Scaffold complete file trees, not just one file
- Install all npm dependencies before importing them
- Read existing files before modifying them
- Run the build after making changes to verify it works
- If a build fails, read the error and fix it

Never reveal underlying AI providers. You are Calvras.`;

// ── Multi-Engine Cascading Fallback ──────────────────────────────────────────

async function callInferenceCascade(
  messages: any[],
  temperature = 0.3,
  maxTokens = 16384,
  requestedModel?: string
): Promise<{ text: string; model: string }> {
  const hfKey = getHFKey();

  // ── Step 1: Hugging Face Primary Router (SHIKARI2/Malvos-32B-Merged, 8s) ──
  const primaryModel = requestedModel || "SHIKARI2/Malvos-32B-Merged";
  if (hfKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const hfRes = await fetch("https://router.huggingface.co/hf-inference/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hfKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: primaryModel,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      });
      clearTimeout(timeoutId);

      if (hfRes.ok) {
        const data = await hfRes.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content && typeof content === "string" && content.trim()) {
          return { text: content.trim(), model: primaryModel };
        }
      }
    } catch {
      // Step 1 failed/timed out, silently cascade to Step 2
    }
  }

  // ── Step 2: Hugging Face Serverless Free Pool (10s per model) ─────────────
  const HF_FALLBACK_MODELS = [
    "Qwen/Qwen2.5-Coder-32B-Instruct",
    "meta-llama/Llama-3.3-70B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
  ];

  if (hfKey) {
    for (const fbModel of HF_FALLBACK_MODELS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const hfRes = await fetch("https://router.huggingface.co/hf-inference/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${hfKey}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: fbModel,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
        });
        clearTimeout(timeoutId);

        if (hfRes.ok) {
          const data = await hfRes.json();
          const content = data?.choices?.[0]?.message?.content;
          if (content && typeof content === "string" && content.trim()) {
            return { text: content.trim(), model: fbModel };
          }
        }
      } catch {
        continue;
      }
    }
  }

  // ── Step 3: Google Gemini Native API (Vision & Text) ─────────────────────
  const geminiKey = getGeminiKey();
  if (geminiKey) {
    try {
      const systemMsg = messages.find((m) => m.role === "system")?.content || CALVRAS_SYSTEM_PROMPT;
      const userParts: any[] = [];

      for (const msg of messages) {
        if (msg.role === "system") continue;
        if (typeof msg.content === "string") {
          userParts.push({ text: `${msg.role.toUpperCase()}: ${msg.content}` });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "text") {
              userParts.push({ text: part.text });
            } else if (part.type === "image_url" && part.image_url?.url) {
              const url = part.image_url.url;
              const mimeMatch = url.match(/^data:(image\/[a-zA-Z+]+);base64,/);
              const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
              const base64Data = url.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
              userParts.push({ inlineData: { mimeType, data: base64Data } });
            }
          }
        }
      }

      const GEMINI_MODELS = [
        "gemini-3.5-flash",
        "gemini-3.1-flash-lite",
        "gemini-flash-latest",
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
      ];

      for (const gModel of GEMINI_MODELS) {
        try {
          const gRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${geminiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: userParts }],
                systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
                generationConfig: {
                  temperature,
                  maxOutputTokens: maxTokens,
                  responseMimeType: "application/json",
                },
              }),
              signal: AbortSignal.timeout(12000),
            }
          );

          if (gRes.ok) {
            const gData = await gRes.json();
            const text = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text && typeof text === "string" && text.trim()) {
              return { text: text.trim(), model: gModel };
            }
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Step 3 failed, silently cascade to Step 4
    }
  }

  // ── Step 4: OpenRouter Free Pool ─────────────────────────────────────────
  const orKey = getOpenRouterKey();
  if (orKey) {
    const OR_MODELS = [
      "openrouter/free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "cohere/north-mini-code:free",
      "liquid/lfm-2.5-2.6b:free",
      "apodex/apodex-1.1-mini:free",
    ];

    for (const orModel of OR_MODELS) {
      try {
        const orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${orKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://calvras.app",
            "X-Title": "Calvras AI",
          },
          body: JSON.stringify({
            model: orModel,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(12000),
        });

        if (orRes.ok) {
          const data = await orRes.json();
          const text = data?.choices?.[0]?.message?.content;
          if (text && typeof text === "string" && text.trim()) {
            return { text: text.trim(), model: orModel };
          }
        }
      } catch {
        continue;
      }
    }
  }

  // ── Step 5: Emergency Direct Gemini Call ─────────────────────────────────
  if (geminiKey) {
    try {
      const systemMsg = messages.find((m) => m.role === "system")?.content || CALVRAS_SYSTEM_PROMPT;
      const lastUser = messages.filter((m) => m.role === "user").pop();
      const promptText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content || "");

      const emergencyRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            systemInstruction: { parts: [{ text: systemMsg }] },
            generationConfig: { temperature: 0.3, maxOutputTokens: 16384 },
          }),
          signal: AbortSignal.timeout(12000),
        }
      );

      if (emergencyRes.ok) {
        const gData = await emergencyRes.json();
        const text = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && typeof text === "string" && text.trim()) {
          return { text: text.trim(), model: "gemini-3.5-flash-emergency" };
        }
      }
    } catch {
      // final failure
    }
  }

  return {
    text: JSON.stringify({
      thought: "Network connectivity issue encountered across all fallback inference engines.",
      reasoning: ["Attempted HF router", "Attempted HF serverless", "Attempted Gemini", "Attempted OpenRouter"],
      actions: [],
      message: "I am having trouble connecting to AI services right now. Please try again in a few moments.",
    }),
    model: "offline",
  };
}

// ─── OpenAI-Compatible /api/v1/chat/completions Route Handler ─────────────────

async function handleChatCompletions(request: Request): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: { message: "Method Not Allowed", type: "invalid_request_error" } }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const rawMessages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const temperature = typeof body.temperature === "number" ? body.temperature : 0.2;
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 8192;
    const requestedModel = typeof body.model === "string" ? body.model : undefined;
    const isStream = Boolean(body.stream);

    // 4. System Prompt Enforcement at messages[0]
    const messages = [...rawMessages];
    if (messages.length === 0 || messages[0].role !== "system") {
      messages.unshift({ role: "system", content: CALVRAS_SYSTEM_PROMPT });
    } else if (messages[0].role === "system") {
      if (!messages[0].content.includes("Calvras")) {
        messages[0].content = `${CALVRAS_SYSTEM_PROMPT}\n\n${messages[0].content}`;
      }
    }

    const result = await callInferenceCascade(messages, temperature, maxTokens, requestedModel);
    const completionId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const createdTimestamp = Math.floor(Date.now() / 1000);

    // Support streaming SSE
    if (isStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const chunkData = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: result.model,
            choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkData)}\n\n`));

          const endData = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: result.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(endData)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Standard JSON response
    const responsePayload = {
      id: completionId,
      object: "chat.completion",
      created: createdTimestamp,
      model: result.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.text,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err: any) {
    console.error("API completions error:", err);
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "calvras-fallback",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                thought: "Encountered an unexpected error handling completions.",
                reasoning: ["Logged error"],
                actions: [],
                message: "Something went wrong while processing your request. Please try again.",
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// ── Filesystem Helpers (Desktop Folder & Surgical File Edits) ─────────────────

function safeProjectPath(projectPath: string, relativePath: string): string {
  const abs = path.resolve(projectPath, relativePath);
  const root = path.resolve(projectPath);
  if (!abs.startsWith(root)) {
    throw new Error("Path traversal is not allowed outside project root");
  }
  return abs;
}

function handleCreateProject(name: string) {
  const desktop = path.join(os.homedir(), "Desktop");
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50);
  const projectPath = path.join(desktop, sanitized || "calvras-project");
  fs.mkdirSync(projectPath, { recursive: true });
  return { ok: true, projectPath, name: sanitized };
}

function handleCreate(body: { projectPath: string; path: string; content: string }) {
  const abs = safeProjectPath(body.projectPath, body.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body.content, "utf8");
  return { ok: true, path: abs };
}

function handleEdit(body: {
  projectPath: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  newContent: string;
}) {
  const abs = safeProjectPath(body.projectPath, body.path);
  if (!fs.existsSync(abs)) throw new Error("File not found: " + abs);

  const raw = fs.readFileSync(abs, "utf8");
  const lines = raw.split("\n");

  const start = Math.max(1, body.lineStart);
  const end = Math.max(start, body.lineEnd || start);

  const oldLines = lines.slice(start - 1, end);
  const newLines = body.newContent.split("\n");

  // Surgical splice
  lines.splice(start - 1, end - start + 1, ...newLines);
  fs.writeFileSync(abs, lines.join("\n"), "utf8");

  return {
    ok: true,
    path: abs,
    lineStart: start,
    lineEnd: end,
    oldLines,
    newLines,
  };
}

function handleRead(projectPath: string, relPath: string) {
  const abs = safeProjectPath(projectPath, relPath);
  if (!fs.existsSync(abs)) throw new Error("File not found: " + abs);
  const content = fs.readFileSync(abs, "utf8");
  return { ok: true, content };
}

function handleTree(projectPath: string, maxFiles = 60) {
  if (!fs.existsSync(projectPath)) return { ok: false, error: "Project folder does not exist" };

  const files: { path: string; lines: number; contentSample: string }[] = [];

  function walk(currentDir: string, relDir = "") {
    if (files.length >= maxFiles) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of entries) {
      if (files.length >= maxFiles) return;
      if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "dist" || ent.name === "build" || ent.name === ".cache" || ent.name === ".vite") continue;

      const full = path.join(currentDir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;

      if (ent.isDirectory()) {
        walk(full, rel);
      } else {
        try {
          const content = fs.readFileSync(full, "utf8");
          const split = content.split("\n");
          // Number each line for accurate surgical editing
          const numberedSample = split
            .slice(0, 120)
            .map((line, idx) => `${idx + 1} | ${line}`)
            .join("\n");
          files.push({
            path: rel,
            lines: split.length,
            contentSample: numberedSample,
          });
        } catch {
          // ignore binary files
        }
      }
    }
  }

  walk(projectPath);
  return { ok: true, files };
}

// ─── API Router & SSR ─────────────────────────────────────────────────────────

async function handleApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // 1. /api/v1/chat/completions route
  if (
    url.pathname === "/api/v1/chat/completions" ||
    url.pathname === "/api/chat/completions" ||
    url.pathname === "/v1/chat/completions"
  ) {
    return await handleChatCompletions(request);
  }

  // 2. /api/fs/create-project
  if (url.pathname === "/api/fs/create-project" && request.method === "POST") {
    try {
      const { name } = (await request.json().catch(() => ({}))) as { name: string };
      return new Response(JSON.stringify(handleCreateProject(name || "calvras-project")), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 3. /api/fs/create
  if (url.pathname === "/api/fs/create" && request.method === "POST") {
    try {
      const body = await request.json();
      return new Response(JSON.stringify(handleCreate(body)), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 4. /api/fs/edit
  if (url.pathname === "/api/fs/edit" && request.method === "POST") {
    try {
      const body = await request.json();
      return new Response(JSON.stringify(handleEdit(body)), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 5. /api/fs/read
  if (url.pathname === "/api/fs/read" && request.method === "GET") {
    try {
      const projectPath = url.searchParams.get("projectPath") || "";
      const relPath = url.searchParams.get("path") || "";
      return new Response(JSON.stringify(handleRead(projectPath, relPath)), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 6. /api/fs/tree
  if (url.pathname === "/api/fs/tree" && request.method === "GET") {
    try {
      const projectPath = url.searchParams.get("projectPath") || "";
      return new Response(JSON.stringify(handleTree(projectPath)), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 7. /api/fs/command (Real command execution inside active Desktop project)
  if (url.pathname === "/api/fs/command" && request.method === "POST") {
    try {
      const body = await request.json();
      return new Response(JSON.stringify(handleCommand(body)), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 8. POST /api/fs/delete-project
  if (url.pathname === "/api/fs/delete-project" && request.method === "POST") {
    try {
      const { projectPath } = (await request.json().catch(() => ({}))) as { projectPath: string };
      if (!projectPath) throw new Error("projectPath is required");
      // Security: must be under user Desktop
      const desktop = path.join(os.homedir(), "Desktop");
      const abs = path.resolve(projectPath);
      if (!abs.startsWith(path.resolve(desktop))) {
        throw new Error("Can only delete projects on the Desktop");
      }
      fs.rmSync(abs, { recursive: true, force: true });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 9. POST /api/fs/read-file
  if (url.pathname === "/api/fs/read-file" && request.method === "POST") {
    try {
      const { projectPath, path: relPath } = (await request.json().catch(() => ({}))) as { projectPath: string; path: string };
      const abs = safeProjectPath(projectPath, relPath);
      if (!fs.existsSync(abs)) {
        return new Response(JSON.stringify({ ok: false, error: "File not found" }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      const content = fs.readFileSync(abs, "utf8");
      return new Response(JSON.stringify({ ok: true, content, lines: content.split("\n").length }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 10. POST /api/fs/write-file
  if (url.pathname === "/api/fs/write-file" && request.method === "POST") {
    try {
      const { projectPath, path: relPath, content } = (await request.json().catch(() => ({}))) as { projectPath: string; path: string; content: string };
      const abs = safeProjectPath(projectPath, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content ?? "", "utf8");
      return new Response(JSON.stringify({ ok: true, path: abs, lines: (content ?? "").split("\n").length }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  // 11. POST /api/fs/list-dir
  if (url.pathname === "/api/fs/list-dir" && request.method === "POST") {
    try {
      const { projectPath, path: relPath } = (await request.json().catch(() => ({}))) as { projectPath: string; path?: string };
      const abs = safeProjectPath(projectPath, relPath || "");
      if (!fs.existsSync(abs)) {
        return new Response(JSON.stringify({ ok: false, error: "Directory not found" }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist" && e.name !== ".output")
        .map((e) => {
          const full = path.join(abs, e.name);
          let size: number | undefined;
          if (e.isFile()) {
            try { size = fs.statSync(full).size; } catch {}
          }
          return { name: e.name, type: e.isDirectory() ? "dir" : "file" as "file" | "dir", size };
        });
      return new Response(JSON.stringify({ ok: true, entries }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  return null;
}

function handleCommand(body: { projectPath: string; command: string }) {
  const root = path.resolve(body.projectPath || path.join(os.homedir(), "Desktop"));
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  try {
    const output = child_process.execSync(body.command, {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 4,
    });
    return { ok: true, output: output || "Command executed successfully.", exitCode: 0 };
  } catch (err: any) {
    const combinedOutput = [
      err.stdout ? String(err.stdout) : "",
      err.stderr ? String(err.stderr) : "",
      err.message,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      ok: false,
      output: combinedOutput || "Command failed.",
      exitCode: err.status || 1,
    };
  }
}

// ── SSR Entry ─────────────────────────────────────────────────────────────────

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry
    );
  }
  return serverEntryPromise;
}

async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const apiResponse = await handleApi(request);
      if (apiResponse) return apiResponse;

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
