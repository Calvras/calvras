import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { guardedRoot } from "./permissions";
import { projectFileInventory } from "./code-intelligence";

/**
 * Module-level knowledge of the folder, alongside the file-level tools.
 *
 * Every field on a card is read out of the workspace itself: which files sit in the module, how
 * many lines they hold, what they declare, which other modules they import. A fingerprint made
 * from each file's size and clock stamp is what lets a rebuild skip modules nobody touched
 * instead of re-reading the folder. Only `purpose` comes from a model, and only from the facts
 * already on that card.
 */

export type KnowledgeModule = {
  /** Project-relative group path, eg "src/lib/runtime". "." holds the loose files at the top. */
  name: string;
  files: string[];
  /** The group's real file count. `files` is capped so one card stays readable. */
  filesTotal: number;
  codeFiles: number;
  languages: string[];
  lines: number;
  /** Files in the group the scan did not open (binary, or over the 1 MB limit). */
  unreadFiles: number;
  /** Exported identifiers found by a declaration scan. */
  exports: string[];
  /** False once the cap was hit, so a missing name is never read as an absent one. */
  exportsComplete: boolean;
  dependsOn: string[];
  dependedBy: string[];
  /** Model-written from the card's own facts; empty until that has happened. */
  purpose: string;
  fingerprint: string;
};

export type KnowledgeBase = {
  builtAt: number;
  /** The grouping depth the scan settled on. */
  depth: number;
  filesConsidered: number;
  /** The inventory stopped early, so a module may be missing files. */
  truncated: boolean;
  note: string;
  modules: KnowledgeModule[];
};

const codeExtension = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const textish = /\.(?:[cm]?[jt]sx?|css|scss|html|md|json|ya?ml|toml|sql|txt)$/i;
/** Calvras' own ledgers are app state, not the project's source. */
const appState = /^\.calvras(?:\/|$)/i;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_GROUP_FILES = 400;
const MAX_CARD_FILES = 120;
const MAX_EXPORTS = 30;
const MAX_PURPOSE = 700;
const MAX_PURPOSE_CALL = 40;

const knowledgePath = (root: string) => path.join(root, ".calvras", "knowledge.json");
const chains = new Map<string, Promise<any>>();
function serialize<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(root) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(root, next.catch(() => {}));
  return next;
}

const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
/** Which group a project-relative path belongs to at the depth the scan settled on. */
const groupOf = (rel: string, depth: number) => {
  const parts = rel.split("/");
  return parts.length === 1 ? "." : parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
};

function sanitizeModule(raw: any): KnowledgeModule | null {
  if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name.trim()) return null;
  const list = (field: string, cap: number) => (Array.isArray(raw[field]) ? raw[field].filter((item: any) => typeof item === "string" && item.trim()).slice(0, cap).map((item: string) => item.slice(0, 400)) : []);
  const files = list("files", MAX_CARD_FILES);
  const number = (field: string, fallback: number) => (Number.isFinite(Number(raw[field]) ? Number(raw[field]) : NaN) ? Math.max(0, Math.round(Number(raw[field]))) : fallback);
  return {
    name: raw.name.trim().slice(0, 200),
    files,
    filesTotal: number("filesTotal", files.length),
    codeFiles: number("codeFiles", files.length),
    languages: list("languages", 20),
    lines: number("lines", 0),
    unreadFiles: number("unreadFiles", 0),
    exports: list("exports", MAX_EXPORTS),
    exportsComplete: raw.exportsComplete !== false,
    dependsOn: list("dependsOn", MAX_CARD_FILES),
    dependedBy: list("dependedBy", MAX_CARD_FILES),
    purpose: typeof raw.purpose === "string" ? raw.purpose.trim().slice(0, MAX_PURPOSE) : "",
    fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint.slice(0, 64) : "",
  };
}

function sanitizeBase(raw: any): KnowledgeBase {
  const depth = Math.min(6, Math.max(1, Math.round(Number(raw?.depth)) || 2));
  const modules = (Array.isArray(raw?.modules) ? raw.modules : []).map(sanitizeModule).filter(Boolean) as KnowledgeModule[];
  const builtAt = Number.isFinite(Number(raw?.builtAt)) ? Number(raw.builtAt) : 0;
  return {
    builtAt,
    depth,
    filesConsidered: Number.isFinite(Number(raw?.filesConsidered)) ? Number(raw.filesConsidered) : modules.reduce((total, module) => total + module.filesTotal, 0),
    truncated: raw?.truncated === true,
    note: typeof raw?.note === "string" ? raw.note.slice(0, 500) : builtAt ? "" : "No knowledge has been built for this folder yet.",
    modules,
  };
}

