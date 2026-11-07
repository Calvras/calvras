import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Check, Pencil, Plus, Puzzle, Trash2, X } from "lucide-react";
import { createPlugin, deletePlugin, loadPlugins, savePlugins, updatePlugin, type Plugin } from "@/lib/plugins";

type Props = {
  initialView?: "list" | "guide";
  onClose: () => void;
  onChanged?: (plugins: Plugin[]) => void;
};

const field = "w-full rounded-xl border border-white/[0.09] bg-white/[0.035] px-3 py-2.5 text-[12px] text-white/85 outline-none placeholder:text-white/25 focus:border-white/20";
const secondary = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.09] px-3 py-2 text-[11px] font-medium text-white/65 transition-colors hover:bg-white/[0.06] hover:text-white/90 disabled:opacity-35";

export function PluginsPanel({ initialView = "list", onClose, onChanged }: Props) {
  const [view, setView] = useState<"list" | "guide">(initialView);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [editing, setEditing] = useState<Plugin | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState("");

  useEffect(() => { setView(initialView); }, [initialView]);

  useEffect(() => {
    const stored = loadPlugins();
    setPlugins(stored);
    onChanged?.(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editing) { setEditing(null); setError(""); }
      else onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [editing, onClose]);

  const commit = (next: Plugin[]) => {
    setPlugins(next);
    savePlugins(next);
    onChanged?.(next);
  };

  const beginNew = () => {
    setEditing("new");
    setName("");
    setDescription("");
    setInstructions("");
    setError("");
    setView("list");
  };

  const beginEdit = (plugin: Plugin) => {
    setEditing(plugin);
    setName(plugin.name);
    setDescription(plugin.description);
    setInstructions(plugin.instructions);
    setError("");
  };

  const save = () => {
    setError("");
    try {
      if (editing === "new") {
        createPlugin({ name, description, instructions });
        commit(loadPlugins());
        setEditing(null);
      } else if (editing) {
        commit(updatePlugin(editing.id, { name, description, instructions }));
        setEditing(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The plugin could not be saved.");
    }
  };

  const toggle = (plugin: Plugin) => {
    commit(updatePlugin(plugin.id, { enabled: !plugin.enabled }));
  };

  const remove = (plugin: Plugin) => {
    if (deleteId !== plugin.id) {
      setDeleteId(plugin.id);
      window.setTimeout(() => setDeleteId((current) => current === plugin.id ? "" : current), 4000);
      return;
    }
    setDeleteId("");
    commit(deletePlugin(plugin.id));
    if (editing && editing !== "new" && editing.id === plugin.id) setEditing(null);
  };

  return (
    <aside aria-label="Plugins" className="fixed right-3 top-[calc(var(--app-title-height,0px)+70px)] bottom-3 z-40 flex w-[min(430px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#171718] text-white animate-in slide-in-from-right-4 fade-in duration-300">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[14px] font-medium tracking-tight text-white/90"><Puzzle className="size-4 text-white/45" />Plugins</h2>
          <p className="mt-0.5 text-[11px] text-white/40">Reusable instructions the agent follows every turn.</p>
        </div>
        <button type="button" aria-label="Close plugins" title="Close (Esc)" onClick={onClose} className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80"><X className="size-4" /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {view === "guide" ? (
          <div>
            <button type="button" onClick={() => setView("list")} className={`${secondary} mb-4`}><ArrowLeft className="size-3.5" />Back to plugins</button>
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
              <h3 className="flex items-center gap-2 text-[13px] font-medium text-white/85"><BookOpen className="size-4 text-white/40" />How to manage plugins</h3>
              <ol className="mt-3 space-y-3 text-[12px] leading-5 text-white/55">
                <li><span className="font-medium text-white/80">1. Create one.</span> Click <span className="text-white/80">New plugin</span>, give it a short name, and write the rule the agent should follow. The instructions are plain language, like “Always use pnpm and run the typecheck before finishing.”</li>
                <li><span className="font-medium text-white/80">2. Turn it on or off.</span> The switch beside a plugin controls whether its instructions are sent with your messages. Disabled plugins stay saved but are ignored.</li>
                <li><span className="font-medium text-white/80">3. Edit anytime.</span> Use the pencil to rewrite the instructions. Changes apply from your next message.</li>
                <li><span className="font-medium text-white/80">4. Remove what you don’t need.</span> The trash button deletes a plugin. Click it twice to confirm.</li>
              </ol>
              <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11px] leading-5 text-white/35">Plugins are stored locally on this computer. Enabled plugins are added to each agent turn as a clearly marked block, so they work alongside your normal request.</p>
            </div>
            <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
              <h3 className="text-[11px] font-medium text-white/70">Good instructions look like</h3>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-black/25 p-3 font-mono text-[11px] leading-5 text-white/50">{`Use pnpm for every install.\nRun the typecheck and tests before saying work is done.\nPrefer small edits over rewriting whole files.`}</pre>
            </div>
            <button type="button" onClick={beginNew} className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-white px-3 py-2.5 text-[12px] font-medium text-black transition-opacity hover:opacity-90"><Plus className="size-3.5" />New plugin</button>
          </div>
        ) : editing ? (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[13px] font-medium text-white/85">{editing === "new" ? "New plugin" : "Edit plugin"}</h3>
              <button type="button" onClick={() => { setEditing(null); setError(""); }} className="text-[11px] text-white/40 hover:text-white/75">Cancel</button>
            </div>
            <label className="mb-3 block">
              <span className="mb-1.5 block text-[11px] text-white/45">Name</span>
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Use pnpm" className={field} />
            </label>
            <label className="mb-3 block">
              <span className="mb-1.5 block text-[11px] text-white/45">Short description <span className="text-white/25">(optional)</span></span>
              <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Package manager rules" className={field} />
            </label>
            <label className="mb-3 block">
              <span className="mb-1.5 block text-[11px] text-white/45">Instructions</span>
              <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={8} placeholder="Write the rules the agent should follow on every task…" className={`${field} resize-y leading-5`} />
            </label>
            {error && <p role="alert" className="mb-3 rounded-lg bg-red-400/10 px-3 py-2 text-[11px] text-red-200">{error}</p>}
            <button type="button" onClick={save} className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-white px-3 py-2.5 text-[12px] font-medium text-black transition-opacity hover:opacity-90"><Check className="size-3.5" />Save plugin</button>
          </div>
        ) : (
          <div>
            <div className="mb-4 flex gap-2">
              <button type="button" onClick={beginNew} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-white px-3 py-2.5 text-[12px] font-medium text-black transition-opacity hover:opacity-90"><Plus className="size-3.5" />New plugin</button>
              <button type="button" onClick={() => setView("guide")} className={secondary}><BookOpen className="size-3.5" />How to manage</button>
            </div>
            {plugins.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-8 text-center">
                <Puzzle className="mx-auto size-5 text-white/20" />
                <p className="mt-2 text-[12px] text-white/45">No plugins yet.</p>
                <p className="mt-1 text-[11px] leading-5 text-white/30">Create one to give the agent standing instructions, or read the guide above.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {plugins.map((plugin) => (
                  <li key={plugin.id} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium text-white/85">{plugin.name}</p>
                        {plugin.description && <p className="mt-0.5 truncate text-[10px] text-white/35">{plugin.description}</p>}
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={plugin.enabled}
                        aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                        onClick={() => toggle(plugin)}
                        className={`relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${plugin.enabled ? "bg-emerald-400/80" : "bg-white/[0.12]"}`}
                      >
                        <span className={`absolute top-[2px] size-[14px] rounded-full bg-[#171718] transition-all ${plugin.enabled ? "left-[16px]" : "left-[2px]"}`} />
                      </button>
                    </div>
                    <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11px] leading-5 text-white/40">{plugin.instructions}</p>
                    <div className="mt-2 flex items-center gap-1">
                      <span className={`mr-auto text-[10px] ${plugin.enabled ? "text-emerald-300/70" : "text-white/25"}`}>{plugin.enabled ? "Active" : "Paused"}</span>
                      <button type="button" aria-label={`Edit ${plugin.name}`} title="Edit" onClick={() => beginEdit(plugin)} className="rounded-md p-1.5 text-white/35 hover:bg-white/[0.06] hover:text-white/80"><Pencil className="size-3.5" /></button>
                      <button type="button" aria-label={`Delete ${plugin.name}`} title={deleteId === plugin.id ? "Click again to delete" : "Delete"} onClick={() => remove(plugin)} className={`rounded-md p-1.5 text-[10px] ${deleteId === plugin.id ? "bg-red-400/15 px-2 text-red-200" : "text-white/35 hover:bg-white/[0.06] hover:text-white/80"}`}>{deleteId === plugin.id ? "Sure?" : <Trash2 className="size-3.5" />}</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
