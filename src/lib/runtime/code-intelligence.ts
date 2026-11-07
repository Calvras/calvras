import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as TypeScript from "typescript";

export const CODE_INTELLIGENCE_TOOLS = ["search_symbols", "go_to_definition", "find_references", "get_hover_info", "list_symbols", "read_diagnostics", "analyze_project", "detect_framework", "read_project_structure", "read_package_json", "find_entry_point", "map_dependencies", "analyze_codebase", "trace_function_calls", "resolve_imports", "inspect_dependencies", "organize_imports"] as const;

const excluded = /^(?:node_modules|\.git|\.output|dist|electron-dist|build|coverage|\.next|\.agents|\.cache|\.codex|\.env(?:\..*)?|\.ssh|\.aws|.*\.(?:pem|key|p12|pfx))$/i;
const codeExtension = /\.(?:[cm]?[jt]sx?)$/i;
const runtimeRequire = createRequire(import.meta.url);
// Keep the compiler's CommonJS runtime external: bundling it as ESM breaks __filename, and it only
// exists in the desktop runtime, where prepare-electron-runtime.mjs ships it beside the server.
// Requiring it while this module loads kills the hosted Worker on boot, so resolve it on first use.
let compiler: typeof TypeScript | undefined;
const ts = new Proxy({} as typeof TypeScript, {
  get: (_target, property) => ((compiler ??= runtimeRequire("typescript") as typeof TypeScript) as unknown as Record<PropertyKey, unknown>)[property],
});

/** Compiler code may be bundled separately from its standard-library declarations. */
export function compilerLibraryRoot(): string {
  try { return fs.realpathSync(path.dirname(runtimeRequire.resolve("typescript/lib/lib.d.ts"))); }
  catch {
    const fallback = path.dirname(ts.getDefaultLibFilePath({}));
    if (fs.existsSync(path.join(fallback, "lib.d.ts"))) return fs.realpathSync(fallback);
    throw new Error("TypeScript standard library declarations are missing. Include typescript/lib in the application runtime.");
  }
}
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };

/** Resolves existing paths through symlinks before permitting access. */
export function safeProjectPath(root: string, input: string) {
  const file = path.resolve(root, input);
  if (!inside(root, file) || path.relative(root, file).split(path.sep).some((part) => excluded.test(part))) throw new Error("Path is outside the project or contains protected files");
  const real = fs.realpathSync(file);
  if (!inside(root, real) || path.relative(root, real).split(path.sep).some((part) => excluded.test(part))) throw new Error("Symlink points outside the project or into protected files");
  const stat = fs.statSync(real);
  if (stat.isFile() && stat.nlink > 1) throw new Error("Hard-linked project files are protected");
  return real;
}
const safePath = safeProjectPath;

export function projectFileInventory(root: string) {
  const files: string[] = [];
  let truncated = false;
  const visit = (directory: string, depth: number) => {
    if (depth > 20) { truncated = true; return; }
    const priority = (name: string) => name === "src" ? 0 : ["app", "pages", "packages", "lib"].includes(name) ? 1 : 2;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name))) {
      if (excluded.test(entry.name) || entry.isSymbolicLink()) continue;
      if (files.length >= 1500) { truncated = true; return; }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && fs.statSync(file).nlink <= 1) files.push(file);
    }
  };
  visit(root, 0);
  return { files, truncated };
}
const scan = projectFileInventory;

function read(root: string, file: string) {
  const resolved = safePath(root, file);
  if (fs.statSync(resolved).size > 1024 * 1024) throw new Error("File exceeds the 1 MB code analysis limit");
  return fs.readFileSync(resolved, "utf8");
}

function createService(root: string, files: string[]) {
  const sources = files.filter((file) => codeExtension.test(file) && fs.statSync(file).size <= 1024 * 1024);
  let options: TypeScript.CompilerOptions = { allowJs: true, checkJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true };
  const config = files.find((file) => file === path.join(root, "tsconfig.json"));
  if (config) {
    const parsed = ts.parseConfigFileTextToJson(config, read(root, config));
    if (!parsed.error) options = { ...options, ...ts.convertCompilerOptionsFromJson(parsed.config?.compilerOptions ?? {}, root).options, noEmit: true };
  }
  // Config inheritance/plugins cannot execute code or expand the project boundary.
  options['plugins'] = [];
  const libraryRoot = compilerLibraryRoot();
  const allowed = (file: string) => {
    try { safePath(root, file); return true; }
    catch { try { return inside(libraryRoot, fs.realpathSync(file)); } catch { return false; } }
  };
  const host: TypeScript.LanguageServiceHost = {
    getScriptFileNames: () => sources,
    getScriptVersion: () => "1",
    getScriptSnapshot: (file) => allowed(file) && fs.statSync(file).isFile() && fs.statSync(file).size <= 1024 * 1024 ? ts.ScriptSnapshot.fromString(fs.readFileSync(file, "utf8")) : undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => path.join(libraryRoot, ts.getDefaultLibFileName(options)),
    fileExists: (file) => allowed(file) && ts.sys.fileExists(file),
    readFile: (file) => allowed(file) ? ts.sys.readFile(file) : undefined,
    directoryExists: (directory) => { try { safePath(root, directory); return fs.statSync(directory).isDirectory(); } catch { return false; } },
    readDirectory: (directory, extensions, exclude, include, depth) => { try { safePath(root, directory); return ts.sys.readDirectory(directory, extensions, exclude, include, depth).filter(allowed); } catch { return []; } },
  };
  return { service: ts.createLanguageService(host), sources, options };
}