async function readBase(root: string): Promise<KnowledgeBase> {
  try { return sanitizeBase(JSON.parse(await fs.readFile(knowledgePath(root), "utf8"))); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; return sanitizeBase(null); }
}

/** The same ledger, for a caller that cannot await it, such as a context block built between turns. */
function readBaseSync(root: string): KnowledgeBase {
  try { return sanitizeBase(JSON.parse(sync.readFileSync(knowledgePath(root), "utf8"))); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; return sanitizeBase(null); }
}

async function writeBase(root: string, base: KnowledgeBase) {
  const file = knowledgePath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(base, null, 2), "utf8");
  await fs.rename(`${file}.tmp`, file);
}

type Alias = { from: string; to: string };

/** tsconfig `paths` prefixes, read without loading the compiler. A comment or a trailing comma is
 * all that can upset this, and then the scan simply keeps to relative imports. */
async function aliasPrefixes(root: string): Promise<Alias[]> {
  let raw = "";
  try { raw = await fs.readFile(path.join(root, "tsconfig.json"), "utf8"); } catch { return []; }
  let parsed: any;
  try { parsed = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1").replace(/,(\s*[}\]])/g, "$1")); }
  catch { return []; }
  const entries = (parsed as any)?.compilerOptions?.paths;
  if (!entries || typeof entries !== "object") return [];
  return Object.entries(entries).flatMap(([from, targets]) => (Array.isArray(targets) ? targets : []).filter((to: any) => typeof to === "string" && to.trim()).map((to: string) => ({ from, to })));
}

/** Resolves one import specifier to a file inside the folder, or "" when it names a package. */
function resolveSpecifier(root: string, fromFile: string, specifier: string, aliases: Alias[]) {
  if (!specifier) return "";
  let target = "";
  if (specifier[0] === "." || specifier[0] === "/") target = path.resolve(path.dirname(fromFile), specifier);
  else {
    const alias = aliases.find((entry) => (entry.from.endsWith("*") ? specifier.startsWith(entry.from.slice(0, -1)) : specifier === entry.from));
    if (!alias) return "";
    const rest = alias.from.endsWith("*") ? specifier.slice(alias.from.length - 1) : "";
    target = path.resolve(root, alias.to.replace(/\*$/, "") + rest);
  }
  const tries = [target, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"].map((extension) => `${target}${extension}`), ...["/index.ts", "/index.tsx", "/index.js", "/index.jsx"].map((index) => `${target}${index}`)];
  for (const candidate of tries) {
    const within = relative(root, candidate);
    if (!within || within.startsWith("..") || path.isAbsolute(within) || appState.test(within)) continue;
    try { if (sync.statSync(candidate).isFile()) return candidate; } catch { /* that spelling is not there. */ }
  }
  return "";
}

const declaration = /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const reExport = /export\s*\{([^}]*)\}/g;
const importSource = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function declarations(text: string) {
  const names = new Set<string>();
  for (const match of text.matchAll(declaration)) if (match[1] && match[1] !== "default") names.add(match[1]);
  for (const match of text.matchAll(reExport)) {
    for (const entry of String(match[1]).split(",")) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

const fingerprintOf = (entries: { file: string; size: number; mtimeMs: number }[]) => createHash("sha1").update(entries.map((entry) => `${entry.file}:${entry.size}:${Math.round(entry.mtimeMs)}`).sort().join("|")).digest("hex");

export type KnowledgeBuildOptions = {
  /** Asked to write each new module's purpose line. Without it the facts still build, unsummarised. */
  summarize?: (prompt: string) => Promise<string>;
  /** Re-read every module even where the fingerprint still matches. */
  refresh?: boolean;
  /** Grouping depth. 0 keeps whatever the stored base used. */
  depth?: number;
  inventory?: { files: string[]; truncated: boolean };
};

/**
 * Reads the folder into `.calvras/knowledge.json`.
 *
 * Two passes: every file is stat-ed to group them and compare fingerprints, then only the groups
 * that changed are opened. A module nobody touched keeps its stored card, so re-building a big
 * folder costs one `stat` per file and nothing else.
 */
export async function buildKnowledge(projectPath: string, options: KnowledgeBuildOptions = {}) {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => {
    const stored = await readBase(root);
    const inventory = options.inventory ?? projectFileInventory(root);
    const wanted = inventory.files.map((file) => relative(root, file)).filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !appState.test(rel));
    const grouped = pickDepth(wanted, Math.round(Number(options.depth)) > 0 ? Number(options.depth) : stored.modules.length ? stored.depth : 2);
    const depth = grouped.depth;

    const groups = new Map<string, string[]>();
    for (const rel of wanted) groups.set(groupOf(rel, depth), [...(groups.get(groupOf(rel, depth)) ?? []), rel]);

    const aliases = await aliasPrefixes(root);
    const cards = new Map<string, KnowledgeModule>();
    const edges: { from: string; to: string }[] = [];
    let changed = 0; let reused = 0; let opened = 0;
    for (const [name, list] of [...groups.entries()].sort()) {
      const stamped: { file: string; size: number; mtimeMs: number }[] = [];
      for (const rel of list) {
        const stat = await fs.stat(path.join(root, rel)).catch(() => null);
        if (stat?.isFile()) stamped.push({ file: rel, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      const fingerprint = fingerprintOf(stamped);
      const previous = stored.modules.find((module) => module.name === name);
      if (!options.refresh && previous && previous.fingerprint === fingerprint && previous.filesTotal === list.length) {
        cards.set(name, { ...previous, files: list.slice(0, MAX_CARD_FILES), dependedBy: [] });
        // The stored edges still count: nothing inside this group changed, so an unread module
        // must not lose the imports it already reported to the ones reading it now.
        for (const to of previous.dependsOn) edges.push({ from: name, to });
        reused++;
        continue;
      }
      changed++;
      const languages = new Set<string>();
      const exportsFound = new Set<string>();
      let lines = 0; let codeFiles = 0; let unreadFiles = 0;
      for (const entry of stamped) {
        if (!textish.test(entry.file) || entry.size > MAX_FILE_BYTES) { unreadFiles++; continue; }
        const content = await fs.readFile(path.join(root, entry.file), "utf8").catch(() => "");
        if (!content) { unreadFiles++; continue; }
        opened++;
        lines += content.split("\n").length;
        languages.add(path.extname(entry.file) || "no extension");
        if (!codeExtension.test(entry.file)) continue;
        codeFiles++;
        for (const symbol of declarations(content)) exportsFound.add(symbol);
        for (const specifier of [...content.matchAll(importSource)].map((match) => match[1]).filter(Boolean) as string[]) {
          const target = resolveSpecifier(root, path.join(root, entry.file), specifier, aliases);
          if (!target) continue;
          const other = groupOf(relative(root, target), depth);
          if (other && other !== name) edges.push({ from: name, to: other });
        }
      }
      const all = [...exportsFound];
      cards.set(name, {
        name,
        files: list.slice(0, MAX_CARD_FILES),
        filesTotal: list.length,
        codeFiles,
        languages: [...languages].sort(),
        lines,
        unreadFiles,
        exports: all.slice(0, MAX_EXPORTS),
        exportsComplete: all.length <= MAX_EXPORTS,
        dependsOn: [],
        dependedBy: [],
        purpose: previous?.purpose || "",
        fingerprint,
      });
    }

    const dependencies = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!cards.has(edge.from) || !cards.has(edge.to) || edge.from === edge.to) continue;
      dependencies.set(edge.from, (dependencies.get(edge.from) ?? new Set()).add(edge.to));
      dependents.set(edge.to, (dependents.get(edge.to) ?? new Set()).add(edge.from));
    }
    for (const card of cards.values()) {
      card.dependsOn = [...(dependencies.get(card.name) ?? [])].sort();
      card.dependedBy = [...(dependents.get(card.name) ?? [])].sort();
    }

    const base: KnowledgeBase = { builtAt: Date.now(), depth, filesConsidered: wanted.length, truncated: inventory.truncated === true, note: "", modules: [...cards.values()] };
    // A purpose is only ever written for a card that has none, so a rebuild of an unchanged
    // folder asks for nothing.
    const missing = base.modules.filter((module) => !module.purpose);
    const asked = missing.slice(0, MAX_PURPOSE_CALL);
    let summarised = 0;
    if (options.summarize && asked.length) {
      const answer = await options.summarize(purposePrompt(base.modules, asked));
      const byName = new Map(asked.map((module) => [module.name, module]));
      for (const entry of parsePurposes(answer)) {
        const card = byName.get(entry.name);
        if (!card || !entry.purpose) continue;
        card.purpose = entry.purpose.slice(0, MAX_PURPOSE);
        summarised++;
      }
    }
    const untouched = missing.length - asked.length;
    base.note = [
      `${opened} file${opened === 1 ? "" : "s"} opened; ${reused} module card${reused === 1 ? "" : "s"} reused from a matching fingerprint.`,
      summarised ? `${summarised} purpose line${summarised === 1 ? "" : "s"} written by the model from that card's own facts.` : "No purpose lines were written this pass.",
      untouched > 0 ? `${untouched} module${untouched === 1 ? "" : "s"} still has no purpose line; build_knowledge again to write the next ${Math.min(MAX_PURPOSE_CALL, untouched)}.` : "",
      grouped.largest > MAX_GROUP_FILES ? `The largest module holds ${grouped.largest} files and cannot split further, so its card lists the first ${MAX_CARD_FILES} of them.` : "",
      base.truncated ? "The file inventory stopped at its cap, so a module may be missing files." : "",
    ].filter(Boolean).join(" ");
    await writeBase(root, base);
    return {
      ok: true,
      builtAt: base.builtAt,
      depth: base.depth,
      modules: base.modules.length,
      changed,
      reused,
      filesConsidered: base.filesConsidered,
      truncated: base.truncated,
      summarised,
      withoutPurpose: base.modules.filter((module) => !module.purpose).length,
      note: base.note,
      index: base.modules.map((module) => ({ name: module.name, files: module.filesTotal, lines: module.lines, purpose: module.purpose })),
    };
  });
}

/** One group holding most of the folder is not a module, so go a level deeper while that helps.
 * A flat directory cannot split, and the build says so rather than pretending it did. */
function largestGroup(rels: string[], depth: number) {
  const counts = new Map<string, number>();
  for (const rel of rels) { const name = groupOf(rel, depth); counts.set(name, (counts.get(name) ?? 0) + 1); }
  return Math.max(0, ...counts.values());
}
function pickDepth(rels: string[], wanted: number) {
  let depth = Math.min(6, Math.max(1, Math.round(wanted) || 2));
  let largest = largestGroup(rels, depth);
  while (largest > MAX_GROUP_FILES && depth < 6) {
    const next = largestGroup(rels, depth + 1);
    if (next >= largest) break;
    depth++; largest = next;
  }
  return { depth, largest };
}

function purposePrompt(all: KnowledgeModule[], asked: KnowledgeModule[]) {
  const digests = asked.map((module) => ({
    name: module.name,
    files: module.files.slice(0, 25),
    moreFiles: Math.max(0, module.filesTotal - Math.min(25, module.files.length)),
    lines: module.lines,
    languages: module.languages,
    exports: module.exports.slice(0, 15),
    dependsOn: module.dependsOn,
    dependedBy: module.dependedBy.slice(0, 10),
  }));
  return `Write one purpose line for each module below. Use only the files, declared names and imports supplied for it; do not guess at behaviour they do not show, and say nothing about files that are not listed.\nModules in this folder: ${all.map((module) => module.name).join(", ")}\n${JSON.stringify({ modules: digests }, null, 1).slice(0, 40_000)}`;
}

function parsePurposes(raw: string) {
  let parsed: any;
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); } catch { return []; }
  const entries = Array.isArray(parsed?.purposes) ? parsed.purposes : Array.isArray(parsed) ? parsed : [];
  return entries
    .filter((entry: any) => entry && typeof entry.name === "string" && typeof entry.purpose === "string")
    .map((entry: any) => ({ name: String(entry.name).trim(), purpose: String(entry.purpose).trim() }));
}

