// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { CODE_INTELLIGENCE_TOOLS, compilerLibraryRoot, executeCodeIntelligence } from "../lib/runtime/code-intelligence";

let root: string;
const run = (type: string, args: Record<string, any> = {}) => executeCodeIntelligence(type, args, root);
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "calvras-intelligence-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ main: "src/index.ts", dependencies: { react: "^19.0.0" }, scripts: { test: "vitest" } }));
  await fs.writeFile(path.join(root, "src/math.ts"), "export function double(value: number): number { return value * 2; }\n");
  await fs.writeFile(path.join(root, "src/index.ts"), "import { double } from './math';\nexport const answer = double(21);\nconst invalid: number = 'oops';\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=hidden");
});
afterAll(async () => {
  const resolved = path.resolve(root);
  if (resolved.startsWith(path.join(tmpdir(), "calvras-intelligence-"))) await fs.rm(resolved, { recursive: true, force: true });
});

describe("compiler-backed code intelligence", () => {
  it("indexes and ranks actual declarations", async () => {
    const result = await run("search_symbols", { query: "double" });
    expect(result.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "double", file: "src/math.ts", kind: "function" })]));
    expect((await run("list_symbols", { path: "src/math.ts" })).symbols[0].name).toBe("double");
  });
  it("resolves cross-file definitions, references and hover types", async () => {
    const position = { path: "src/index.ts", line: 2, column: 23 };
    expect((await run("go_to_definition", position)).definitions).toEqual(expect.arrayContaining([expect.objectContaining({ file: "src/math.ts", name: "double" })]));
    expect((await run("find_references", { path: "src/math.ts", line: 1, column: 18 })).references.length).toBeGreaterThanOrEqual(3);
    expect((await run("get_hover_info", position)).hover.display).toContain("number");
  });
  it("reports real type diagnostics", async () => {
    expect((await run("read_diagnostics", { path: "src/index.ts" })).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 2322, file: "src/index.ts", line: 3 })]));
  });
  it("maps import targets and function calls", async () => {
    const result = await run("map_dependencies");
    expect(result.imports).toContainEqual(expect.objectContaining({ from: "src/index.ts", import: "./math", to: "src/math.ts" }));
    expect((await run("trace_function_calls", { name: "double" })).calls).toContainEqual(expect.objectContaining({ callee: "double", file: "src/index.ts", definitions: expect.arrayContaining([expect.objectContaining({ file: "src/math.ts" })]) }));
    expect((await run("resolve_imports")).unresolved).toHaveLength(0);
  });
  it("detects frameworks, project entrypoints and dependency declarations", async () => {
    expect((await run("detect_framework")).frameworks).toContain("react");
    expect((await run("find_entry_point")).entries).toContain("src/index.ts");
    expect((await run("read_package_json")).package.main).toBe("src/index.ts");
    expect((await run("inspect_dependencies")).dependencies.react).toBe("^19.0.0");
    for (const type of ["analyze_project", "analyze_codebase"]) expect((await run(type)).sourceFiles).toBe(2);
    expect(CODE_INTELLIGENCE_TOOLS).toHaveLength(17);
  });
  it("blocks traversal, secrets and invalid locations", async () => {
    expect((await run("read_project_structure")).files).not.toContain(".env");
    await expect(run("list_symbols", { path: "../outside.ts" })).rejects.toThrow("outside");
    await expect(run("list_symbols", { path: ".env" })).rejects.toThrow("protected");
    await expect(run("get_hover_info", { path: "src/math.ts", line: 100 })).rejects.toThrow("Invalid line");
  });
  it("does not follow symlinks outside the project", async () => {
    await fs.symlink(tmpdir(), path.join(root, "outside-link"), "junction");
    await expect(run("list_symbols", { path: "outside-link" })).rejects.toThrow("Symlink");
    expect((await run("read_project_structure")).files.some((file: string) => file.startsWith("outside-link"))).toBe(false);
  });
  it("organizes imports using compiler edits", async () => {
    await fs.writeFile(path.join(root, "src/organize.ts"), "import { double } from './math';\nexport const constant = 42;\n");
    const result = await run("organize_imports", { path: "src/organize.ts" });
    expect(result.changed[0].file).toBe("src/organize.ts");
    expect(await fs.readFile(path.join(root, "src/organize.ts"), "utf8")).not.toContain("import");
  });
  it("loads runtime standard libraries for built-in type checking", async () => {
    expect(await fs.readFile(path.join(compilerLibraryRoot(), "lib.d.ts"), "utf8")).toContain("reference lib");
    await fs.writeFile(path.join(root, "src/builtins.ts"), "export const values: Array<string> = ['calvras'];\nexport const upper = values.map(value => value.toUpperCase());\n");
    expect((await run("read_diagnostics", {path:"src/builtins.ts"})).diagnostics).toEqual([]);
  });
  it("blocks hard links that could alias protected files", async () => {
    await fs.link(path.join(root, ".env"), path.join(root, "linked-secret.ts"));
    await expect(run("list_symbols", { path:"linked-secret.ts" })).rejects.toThrow("Hard-linked");
    expect((await run("read_project_structure")).files).not.toContain("linked-secret.ts");
  });
  it("prioritizes sources, skips artifact directories and analyzes requested files past the inventory cap", async () => {
    for (const directory of ["electron-dist", ".agents", ".cache"]) {
      await fs.mkdir(path.join(root, directory));
      await fs.writeFile(path.join(root, directory, "artifact.ts"), "const ignored = true;");
    }
    await fs.mkdir(path.join(root, "aaa-assets"));
    await Promise.all(Array.from({length:1501}, (_, index) => fs.writeFile(path.join(root, "aaa-assets", `${index}.txt`), "asset")));
    await fs.writeFile(path.join(root, "zz-requested.ts"), "export const wrong: number = 'oops';");
    const inventory = await run("read_project_structure");
    expect(inventory.truncated).toBe(true);
    expect(inventory.files).toContain("src/math.ts");
    expect(inventory.files).not.toContain("zz-requested.ts");
    expect(inventory.files.some((file: string) => /artifact/.test(file))).toBe(false);
    expect((await run("read_diagnostics",{path:"zz-requested.ts"})).diagnostics).toContainEqual(expect.objectContaining({code:2322,file:"zz-requested.ts"}));
  });
});