function location(root: string, file: string, span: TypeScript.TextSpan) {
  const source = ts.createSourceFile(file, read(root, file), ts.ScriptTarget.Latest, true);
  const position = source.getLineAndCharacterOfPosition(span.start);
  return { file: path.relative(root, file).replaceAll("\\", "/"), line: position.line + 1, column: position.character + 1, start: span.start, length: span.length };
}

export async function executeCodeIntelligence(type: string, args: Record<string, any>, projectPath: string): Promise<any> {
  if (!(CODE_INTELLIGENCE_TOOLS as readonly string[]).includes(type)) throw new Error(`Unsupported intelligence tool: ${type}`);
  const root = fs.realpathSync(projectPath);
  const { files, truncated } = scan(root);
  const relative = (file: string) => path.relative(root, file).replaceAll("\\", "/");
  const packageFile = files.find((file) => file === path.join(root, "package.json"));
  const pkg = packageFile ? JSON.parse(read(root, packageFile)) : {};
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const frameworks = ["next", "@tanstack/react-start", "@angular/core", "vue", "svelte", "react", "vite", "express", "astro"].filter((name) => dependencies[name]);
  if (type === "read_package_json") return { package: pkg, found: Boolean(packageFile) };
  if (type === "detect_framework") return { frameworks, packageManager: files.some((file) => file.endsWith("pnpm-lock.yaml")) ? "pnpm" : files.some((file) => file.endsWith("yarn.lock")) ? "yarn" : "npm", languages: [...new Set(files.filter((file) => codeExtension.test(file)).map((file) => path.extname(file)))] };
  if (type === "inspect_dependencies") return { dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {}, scripts: pkg.scripts ?? {}, note: "Declared versions; no network vulnerability audit performed." };
  if (type === "read_project_structure") return { files: files.map(relative), truncated };
  if (type === "find_entry_point") return { entries: [...new Set([pkg.main, pkg.module, ...files.map(relative).filter((file) => /^(?:src\/)?(?:main|index|app|server|entry(?:-client|-server)?)\.[cm]?[jt]sx?$/.test(file))].filter(Boolean))], scripts: pkg.scripts ?? {} };
  // An explicitly requested source must remain available when the inventory is capped.
  const selected = args['path'] || args['file'] ? safePath(root, args['path'] ?? args['file']) : undefined;
  const { service, sources, options } = createService(root, selected ? [...new Set([...files, selected])] : files);
  try {
    const program = service.getProgram()!;
    const source = selected ? program.getSourceFile(selected) : undefined;
    const resolvePosition = () => {
      if (!source) throw new Error("Provide a JavaScript or TypeScript file path");
      if (Number.isInteger(args['position'])) {
        if (args['position'] < 0 || args['position'] > source.text.length) throw new Error("Position is outside the file");
        return args['position'];
      }
      const line = Number(args['line'] ?? 1) - 1;
      const column = Number(args['column'] ?? 1) - 1;
      if (!Number.isInteger(line) || line < 0 || line >= source.getLineStarts().length || !Number.isInteger(column) || column < 0) throw new Error("Invalid line or column");
      const position = source.getPositionOfLineAndCharacter(line, column);
      if (position > source.text.length || (line + 1 < source.getLineStarts().length && position >= source.getLineStarts()[line + 1]!)) throw new Error("Column is outside the line");
      return position;
    };
    const publicLocation = (file: string, span: TypeScript.TextSpan) => { try { return location(root, file, span); } catch { return null; } };
    if (type === "organize_imports") {
      if (!source || !selected) throw new Error("Provide a JavaScript or TypeScript file path");
      const edits = service.organizeImports({ type: "file", fileName: selected }, { newLineCharacter: "\n", indentSize: 2, tabSize: 2, convertTabsToSpaces: true }, {});
      const prepared = edits.map((edit) => {
        const file = safePath(root, edit.fileName);
        const before = read(root, file);
        let after = before;
        for (const change of [...edit.textChanges].sort((a, b) => b.span.start - a.span.start)) after = after.slice(0, change.span.start) + change.newText + after.slice(change.span.start + change.span.length);
        return { file, before, after };
      });
      // Approval and checkpoint creation belong to the caller, as with other editing tools.
      for (const edit of prepared) fs.writeFileSync(edit.file, edit.after, "utf8");
      return { changed: prepared.filter((edit) => edit.before !== edit.after).map((edit) => ({ file: relative(edit.file), before: edit.before, after: edit.after })) };
    }
    if (type === "go_to_definition") return { definitions: (service.getDefinitionAtPosition(selected!, resolvePosition()) ?? []).map((item) => ({ ...publicLocation(item.fileName, item.textSpan), name: item.name, kind: item.kind })).filter((item) => item.file) };
    if (type === "find_references") return { references: (service.getReferencesAtPosition(selected!, resolvePosition()) ?? []).map((item) => { const loc = publicLocation(item.fileName, item.textSpan); return loc && { ...loc, isWriteAccess: item.isWriteAccess }; }).filter(Boolean) };
    if (type === "get_hover_info") { const info = service.getQuickInfoAtPosition(selected!, resolvePosition()); return { hover: info ? { display: ts.displayPartsToString(info.displayParts), documentation: ts.displayPartsToString(info.documentation), ...publicLocation(selected!, info.textSpan) } : null }; }
    if (type === "read_diagnostics") {
      const targets = selected ? [selected] : sources;
      const diagnostics = targets.flatMap((file) => [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)]).slice(0, 200);
      return { diagnostics: diagnostics.map((diagnostic) => ({ code: diagnostic.code, severity: ts.DiagnosticCategory[diagnostic.category].toLowerCase(), message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"), ...(diagnostic.file ? publicLocation(diagnostic.file.fileName, { start: diagnostic.start ?? 0, length: diagnostic.length ?? 0 }) : {}) })), limit: 200 };
    }
    if (type === "search_symbols" || type === "list_symbols") {
      const query = String(args['query'] ?? args['name'] ?? "").toLowerCase();
      const symbols: any[] = [];
      for (const file of selected ? [selected] : sources) {
        const tree = service.getNavigationTree(file);
        const visit = (node: TypeScript.NavigationTree, parent = "") => {
          if (node.kind !== "script" && (!query || node.text.toLowerCase().includes(query))) symbols.push({ name: node.text, kind: node.kind, parent, score: node.text.toLowerCase() === query ? 3 : node.text.toLowerCase().startsWith(query) ? 2 : 1, ...location(root, file, node.spans[0] ?? { start: 0, length: 0 }) });
          node.childItems?.forEach((child) => visit(child, node.kind === "script" ? "" : node.text));
        };
        tree.childItems?.forEach((child) => visit(child));
      }
      return { symbols: symbols.sort((a, b) => b.score - a.score).slice(0, Math.min(Number(args['limit']) || 100, 500)), searchMethod: "TypeScript AST symbol name ranking", truncated };
    }
    const graph: any[] = [];
    const calls: any[] = [];
    for (const file of selected ? [selected] : sources) {
      const ast = program.getSourceFile(file);
      if (!ast) continue;
      const visit = (node: TypeScript.Node, caller = "<module>") => {
        let current = caller;
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) current = node.name?.getText(ast) ?? "<anonymous>";
        if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) current = node.parent.name.getText(ast);
        const moduleName = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
        if (moduleName) {
          const resolved = ts.resolveModuleName(moduleName, file, options, { fileExists: (target) => { try { safePath(root, target); return ts.sys.fileExists(target); } catch { return false; } }, readFile: (target) => { try { return read(root, target); } catch { return undefined; } } }).resolvedModule;
          graph.push({ from: relative(file), import: moduleName, to: resolved ? relative(safePath(root, resolved.resolvedFileName)) : null, external: !moduleName.startsWith(".") && !resolved });
        }
        if (type === "trace_function_calls" && ts.isCallExpression(node)) {
          const name = node.expression.getText(ast);
          const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          const definitions = service.getDefinitionAtPosition(file, target.getStart(ast)) ?? [];
          calls.push({ caller: current, callee: name, ...location(root, file, { start: node.getStart(ast), length: node.getWidth(ast) }), definitions: definitions.map((item) => publicLocation(item.fileName, item.textSpan)).filter(Boolean) });
        }
        ts.forEachChild(node, (child) => visit(child, current));
      };
      visit(ast);
    }
    if (type === "map_dependencies" || type === "resolve_imports") return { imports: graph, unresolved: graph.filter((item) => !item.to), note: "Resolution is restricted to project files; external packages are reported by name." };
    if (type === "trace_function_calls") return { calls: calls.filter((call) => !args['name'] || call.caller === args['name'] || call.callee === args['name']), analysis: "Static TypeScript calls; runtime dispatch may differ." };
    return { frameworks, files: files.length, sourceFiles: sources.length, imports: graph, scripts: pkg.scripts ?? {}, dependencies, truncated, analysis: "Static project map; JavaScript and TypeScript have compiler-backed symbol analysis." };
  } finally { service.dispose(); }
}


