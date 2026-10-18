// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildKnowledge, knowledgeStatus, readModule, searchKnowledge } from "../lib/runtime/knowledge";
import { AgentSession } from "../lib/runtime/agent-runtime";
import { WorkerPool } from "../lib/runtime/worker-pool";
import { TOOL_RISK } from "../lib/tool-catalog";
import { validateToolAction } from "../lib/tool-catalog";
import { CALVRAS_SYSTEM_PROMPT, workerSystemPrompt } from "../lib/system-prompt";

let base = "";
let root = "";
const sessions: AgentSession[] = [];

const write = async (rel: string, content: string) => {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
};

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "calvras-knowledge-")));
  root = path.join(base, "work");
  await write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
  await write("package.json", JSON.stringify({ name: "fixture", scripts: { build: "vite build" } }));
  await write("README.md", "# Fixture\n\nHolds the shape a knowledge scan reads.\n");
  await write("src/util/deep.ts", "export const deep = 1;\nexport function unwrap(value: string) {\n  return value.trim();\n}\n");
  await write("src/lib/store.ts", 'import { deep } from "../util/deep";\nexport function createStore() {\n  return deep;\n}\nexport type Store = { size: number };\n');
  await write("src/lib/report.ts", 'import { createStore } from "./store";\nexport class Report {\n  size = createStore();\n}\n');
  await write("src/components/Header.tsx", 'import { createStore } from "@/lib/store";\nexport function Header() {\n  createStore();\n  return null;\n}\n');
  await write("electron/main.cjs", "const noop = 1;\nmodule.exports = noop;\n");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.stop();
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
});

const stored = async () => JSON.parse(await fs.readFile(path.join(root, ".calvras", "knowledge.json"), "utf8"));

/** readModule answers with an index or one card, so say which one a test expects. */
const ledger = async () => {
  const result = await readModule(root);
  if (!result.ok) throw new Error(result.error);
  if (!("index" in result) || !result.index) throw new Error("The knowledge answer held no module index.");
  return result;
};
const cardOf = async (name: string) => {
  const result = await readModule(root, name);
  if (!result.ok) throw new Error(result.error);
  if (!("module" in result) || !result.module) throw new Error(`The knowledge answer held no card for ${name}.`);
  return result;
};

