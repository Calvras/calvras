import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const MAX_FILES = 2_000;
const MAX_BYTES = 50 * 1024 * 1024;
const isJunk = (parts: string[]) => parts.some((part) => part === "node_modules" || part === ".git" || part === ".env" || part.startsWith(".env."));

function newWorkspace(name: string) {
  const base = path.join(os.homedir(), "Desktop", "Calvras Imports");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${name}-`));
}

/** Opening a whole drive would make every later file operation crawl and put the agent one
 *  typo away from the user's entire profile, so the picker stops at folders that contain one. */
function tooBroadForAWorkspace(source: string): string | null {
  const home = path.resolve(os.homedir());
  if (source === path.parse(source).root) return "Pick a folder inside your files, not a whole drive.";
  if (source === home || home.startsWith(source + path.sep)) return "Pick the project folder itself, not your whole user folder.";
  const system = path.resolve(process.env["SystemRoot"] || "C:\\Windows");
  const programFiles = path.resolve(process.env["ProgramFiles"] || "C:\\Program Files");
  for (const protectedDir of [system, programFiles]) {
    if (source === protectedDir || source.startsWith(protectedDir + path.sep)) return "That is a system folder, so Calvras will not work inside it.";
  }
  return null;
}

export async function importFolder(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Folder uploads must come from this app." }, { status: 403 });
  }
  let root: string | undefined;
  try {
    if (Number(request.headers.get("content-length")) > 52 * 1024 * 1024) throw new Error("Folder uploads are limited to 50 MB.");
    const form = await request.formData();
    const entries = form.getAll("files");
    if (!entries.length || entries.length > MAX_FILES) throw new Error("Choose a folder with 1–2,000 files.");
    const files = entries.filter((entry): entry is File => typeof entry !== "string");
    if (files.length !== entries.length || files.reduce((total, file) => total + file.size, 0) > MAX_BYTES) throw new Error("Folder uploads are limited to 50 MB.");
    const name = String(form.get("name") || "project").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "project";
    root = newWorkspace(name);
    for (const file of files) {
      const parts = file.name.replaceAll("\\", "/").split("/").filter(Boolean);
      // Browsers normally include the chosen root folder in the file name; a flat
      // single-file upload can arrive without it, so only strip a real root segment.
      const relative = (parts.length > 1 ? parts.slice(1) : parts).join("/");
      if (!relative || relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("Invalid file path in folder.");
      if (isJunk(relative.split("/"))) continue;
      const target = path.resolve(root, relative);
      if (!target.startsWith(root + path.sep)) throw new Error("Invalid file path in folder.");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await file.arrayBuffer()));
    }
    return Response.json({ ok: true, name, projectPath: root });
  } catch (error) {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    return Response.json({ error: error instanceof Error ? error.message : "Folder upload failed." }, { status: 400 });
  }
}

/**
 * Adopts a folder the user chose in the native picker, in place, straight off their disk.
 * Nothing is copied: a real project is often tens of thousands of files, and a copy would
 * both crawl and split the work away from the folder the user actually keeps. An empty
 * folder is a project too — that is how someone starts a new app — and the browser's own
 * directory input can never report one, so this path is what makes it usable.
 */
export async function importFolderFromPath(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Folder uploads must come from this app." }, { status: 403 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const picked = String(body?.path ?? "");
    if (!path.isAbsolute(picked)) throw new Error("Pick the folder from your own disk.");
    const source = path.resolve(picked);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`"${source}" is not a folder you can pick.`);
    const refusal = tooBroadForAWorkspace(source);
    if (refusal) throw new Error(refusal);
    const name = path.basename(source).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "project";
    return Response.json({ ok: true, name, projectPath: source });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Folder upload failed." }, { status: 400 });
  }
}
