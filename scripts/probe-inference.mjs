// Asks the app's own inference endpoint for one trivial reply and prints the status plus the
// server's error text. The keys never leave the server, so nothing secret is printed here.
import { _electron as electron } from "playwright";
import path from "node:path";

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const result = await page.evaluate(async () => {
    const call = async (label, body) => {
      const startedAt = Date.now();
      const response = await fetch("/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      // Provider error strings sometimes echo the request URL, which carries the key.
      const redacted = text.replace(/AIza[0-9A-Za-z_\-%]{10,}/g, "AIza[REDACTED]").replace(/(key=|apiKey"?:?\s?")[^"&"]{6,}/gi, "$1[REDACTED]");
      return { label, ms: Date.now() - startedAt, status: response.status, body: redacted.slice(0, 300) };
    };
    const filler = "Workspace listing and prior tool output. ".repeat(600); // ~2.1 MB? no: ~20k chars x600
    const big = filler.slice(0, 40_000);
    return [
      await call("small", { messages: [{ role: "user", content: "Reply with exactly: OK" }], stream: false, profile: "quick", projectPath: "" }),
      await call("agent-shaped-large", {
        stream: false,
        profile: "balanced",
        projectPath: "",
        messages: [
          { role: "system", content: `You are Calvras. Reply as JSON: {"message":string,"actions":array,"status":string}. ${big}` },
          { role: "user", content: "I have imported the CV. Continue the task and tell me the next single action as JSON." },
          { role: "assistant", content: '{"message":"Reading the CV","actions":[{"type":"use_user_file","path":"resume.txt","intent":"Importing the CV"}],"status":"working"}' },
          { role: "user", content: `Tool result: {"ok":true,"path":".calvras/uploads/resume.txt","text":"CURRICULUM VITAE\\nName: Iyana Okonkwo\\n${big.slice(0, 2000)}"}` },
        ],
      }),
    ];
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close().catch(() => {});
}