describe("building a folder's module cards", () => {
  it("groups by path and records only what the files really hold", async () => {
    const built = await buildKnowledge(root);
    expect(built.ok).toBe(true);
    expect(built.depth).toBe(2);
    const names = built.index.map((module: any) => module.name);
    expect(names).toEqual([".", "electron", "src/components", "src/lib", "src/util"]);
    // Calvras' own ledger folder is app state, not the project's source.
    expect(names).not.toContain(".calvras");

    const modules = (await stored()).modules as any[];
    const store = modules.find((module) => module.name === "src/lib")!;
    expect(store.files).toEqual(["src/lib/report.ts", "src/lib/store.ts"]);
    expect(store.codeFiles).toBe(2);
    expect(store.exports.sort()).toEqual(["Report", "Store", "createStore"]);
    expect(store.exportsComplete).toBe(true);
    expect(store.lines).toBeGreaterThan(0);
    expect(store.dependsOn).toEqual(["src/util"]);
    const util = modules.find((module) => module.name === "src/util")!;
    expect(util.dependedBy).toEqual(["src/lib"]);
    // The tsconfig alias resolves to a real file, so the component's import is a project edge.
    expect(modules.find((module) => module.name === "src/components")!.dependsOn).toEqual(["src/lib"]);
    expect(modules.find((module) => module.name === "electron")!.codeFiles).toBe(1);
    expect(modules.find((module) => module.name === ".")!.codeFiles).toBe(0);
  });

  it("re-opens only the modules whose files changed", async () => {
    await buildKnowledge(root);
    const again = await buildKnowledge(root);
    expect(again.changed).toBe(0);
    expect(again.reused).toBe(5);
    expect(again.note).toMatch(/0 files opened; 5 module cards reused/);

    await write("src/lib/store.ts", 'export function createStore() {\n  return { size: 1 };\n}\nexport const fresh = true;\n');
    const after = await buildKnowledge(root);
    expect(after.changed).toBe(1);
    expect(after.reused).toBe(4);
    const store = (await stored()).modules.find((module: any) => module.name === "src/lib");
    expect(store.exports.sort()).toEqual(["Report", "createStore", "fresh"]);
    // A rewritten file drops the export that went away rather than keeping the stale name.
    expect(store.exports).not.toContain("Store");
  });

  it("asks for one purpose line per module and refuses a name it was not given", async () => {
    const asked: string[] = [];
    const built = await buildKnowledge(root, {
      summarize: async (prompt) => {
        asked.push(prompt);
        return JSON.stringify({ purposes: [{ name: "src/lib", purpose: "Holds the store and its report, imported by the header." }, { name: "src/secret", purpose: "Invented module." }] });
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("src/lib");
    const modules = (await stored()).modules as any[];
    expect(modules.find((module) => module.name === "src/lib").purpose).toBe("Holds the store and its report, imported by the header.");
    expect(modules.find((module) => module.name === "src/secret")).toBeUndefined();
    expect(built.summarised).toBe(1);
    expect(built.withoutPurpose).toBe(4);
    // The next pass keeps the line already written and asks only for the cards still without one.
    const next: string[] = [];
    const second = await buildKnowledge(root, { summarize: async (prompt) => { next.push(prompt); return "{}"; } });
    expect(second.changed).toBe(0);
    expect(second.summarised).toBe(0);
    expect((await stored()).modules.find((module: any) => module.name === "src/lib").purpose).toBe("Holds the store and its report, imported by the header.");
    const requested = JSON.parse(next[0]!.slice(next[0]!.indexOf("\n{") + 1)).modules.map((digest: any) => digest.name);
    expect(requested).toHaveLength(4);
    expect(requested).not.toContain("src/lib");
  });

  it("reports an unwritten purpose pass instead of pretending the build failed", async () => {
    const built = await buildKnowledge(root, { summarize: async () => "not json at all" });
    expect(built.ok).toBe(true);
    expect(built.summarised).toBe(0);
    expect(built.withoutPurpose).toBe(5);
    expect(built.note).toMatch(/No purpose lines were written/);
  });

  it("goes a level deeper when one group would hold most of the folder", async () => {
    for (let group = 0; group < 20; group++) for (let index = 0; index < 21; index++) await write(`src/many/part${group}/file${index}.ts`, `export const n = ${index};\n`);
    const built = await buildKnowledge(root);
    expect(built.depth).toBe(3);
    const names = built.index.map((module: any) => module.name);
    expect(names.filter((name: string) => name.startsWith("src/many/part"))).toHaveLength(20);
    expect(built.note).not.toMatch(/cannot split further/);
  });

  it("says so when a flat directory cannot split", async () => {
    for (let index = 0; index < 420; index++) await write(`src/flat/file${index}.ts`, `export const n = ${index};\n`);
    const built = await buildKnowledge(root);
    const flat = built.index.find((module: any) => module.name === "src/flat")!;
    expect(flat.files).toBe(420);
    expect(built.note).toMatch(/largest module holds 420 files/);
    const card = await cardOf("src/flat");
    expect(card.module.files.length).toBeLessThan(card.module.filesTotal);
  });

  it("keeps a hand-edited ledger readable and drops entries it cannot understand", async () => {
    await buildKnowledge(root);
    const file = path.join(root, ".calvras", "knowledge.json");
    const edited = JSON.parse(await fs.readFile(file, "utf8"));
    edited.modules.push({ name: "", files: [] }, { name: "ghost", files: "nope", purpose: 12 });
    edited.depth = 99;
    await fs.writeFile(file, JSON.stringify(edited), "utf8");
    const listed = await ledger();
    expect(listed.index.map((module: any) => module.name)).not.toContain("");
    expect(listed.depth).toBeLessThanOrEqual(6);
  });
});

describe("reading the knowledge back", () => {
  beforeEach(async () => {
    await buildKnowledge(root, { summarize: async () => JSON.stringify({ purposes: [{ name: "src/lib", purpose: "Store and report for the workspace." }] }) });
  });

  it("lists every module with the numbers the scan measured", async () => {
    const index = await ledger();
    expect(index.filesConsidered).toBe(8);
    expect(index.index.find((module: any) => module.name === "src/lib")).toMatchObject({ files: 2, purpose: "Store and report for the workspace." });
    expect(index.index.find((module: any) => module.name === "src/lib")!.lines).toBeGreaterThan(0);
  });

  it("returns one whole card, matched by prefix when the name is close", async () => {
    const exact = await cardOf("src/lib");
    expect(exact.module.dependsOn).toEqual(["src/util"]);
    expect(exact.module.files).toContain("src/lib/report.ts");
    // Leading and trailing slashes are the same module, so the answer needs no caveat.
    const slashed = await cardOf("./src/components/");
    expect(slashed.module.name).toBe("src/components");
    expect("note" in slashed ? slashed.note : "").toBe("");
    const loose = await cardOf("src/compo");
    expect(loose.note).toMatch(/Matched the module "src\/components"\./);
    const missing = await readModule(root, "src/nowhere");
    expect(missing.ok).toBe(false);
    expect(missing.known).toContain("src/util");
  });

  it("scores a query on the fields that actually held the words", async () => {
    const hits = await searchKnowledge(root, "store");
    expect(hits.matches[0]!.name).toBe("src/lib");
    expect(hits.matches[0]!.why.join(" ")).toMatch(/purpose: store/);
    const byFile = await searchKnowledge(root, "header");
    expect(byFile.matches.map((match: any) => match.name)).toContain("src/components");
    const none = await searchKnowledge(root, "kubernetes");
    expect(none.matches).toEqual([]);
    expect(none.note).toMatch(/No module card holds those words/);
    await expect(searchKnowledge(root, "  ")).rejects.toThrow(/looking for/);
  });

  it("reports a folder that has never been scanned as such", async () => {
    const fresh = path.join(base, "empty");
    await fs.mkdir(fresh, { recursive: true });
    expect((await knowledgeStatus(fresh)).modules).toBe(0);
    expect((await knowledgeStatus(fresh)).note).toMatch(/No knowledge has been built/);
    expect((await readModule(fresh)).ok).toBe(false);
    expect((await searchKnowledge(fresh, "anything")).note).toMatch(/Run build_knowledge first/);
    await expect(fs.readFile(path.join(fresh, ".calvras", "knowledge.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the scan inside the folder", async () => {
    const outside = path.join(base, "outside.txt");
    await fs.writeFile(outside, "export const secret = 1;\n", "utf8");
    const built = await buildKnowledge(root);
    expect(built.index.map((module: any) => module.name)).not.toContain("..");
    const names = (await stored()).modules.flatMap((module: any) => module.files);
    expect(names.some((file: string) => file.includes("outside"))).toBe(false);
  });

  it("summarises the ledger in one honest sentence", async () => {
    const empty = path.join(base, "bare");
    await fs.mkdir(empty, { recursive: true });
    expect(knowledgeStatus(empty).line).toMatch(/No module cards for this folder yet/);
    const built = await buildKnowledge(root, { summarize: async () => JSON.stringify({ purposes: [{ name: "src/lib", purpose: "Holds the store." }] }) });
    const status = knowledgeStatus(root);
    expect(status.modules).toBe(built.modules);
    expect(status.withoutPurpose).toBe(built.withoutPurpose);
    expect(status.line).toMatch(/^5 module cards at grouping depth 2, measured from 8 files, built 0 minutes ago; 4 still without a purpose line\./);
    // Nothing was invented about a folder the scan never finished listing.
    expect(knowledgeStatus(root).truncated).toBe(false);
  });
});

describe("the knowledge tools the agent can call", () => {
  it("builds, searches and reads through the session", async () => {
    const session = new AgentSession(root, "full", async (prompt) => prompt.includes("purpose line for each module") ? JSON.stringify({ purposes: [{ name: "src/util", purpose: "Small shared helpers the store imports." }] }) : "{}");
    sessions.push(session);
    const built = await session.execute({ type: "build_knowledge" });
    expect(built.ok).toBe(true);
    expect(built.modules).toBeGreaterThan(0);
    const found = await session.execute({ type: "search_knowledge", query: "helpers" });
    expect(found.matches[0].name).toBe("src/util");
    const module = await session.execute({ type: "read_module", name: "src/util" });
    expect(module.module.purpose).toBe("Small shared helpers the store imports.");
  });

  it("names the ledger in the context block every worker starts from", async () => {
    const session = new AgentSession(root, "full", async () => "{}");
    sessions.push(session);
    expect(session.context()).toMatch(/\[REPO KNOWLEDGE\]\nNo module cards for this folder yet/);
    await session.execute({ type: "build_knowledge" });
    expect(session.context()).toMatch(/\[REPO KNOWLEDGE\]\n5 module cards at grouping depth 2/);
  });

  it("refuses a worker that rebuilds the cards and hands the reason back to it", async () => {
    const askedFor: string[] = [];
    const prompts: string[] = [];
    const pool = new WorkerPool({
      infer: async (prompt: string) => {
        prompts.push(prompt);
        if (prompt.includes("Continuation 1.")) return JSON.stringify({ message: "Mapping the folder.", actions: [{ type: "build_knowledge" }], status: "continue" });
        if (prompt.includes("Continuation 2.")) return JSON.stringify({ message: "Reading instead.", actions: [{ type: "search_knowledge", query: "store" }], status: "continue" });
        return JSON.stringify({ message: "Reported what the cards hold.", actions: [], status: "complete" });
      },
      execute: async (action: any) => { askedFor.push(action.type); return action.type === "search_knowledge" ? { ok: true, matches: [{ name: "src/lib" }] } : { ok: true }; },
    });
    const job = pool.delegate("builder", "Say which module holds the store");
    await pool.wait(job.id, 15_000);
    // The rebuild never reaches the runtime, and the worker is told why in its own next prompt.
    expect(askedFor).not.toContain("build_knowledge");
    expect(askedFor).toContain("search_knowledge");
    expect(prompts.join("\n")).toMatch(/Only the main agent rebuilds the module cards/);
  });

  it("refuses a search with nothing to look for and a depth outside the range", () => {
    expect(() => validateToolAction({ type: "search_knowledge" })).toThrow(/module cards/);
    expect(() => validateToolAction({ type: "build_knowledge", depth: 9 })).toThrow(/1 to 6/);
    expect(validateToolAction({ type: "read_module" })).toMatchObject({ type: "read_module" });
  });

  it("classes building as agent work and reading as read work", () => {
    expect(TOOL_RISK.build_knowledge).toBe("agent");
    expect(TOOL_RISK.search_knowledge).toBe("read");
    expect(TOOL_RISK.read_module).toBe("read");
  });

  it("advertises the three tools to the main agent and only the two readers to a worker", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toContain("build_knowledge {depth?,refresh?}");
    expect(CALVRAS_SYSTEM_PROMPT).toContain("search_knowledge {query,limit?}");
    expect(CALVRAS_SYSTEM_PROMPT).toContain("read_module {name}");
    expect(CALVRAS_SYSTEM_PROMPT).toContain(".calvras/knowledge.json");
    const worker = workerSystemPrompt("builder");
    expect(worker).not.toContain("build_knowledge");
    expect(worker).toContain("search_knowledge {query,limit?}");
    expect(worker).toMatch(/only the main agent rebuilds/);
  });
});
