import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export async function importFolder(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Folder uploads must come from this app." }, { status: 403 });
  }
  let root: string | undefined;
  try {
    if (Number(request.headers.get("content-length")) > 52 * 1024 * 1024) throw new Error("Folder uploads are limited to 50 MB.");
    const form = await request.formData();
    const entries = form.getAll("files");
    if (!entries.length || entries.length > 2000) throw new Error("Choose a folder with 1–2,000 files.");
    const files = entries.filter((entry): entry is File => typeof entry !== "string");
    if (files.length !== entries.length || files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) throw new Error("Folder uploads are limited to 50 MB.");
    const name = String(form.get("name") || "project").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "project";
    const base = path.join(os.homedir(), "Desktop", "Calvras Imports");
    fs.mkdirSync(base, { recursive: true });
    root = fs.mkdtempSync(path.join(base, `${name}-`));
    for (const file of files) {
      const relative = file.name.replaceAll("\\", "/").split("/").slice(1).join("/");
      if (!relative || relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("Invalid file path in folder.");
      if (relative.split("/").some((part) => part === "node_modules" || part === ".git" || part === ".env" || part.startsWith(".env."))) continue;
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