const tokenise = (value: string) => value.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length > 1);

/** Scores cards on the fields they really hold. No model ranks here, so the same query on the
 * same knowledge answers the same way until the folder changes. */
export async function searchKnowledge(projectPath: string, query: string, limit?: unknown) {
  const root = guardedRoot(projectPath);
  const base = await readBase(root);
  const terms = [...new Set(tokenise(String(query || "")))];
  if (!terms.length) throw new Error("Say what the knowledge search is looking for.");
  const wanted = Math.min(20, Math.max(1, Math.round(Number(limit)) || 8));
  const scored = base.modules.map((module) => {
    const fields: [string, string[], number][] = [
      ["module", tokenise(module.name), 4],
      ["purpose", tokenise(module.purpose), 3],
      ["file", tokenise(module.files.join(" ")), 2],
      ["export", tokenise(module.exports.join(" ")), 2],
      ["import", tokenise([...module.dependsOn, ...module.dependedBy].join(" ")), 1],
    ];
    let score = 0;
    const why: string[] = [];
    for (const [field, haystack, weight] of fields) {
      const hits = terms.filter((term) => haystack.some((token) => token === term || token.includes(term)));
      if (!hits.length) continue;
      score += hits.length * weight;
      why.push(`${field}: ${hits.join(", ")}`);
    }
    const whole = String(query).toLowerCase().trim();
    if (whole.length > 2 && module.name.toLowerCase().includes(whole)) { score += 5; why.push("the module path itself"); }
    return { score, module, why };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.module.lines - a.module.lines).slice(0, wanted);
  return {
    ok: true,
    builtAt: base.builtAt,
    depth: base.depth,
    modules: base.modules.length,
    ageMinutes: base.builtAt ? Math.max(0, Math.round((Date.now() - base.builtAt) / 60_000)) : undefined,
    matches: scored.map((entry) => ({ name: entry.module.name, score: entry.score, files: entry.module.filesTotal, lines: entry.module.lines, purpose: entry.module.purpose, why: entry.why.slice(0, 4) })),
    ...(scored.length ? {} : { note: base.modules.length ? "No module card holds those words. read_module {} lists them all, and build_knowledge re-reads the folder." : "This folder has no knowledge yet. Run build_knowledge first." }),
  };
}

/** No name gives the index; a name gives that module's whole card. */
export async function readModule(projectPath: string, name?: unknown) {
  const root = guardedRoot(projectPath);
  const base = await readBase(root);
  if (!base.modules.length) return { ok: false as const, error: "This folder has no knowledge built yet. Run build_knowledge." };
  const wanted = String(name || "").trim().replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!wanted) return {
    ok: true as const,
    builtAt: base.builtAt,
    depth: base.depth,
    filesConsidered: base.filesConsidered,
    truncated: base.truncated,
    note: base.note,
    index: base.modules.map((module) => ({ name: module.name, files: module.filesTotal, lines: module.lines, dependsOn: module.dependsOn, purpose: module.purpose })),
  };
  const lowered = wanted.toLowerCase();
  const exact = base.modules.find((module) => module.name.toLowerCase() === lowered);
  const module = exact || base.modules.find((module) => module.name.toLowerCase().startsWith(lowered));
  if (!module) return { ok: false as const, error: `No module called "${wanted.slice(0, 120)}" is in this folder's knowledge.`, known: base.modules.map((entry) => entry.name).slice(0, 60) };
  return { ok: true as const, builtAt: base.builtAt, ...(exact ? {} : { note: `Matched the module "${module.name}".` }), module };
}

/**
 * One-line truth about what the folder's cards currently hold, for the context block a session
 * hands every worker. Reads synchronously because that block is built between turns, not awaited.
 */
export function knowledgeStatus(projectPath: string) {
  const root = guardedRoot(projectPath);
  const base = readBaseSync(root);
  const missing = base.modules.filter((module) => !module.purpose).length;
  const age = base.builtAt ? Math.max(0, Math.round((Date.now() - base.builtAt) / 60_000)) : undefined;
  const line = base.modules.length
    ? `${base.modules.length} module card${base.modules.length === 1 ? "" : "s"} at grouping depth ${base.depth}, measured from ${base.filesConsidered} files${age === undefined ? "" : `, built ${age} minute${age === 1 ? "" : "s"} ago`}${missing ? `; ${missing} still without a purpose line` : ""}${base.truncated ? "; the file inventory stopped at its cap, so a module may be missing files" : ""}.`
    : "No module cards for this folder yet. build_knowledge reads the folder and writes them to .calvras/knowledge.json.";
  return { ok: true, builtAt: base.builtAt, modules: base.modules.length, depth: base.depth, filesConsidered: base.filesConsidered, truncated: base.truncated, withoutPurpose: missing, line, note: base.note };
}
