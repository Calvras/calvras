export type Plugin = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "calvras_plugins";
const MAX_PLUGINS = 40;
const MAX_INSTRUCTIONS = 12_000;

function readRaw(): Plugin[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: String(item.id || ""),
        name: String(item.name || "").slice(0, 80),
        description: String(item.description || "").slice(0, 240),
        instructions: String(item.instructions || "").slice(0, MAX_INSTRUCTIONS),
        enabled: item.enabled === true,
        createdAt: Number(item.createdAt) || 0,
        updatedAt: Number(item.updatedAt) || 0,
      }))
      .filter((item) => item.id && item.name.trim());
  } catch {
    return [];
  }
}

export function loadPlugins(): Plugin[] {
  return readRaw();
}

export function savePlugins(plugins: Plugin[]): Plugin[] {
  const next = plugins.slice(0, MAX_PLUGINS);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent("calvras:plugins", { detail: next }));
    } catch {
      /* storage unavailable */
    }
  }
  return next;
}

export function createPlugin(input: { name: string; description?: string; instructions: string }): Plugin {
  const name = input.name.trim();
  const instructions = input.instructions.trim();
  if (!name) throw new Error("Give the plugin a name.");
  if (!instructions) throw new Error("Add instructions the agent should follow.");
  if (name.length > 80) throw new Error("Keep the plugin name under 80 characters.");
  if (instructions.length > MAX_INSTRUCTIONS) throw new Error("Keep the instructions under 12,000 characters.");
  const now = Date.now();
  const plugin: Plugin = {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `plugin-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: (input.description || "").trim().slice(0, 240),
    instructions,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  const plugins = loadPlugins();
  if (plugins.length >= MAX_PLUGINS) throw new Error(`Plugins are limited to ${MAX_PLUGINS}. Delete one first.`);
  savePlugins([plugin, ...plugins]);
  return plugin;
}

export function updatePlugin(id: string, patch: Partial<Pick<Plugin, "name" | "description" | "instructions" | "enabled">>): Plugin[] {
  const plugins = loadPlugins().map((plugin) => {
    if (plugin.id !== id) return plugin;
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 80) : plugin.name;
    const instructions = patch.instructions !== undefined ? patch.instructions.trim().slice(0, MAX_INSTRUCTIONS) : plugin.instructions;
    return {
      ...plugin,
      ...patch,
      ...(name ? { name } : {}),
      ...(instructions ? { instructions } : {}),
      updatedAt: Date.now(),
    };
  });
  return savePlugins(plugins);
}

export function deletePlugin(id: string): Plugin[] {
  return savePlugins(loadPlugins().filter((plugin) => plugin.id !== id));
}

/** The prompt block injected into every agent turn while plugins are enabled. */
export function enabledPluginsPrompt(plugins: Plugin[] = loadPlugins()): string {
  const active = plugins.filter((plugin) => plugin.enabled && plugin.instructions.trim());
  if (!active.length) return "";
  return [
    "[ENABLED PLUGINS]",
    "The user enabled these plugins in Calvras. Follow their instructions for this task. If a plugin conflicts with the user's current request or with safety rules, the current request and safety rules win.",
    ...active.map((plugin) => `Plugin: ${plugin.name}${plugin.description ? ` — ${plugin.description}` : ""}\n${plugin.instructions.trim()}`),
    "[/ENABLED PLUGINS]",
  ].join("\n");
}
