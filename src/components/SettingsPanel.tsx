import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Folder, Gauge, Info, Keyboard, Palette, Plus, Search, Settings2, Trash2, X } from "lucide-react";
import QRCode from "qrcode";
import { TOOL_NAMES, TOOL_RISK } from "@/lib/tool-catalog";
import {
  DEFAULT_POLICIES, readPolicies, readPreferences, readProjectPolicies, savePolicies, savePreferences,
  saveProjectPolicy, type Effort, type Policies, type Preferences, type ProjectOverrides, type RoleRouting, type ToolEffect, type UrlRule, type WorkerRole,
} from "@/lib/preferences";
import { clearUsage, readUsage } from "@/lib/telemetry";
import { version } from "../../package.json";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { cn } from "@/lib/utils";

const USER_KEY = "calvras_user";
const SUPPORT_EMAIL = "calvrasnoreply@gmail.com";
type Profile = { provider?: string; email?: string; name?: string; picture?: string; joinedAt?: number };
type RememberedProject = { name: string; path?: string; tasks?: string[] };
type Page = "general" | "application" | "appearance" | "projects" | "not-in-project" | "conversations" | "usage" | "shortcuts" | "feedback" | "account";
type Route = { page: Page; project?: string };
/** Mirrors the JSON the local server answers; typed here so the window never imports the node module. */
type UsageSnapshot = { available: boolean; projects: number; toolCalls: number; failures: number; byTool: { tool: string; calls: number; failures: number }[]; tasksDone: number; tasksOpen: number; firstAt: number; lastAt: number; capped: boolean };
type StoreStatus = { hasKey: boolean; live: boolean; keyHint: string; merchantId: string };
type StorePlan = { planId: string; planName: string; productName: string; amount: number; currency: string; interval: string; checkoutUrl: string };

/** Only the desktop shell can block sleep, own the menu bar, or rebind the server. */
type Desktop = {
  setPreventSleep?: (on: boolean) => Promise<boolean>;
  setKeepInMenuBar?: (on: boolean) => Promise<boolean>;
  setRemoteControl?: (on: boolean) => Promise<{ saved: boolean; lanUrl: string; needsRestart: boolean }>;
  setDeviceName?: (name: string) => Promise<{ label: string; inMenuBar: boolean }>;
  networkInfo?: () => Promise<{ lanAddress: string; port: number; remoteControl: boolean }>;
  openSystemNotifications?: () => Promise<{ ok: boolean; message?: string }>;
  openExternal?: (url: string) => Promise<{ ok: boolean; message?: string }>;
};
const desktop = (): Desktop | undefined => typeof window === "undefined" ? undefined : (window as unknown as { __electron?: Desktop }).__electron;

const SECURITY_PRESETS: { value: Policies["securityPreset"]; label: string; description: string }[] = [
  { value: "ask", label: "Ask for approval", description: "Confirm every edit, command, and site visit before it happens." },
  { value: "automatic", label: "Confirm risky actions", description: "Routine workspace work runs on its own; anything destructive or outside asks first." },
  { value: "full", label: "Turbo Mode", description: "Build, run, and drive the computer without prompts — including destructive and external actions." },
];

const ROLE_ENGINES: { role: WorkerRole; label: string; description: string }[] = [
  { role: "builder", label: "Implementation worker", description: "Writes and edits the code it is handed." },
  { role: "verifier", label: "Verification worker", description: "Runs the checks and reports what actually happened." },
  { role: "researcher", label: "Research worker", description: "Reads and reports; it never edits the folder." },
];

const SHORTCUTS = [
  { keys: ["Ctrl", ","], action: "Open settings" },
  { keys: ["Esc"], action: "Close settings and floating panels" },
  { keys: ["/"], action: "Open the command list in the composer" },
  { keys: ["/", "browser"], action: "Hand the agent a browsing task" },
  { keys: ["/", "plan"], action: "Ask for a plan before any code" },
  { keys: ["Enter"], action: "Send the message" },
  { keys: ["Shift", "Enter"], action: "New line in the composer" },
  { keys: ["Backspace"], action: "Remove a command chip from an empty composer" },
  { keys: ["↑", "↓"], action: "Move through the command list" },
];

function readJson<T>(key: string, fallback: T): T {
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

const money = (plan: StorePlan) => `${plan.currency === "usd" ? "$" : `${plan.currency.toUpperCase()} `}${plan.amount.toFixed(2)} per ${plan.interval}`;

/** Stable per-install label, generated once and kept so the name never shifts under the user. */
function defaultDeviceName(): string {
  try {
    let seed = window.localStorage.getItem("calvras_device_seed");
    if (!seed) { seed = Math.random().toString(36).slice(2, 8); window.localStorage.setItem("calvras_device_seed", seed); }
    return `desktop-${seed}`;
  } catch { return "calvras-device"; }
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return <section className="settings-group"><h3>{label}</h3>{children}</section>;
}

function Card({ children }: { children: ReactNode }) {
  return <div className="settings-card">{children}</div>;
}

function Row({ title, description, badge, modified, children }: { title: string; description?: string | undefined; badge?: number | undefined; modified?: { count: number; detail: string[] } | undefined; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-row">
      <div className="min-w-0">
        <h3><span>{title}</span>{badge !== undefined && <span className="settings-badge">{badge}</span>}</h3>
        {description && <p>{description}</p>}
        {modified && modified.count > 0 && (
          <button type="button" className="settings-modified" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
            Modified in {modified.count} project{modified.count === 1 ? "" : "s"}<ChevronDown size={12} className={cn("transition-transform", !open && "-rotate-90")} />
          </button>
        )}
        {modified && open && <ul className="settings-modified-list">{modified.detail.map((line) => <li key={line}>{line}</li>)}</ul>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)} className={cn("settings-switch", checked && "is-on")}><span /></button>;
}

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (next: T) => void }) {
  return (
    <div role="group" aria-label={label} className="settings-segmented">
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

function RuleEditor({ title, description, rules, onSave }: { title: string; description: string; rules: UrlRule[]; onSave: (next: UrlRule[]) => void }) {
  const [draft, setDraft] = useState<UrlRule[]>(rules);
  const [pattern, setPattern] = useState("");
  const [effect, setEffect] = useState<UrlRule["effect"]>("allow");
  const [error, setError] = useState("");
  useEffect(() => { setDraft(rules); }, [rules]);
  const add = () => {
    const clean = pattern.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(clean)) { setError("Enter a hostname such as github.com, not a full URL."); return; }
    if (draft.some((rule) => rule.pattern === clean)) { setError(`${clean} is already in the list.`); return; }
    setDraft([...draft, { pattern: clean, effect }]); setPattern(""); setError("");
  };
  return (
    <div className="settings-editor">
      <p className="text-xs leading-6 text-white/45">{description}</p>
      <div className="settings-editor-add">
        <input aria-label="Hostname" className="settings-control min-w-0 flex-1" placeholder="example.com" value={pattern} onChange={(event) => setPattern(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        <select aria-label="Rule effect" className="settings-control" value={effect} onChange={(event) => setEffect(event.target.value as UrlRule["effect"])}><option value="allow">Allow</option><option value="deny">Deny</option></select>
        <button type="button" className="settings-control" onClick={add}><Plus size={13} />Add</button>
      </div>
      {error && <p role="alert" className="text-xs text-amber-200/80">{error}</p>}
      <ul className="settings-rule-list">
        {draft.length === 0 && <li className="settings-empty">No rules yet. The agent decides with its default policy.</li>}
        {draft.map((rule) => (
          <li key={rule.pattern}>
            <span className="min-w-0 flex-1 truncate">{rule.pattern}</span>
            <span className={cn("settings-rule-effect", rule.effect === "deny" && "is-deny")}>{rule.effect === "deny" ? "Denied" : "Allowed"}</span>
            <button type="button" aria-label={`Remove ${rule.pattern}`} className="settings-icon-button" onClick={() => setDraft(draft.filter((item) => item.pattern !== rule.pattern))}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      <div className="settings-editor-actions">
        <button type="button" className="settings-control" onClick={() => onSave(draft)}>Save {title}</button>
      </div>
    </div>
  );
}

function ToolPermissions({ rules, onSave }: { rules: Record<string, ToolEffect>; onSave: (next: Record<string, ToolEffect>) => void }) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(rules);
  useEffect(() => { setDraft(rules); }, [rules]);
  const visible = useMemo(() => TOOL_NAMES.filter((name) => name.includes(query.trim().toLowerCase())), [query]);
  const grouped = useMemo(() => {
    const buckets: Record<string, string[]> = {};
    for (const name of visible) (buckets[TOOL_RISK[name]] ||= []).push(name);
    return buckets;
  }, [visible]);
  return (
    <div className="settings-editor">
      <p className="text-xs leading-6 text-white/45">Default follows your security preset. Override any tool to always allow it, always ask, or block it.</p>
      <label className="settings-search"><Search size={13} /><input aria-label="Search tools" placeholder={`Search ${TOOL_NAMES.length} tools`} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <ul className="settings-tool-list">
        {Object.entries(grouped).map(([risk, names]) => (
          <li key={risk}>
            <p className="settings-rule-effect is-group">{risk}</p>
            {names!.map((name) => (
              <div key={name} className="settings-tool-row">
                <span className="min-w-0 flex-1 truncate">{name.replaceAll("_", " ")}</span>
                <div role="group" aria-label={`Permission for ${name}`} className="settings-segmented is-compact">
                  {(["default", "allow", "ask", "deny"] as const).map((choice) => {
                    const current = draft[name];
                    const active = choice === "default" ? !current : current === choice;
                    return <button key={choice} type="button" aria-pressed={active} onClick={() => {
                      const next = { ...draft };
                      if (choice === "default") delete next[name]; else next[name] = choice;
                      setDraft(next);
                    }}>{choice}</button>;
                  })}
                </div>
              </div>
            ))}
          </li>
        ))}
        {!visible.length && <li className="settings-empty">No tool matches “{query}”.</li>}
      </ul>
      <div className="settings-editor-actions"><button type="button" className="settings-control" onClick={() => onSave(draft)}>Save tool permissions</button></div>
    </div>
  );
}

export function SettingsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [route, setRoute] = useState<Route>({ page: "general" });
  const [policies, setPolicies] = useState<Policies>(DEFAULT_POLICIES);
  const [preferences, setPreferences] = useState<Preferences>(readPreferences());
  const [profile, setProfile] = useState<Profile>({});
  const [projects, setProjects] = useState<RememberedProject[]>([]);
  const [projectPolicies, setProjectPolicies] = useState<Record<string, ProjectOverrides>>({});
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [dialog, setDialog] = useState<"" | "tools" | "network" | "sandbox" | "browser-rules">("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [remote, setRemote] = useState({ lanUrl: "", available: false, applying: false });
  const [feedback, setFeedback] = useState("");
  const [usage, setUsage] = useState(0);
  const [taskEvents, setTaskEvents] = useState(0);
  const [replyEvents, setReplyEvents] = useState(0);
  const [stats, setStats] = useState<UsageSnapshot | null>(null);
  const [store, setStore] = useState<StoreStatus>({ hasKey: false, live: false, keyHint: "", merchantId: "" });
  const [merchantDraft, setMerchantDraft] = useState("");
  const [plans, setPlans] = useState<StorePlan[]>([]);
  const [storeNote, setStoreNote] = useState("");
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(() => {
    setPolicies(readPolicies());
    setPreferences(readPreferences());
    setProjectPolicies(readProjectPolicies());
    setProjects(readJson<RememberedProject[]>("calvras_projects", []));
    const log = readUsage();
    setUsage(log.length);
    setTaskEvents(log.filter((item) => item.kind === "task").length);
    setReplyEvents(readJson<{ role?: unknown }[]>("calvras_chat_messages", []).filter((item) => item?.role === "assistant").length);
    try { setProfile(readJson<Profile>(USER_KEY, {})); } catch { setProfile({}); }
  }, []);

  // Usage and the plan catalogue come from the local server, so a window that cannot reach it
  // shows nothing rather than a number invented on the client.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const read = async (path: string) => { try { const response = await fetch(path); return response.ok ? await response.json() : null; } catch { return null; } };
    void Promise.all([read("/api/agent/usage"), read("/api/agent/payments"), read("/api/agent/payments/catalog")]).then(([usageBody, statusBody, catalogBody]) => {
      if (!alive) return;
      if (usageBody && typeof usageBody.toolCalls === "number") setStats(usageBody as UsageSnapshot);
      if (statusBody && typeof statusBody.hasKey === "boolean") { setStore(statusBody as StoreStatus); setMerchantDraft(String((statusBody as StoreStatus).merchantId || "")); }
      if (catalogBody && Array.isArray(catalogBody.plans)) { setPlans(catalogBody.plans as StorePlan[]); setStoreNote(catalogBody.ok ? "" : String(catalogBody.error || "")); }
    });
    return () => { alive = false; };
  }, [open]);

  const checkStore = async () => {
    setChecking(true); setStoreNote("");
    try {
      const saved = await fetch("/api/agent/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merchantId: merchantDraft }) });
      const status = await saved.json().catch(() => null);
      if (!saved.ok) throw new Error(String(status?.error || "The merchant id was not accepted."));
      if (status && typeof status.hasKey === "boolean") setStore(status as StoreStatus);
      const catalog = await (await fetch("/api/agent/payments/catalog")).json().catch(() => null);
      const list = Array.isArray(catalog?.plans) ? catalog.plans as StorePlan[] : [];
      setPlans(list);
      setStoreNote(catalog?.ok ? (list.length ? `${list.length} plan${list.length === 1 ? "" : "s"} read from the store.` : "The store answered, but this merchant has no plans in its catalogue yet.") : String(catalog?.error || "The store did not answer."));
    } catch (error) {
      setStoreNote(error instanceof Error ? error.message : "Could not reach the payments store from this computer.");
    } finally { setChecking(false); }
  };

  // Plans are priced from this computer: the store credential lives here, so the page has to be the
  // one this server answers, not the public site, which has no catalogue to read.
  const openPricing = () => { const bridge = desktop(); onOpenChange(false); const target = new URL("/pricing", window.location.href).href; if (bridge?.openExternal) void bridge.openExternal(target); else window.location.href = "/pricing"; };
  const openCheckout = (plan: StorePlan) => { const bridge = desktop(); if (bridge?.openExternal) void bridge.openExternal(plan.checkoutUrl); else window.location.href = plan.checkoutUrl; };

  useEffect(() => {
    if (!open) return;
    refresh();
    const info = desktop()?.networkInfo;
    if (!info) { setRemote({ lanUrl: "", available: false, applying: false }); return; }
    let alive = true;
    void info().then((network) => {
      if (!alive) return;
      setRemote({ lanUrl: `http://${network.lanAddress || "this-computer"}:${network.port}/app`, available: Boolean(network.lanAddress), applying: false });
    }).catch(() => { if (alive) setRemote({ lanUrl: "", available: false, applying: false }); });
    return () => { alive = false; };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { if (dialog) setDialog(""); else onOpenChange(false); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dialog, onOpenChange]);

  const update = (patch: Partial<Policies>) => { const next = { ...policies, ...patch }; setPolicies(next); savePolicies(next); setNotice(""); };
  const updatePreferences = (patch: Partial<Preferences>) => { const next = { ...preferences, ...patch }; setPreferences(next); savePreferences(next); };
  const setRoleRouting = (role: WorkerRole, patch: Partial<RoleRouting>) => updatePreferences({ workerRouting: { ...preferences.workerRouting, [role]: { ...preferences.workerRouting[role], ...patch } } });

  const applyDesktop = async (patch: Partial<Policies>) => {
    update(patch);
    const bridge = desktop();
    if ("preventSleep" in patch) await Promise.resolve(bridge?.setPreventSleep?.(Boolean(patch.preventSleep))).catch(() => {});
    if ("keepInMenuBar" in patch) await Promise.resolve(bridge?.setKeepInMenuBar?.(Boolean(patch.keepInMenuBar))).catch(() => {});
    if ("deviceName" in patch) await Promise.resolve(bridge?.setDeviceName?.(String(patch.deviceName || ""))).catch(() => {});
    if ("remoteControl" in patch) {
      if (!bridge?.setRemoteControl) { setError("Remote control needs the desktop app. Running in a browser window cannot rebind the local server."); return; }
      setRemote((current) => ({ ...current, applying: true }));
      const result = await Promise.resolve(bridge.setRemoteControl(Boolean(patch.remoteControl))).catch(() => undefined);
      setRemote((current) => ({ ...current, applying: false, lanUrl: result?.lanUrl || current.lanUrl, available: current.available || Boolean(result?.lanUrl) }));
      setNotice(result?.needsRestart ? "Remote control applies the next time Calvras starts. Until then this computer answers to itself only." : "");
    }
  };

  const overridesFor = (field: keyof ProjectOverrides) => Object.entries(projectPolicies).filter(([, value]) => value[field]).map(([path, value]) => `${projects.find((item) => item.path === path)?.name || path.split(/[\\/]/).pop()} · ${String(value[field])}`);

  const [qr, setQr] = useState("");
  useEffect(() => {
    if (!open || !policies.remoteControl || !remote.lanUrl) { setQr(""); return; }
    let alive = true;
    void QRCode.toDataURL(remote.lanUrl, { margin: 1, width: 132, color: { dark: "#e8ecff", light: "#0b1020" } }).then((value) => { if (alive) setQr(value); }).catch(() => { if (alive) setQr(""); });
    return () => { alive = false; };
  }, [open, policies.remoteControl, remote.lanUrl]);

  if (!open) return null;
  const activeProject = route.project ? projects.find((item) => (item.path || item.name) === route.project) : undefined;
  const pageTitle = activeProject ? activeProject.name : ({
    general: "General", application: "Application", appearance: "Appearance", projects: "Projects", "not-in-project": "Not in Project",
    conversations: "Conversations", usage: "Usage", shortcuts: "Keyboard shortcuts", feedback: "Provide Feedback", account: "Account",
  } as Record<Page, string>)[route.page];
  const pageSubtitle = activeProject ? "Override how Calvras works inside this folder only." : ({
    general: "Configure agent execution, queued message delivery, and permissions.",
    application: "Manage Calvras app settings.",
    appearance: "Manage how Calvras looks and moves.",
    projects: "Permissions Calvras uses per folder. Anything you set here overrides General.",
    "not-in-project": "Settings Calvras uses for conversations that are not attached to a folder.",
    conversations: "Manage the projects and conversations Calvras remembers on this computer.",
    usage: "What Calvras has actually done on this computer, and how to move up a plan.",
    shortcuts: "Keys that work anywhere in Calvras.",
    feedback: "Tell us what the agent got wrong. Notes are stored on this computer.",
    account: "Manage your plan, credentials, and general preferences.",
  } as Record<Page, string>)[route.page];
  const listedProjects = showAllProjects ? projects : projects.slice(0, 5);
  const projectKey = (item: RememberedProject) => item.path || item.name;

  return (
    <div role="dialog" aria-modal="true" aria-label="Settings" className="settings-screen">
      <aside className="settings-rail is-open">
        <p className="px-4 pb-3 pt-5 text-[10px] uppercase tracking-[0.14em] text-white/25">Settings</p>
        <nav aria-label="Settings sections">
          <button aria-current={route.page === "general" && !route.project ? "page" : undefined} onClick={() => setRoute({ page: "general" })}><Settings2 size={15} />General</button>
          <button aria-current={route.page === "application" ? "page" : undefined} onClick={() => setRoute({ page: "application" })}><Info size={15} />Application</button>
          <button aria-current={route.page === "appearance" ? "page" : undefined} onClick={() => setRoute({ page: "appearance" })}><Palette size={15} />Appearance</button>
          <p className="px-4 pb-1 pt-4 text-[10px] uppercase tracking-[0.12em] text-white/25">Projects</p>
          {listedProjects.map((item) => (
            <button key={projectKey(item)} aria-current={route.project === projectKey(item) ? "page" : undefined} onClick={() => setRoute({ page: "projects", project: projectKey(item) })}><Folder size={15} />{item.name}</button>
          ))}
          {!projects.length && <p className="px-4 py-1 text-[11px] text-white/25">No folders yet</p>}
          {projects.length > 5 && <button className="is-sub" onClick={() => setShowAllProjects((current) => !current)}>{showAllProjects ? "Show Fewer" : "Show All"}</button>}
          <p className="px-4 pb-1 pt-4 text-[10px] uppercase tracking-[0.12em] text-white/25">Not in Project</p>
          <button aria-current={route.page === "not-in-project" ? "page" : undefined} onClick={() => setRoute({ page: "not-in-project" })}><Folder size={15} />Conversations without a folder</button>
          <p className="px-4 pb-1 pt-4 text-[10px] uppercase tracking-[0.12em] text-white/25">Conversations</p>
          <button aria-current={route.page === "conversations" ? "page" : undefined} onClick={() => setRoute({ page: "conversations" })}><Keyboard size={15} />History and memory</button>
        </nav>
        <div className="mt-auto pb-4">
          <button aria-current={route.page === "usage" ? "page" : undefined} onClick={() => setRoute({ page: "usage" })}><Gauge size={15} />Usage</button>
          <button aria-current={route.page === "shortcuts" ? "page" : undefined} onClick={() => setRoute({ page: "shortcuts" })}><Keyboard size={15} />Shortcuts</button>
          <button aria-current={route.page === "feedback" ? "page" : undefined} onClick={() => setRoute({ page: "feedback" })}><Info size={15} />Provide Feedback</button>
          <button className="settings-account" aria-label="Account" aria-current={route.page === "account" ? "page" : undefined} onClick={() => setRoute({ page: "account" })}>
            {profile.picture
              ? <img src={profile.picture} alt="" className="size-7 shrink-0 rounded-full object-cover" />
              : <img src="/calvras-logo.png" alt="" className="size-7 shrink-0 rounded-lg object-contain" />}
            <span className="min-w-0"><span className="block truncate text-[12px] text-white/85">{profile.name || profile.email || "Local workspace"}</span><span className="block truncate text-[11px] text-white/35">{profile.email || "Not signed in"}</span></span>
          </button>
        </div>
      </aside>

      <div className="settings-body">
        <header className="settings-topbar">
          <h2 className="text-[15px] font-medium tracking-tight text-white/85">{pageTitle}</h2>
          <button className="shell-icon-button" aria-label="Close settings" onClick={() => onOpenChange(false)}><X size={17} /></button>
        </header>

        <div className="settings-content">
          <p className="settings-page-sub">{pageSubtitle}</p>

          {activeProject && <ProjectPage project={activeProject} policies={projectPolicies[projectKey(activeProject)] || {}} global={policies} onChange={(patch) => { setProjectPolicies(saveProjectPolicy(projectKey(activeProject), patch)); refresh(); }} />}

          {!activeProject && route.page === "general" && <>
            <Group label="Execution">
              <Card>
                <Row title="Queued Messages" description="Configure when follow-up messages are sent.">
                  <Segmented label="Queued Messages" value={policies.queuedDelivery} onChange={(queuedDelivery) => update({ queuedDelivery })} options={[{ value: "queue", label: "Queue" }, { value: "immediate", label: "Send Immediately" }]} />
                </Row>
                <button type="button" className="settings-link-row" onClick={() => setRoute({ page: "shortcuts" })}>Keyboard shortcuts</button>
              </Card>
            </Group>
            <Group label="Global Permissions">
              <Card>
                <Row title="Security Preset" description={SECURITY_PRESETS.find((preset) => preset.value === policies.securityPreset)?.description} modified={{ count: overridesFor("securityPreset").length, detail: overridesFor("securityPreset") }}>
                  <select aria-label="Security Preset" className="settings-control" value={policies.securityPreset} onChange={(event) => update({ securityPreset: event.target.value as Policies["securityPreset"] })}>
                    {SECURITY_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                  </select>
                </Row>
                <Row title="Tool Permissions" badge={TOOL_NAMES.length} description="Modify permissions for file, terminal, and MCP tools.">
                  <button type="button" className="settings-control" onClick={() => setDialog("tools")}>Open</button>
                </Row>
              </Card>
            </Group>
            <Group label="Agent Behavior">
              <Card>
                <Row title="Response effort" description="Balance speed against the depth of reasoning. You can also change this per message in the composer.">
                  <select aria-label="Default response effort" className="settings-control" value={preferences.effort} onChange={(event) => updatePreferences({ effort: event.target.value as Preferences["effort"] })}><option>Quick</option><option>Balanced</option><option>Thorough</option></select>
                </Row>
                <Row title="Plan Review Policy" description="Whether the agent asks you to review its documents." modified={{ count: overridesFor("planReview").length, detail: overridesFor("planReview") }}>
                  <select aria-label="Plan Review Policy" className="settings-control" value={policies.planReview} onChange={(event) => update({ planReview: event.target.value as Policies["planReview"] })}><option value="proceed">Always Proceed</option><option value="ask">Always Ask</option></select>
                </Row>
                <p className="settings-hint">Type <kbd>/</kbd> and select <kbd>plan</kbd> to have the agent generate a plan.</p>
              </Card>
            </Group>
            <Group label="Subagent engines">
              <Card>
                <p className="settings-group-note">Each delegated worker is inferred on the route you pick for its role. Leave the model blank to use the normal cascade at that effort.</p>
                {ROLE_ENGINES.map(({ role, label, description }) => (
                  <Row key={role} title={label} description={description}>
                    <div className="flex items-center justify-end gap-2">
                      <select aria-label={`${label} effort`} className="settings-control" value={preferences.workerRouting[role].effort} onChange={(event) => setRoleRouting(role, { effort: event.target.value as Effort })}>
                        <option>Quick</option><option>Balanced</option><option>Thorough</option>
                      </select>
                      <input aria-label={`${label} model`} className="settings-control w-[9.5rem]" placeholder="cascade" value={preferences.workerRouting[role].model} onChange={(event) => setRoleRouting(role, { model: event.target.value.slice(0, 120) })} />
                    </div>
                  </Row>
                ))}
              </Card>
            </Group>
            <Group label="Network Permissions">
              <Card>
                <Row title="Network Access Rules" badge={policies.networkRules.length} description="Configure allowed and denied URLs for reading.">
                  <button type="button" className="settings-control" onClick={() => setDialog("network")}>Open</button>
                </Row>
              </Card>
            </Group>
            <Group label="Terminal &amp; Tooling Permissions">
              <Card>
                <Row title="Commands Outside Sandbox" badge={policies.outsideSandboxCommands.length} description="Configure allowed commands outside the sandbox.">
                  <button type="button" className="settings-control" onClick={() => setDialog("sandbox")}>Open</button>
                </Row>
              </Card>
            </Group>
            <Group label="Browser">
              <p className="settings-group-note">Configure the browser subagent. It requires Chrome to be installed. The browser subagent can be invoked by typing <kbd>/browser</kbd> in the conversation input box.</p>
              <Card>
                <Row title="Browser Javascript Execution Policy" description="Controls whether the agent can run custom JavaScript to automate complex browser actions.">
                  <select aria-label="Browser Javascript Execution Policy" className="settings-control" value={policies.browserJs} onChange={(event) => update({ browserJs: event.target.value as Policies["browserJs"] })}><option value="proceed">Always Proceed</option><option value="ask">Ask First</option></select>
                </Row>
                <Row title="Browser Actuation Rules" badge={policies.browserRules.length} description="Configure allowed and denied URLs for browser actuation.">
                  <button type="button" className="settings-control" onClick={() => setDialog("browser-rules")}>Edit</button>
                </Row>
              </Card>
            </Group>
          </>}

          {!activeProject && route.page === "application" && <>
            <Group label="General">
              <Card>
                <Row title="Prevent Sleep" description="Prevent the computer from sleeping while the app is running.">
                  <Switch label="Prevent Sleep" checked={policies.preventSleep} onChange={(preventSleep) => void applyDesktop({ preventSleep })} />
                </Row>
                <Row title="Keep In Menu Bar" description="Keep the app accessible from the menu bar and running in the background when all windows are closed.">
                  <Switch label="Keep In Menu Bar" checked={policies.keepInMenuBar} onChange={(keepInMenuBar) => void applyDesktop({ keepInMenuBar })} />
                </Row>
              </Card>
            </Group>
            <Group label="Remote Control">
              <Card>
                <Row title="Enable Remote Control" description="Work with local agents from another device on this network.">
                  <Switch label="Enable Remote Control" checked={policies.remoteControl} onChange={(remoteControl) => void applyDesktop({ remoteControl })} />
                </Row>
                <div className="settings-row">
                  <div className="min-w-0">
                    <h3><span>Device Name</span></h3>
                    <input aria-label="Device Name" className="settings-control mt-2 w-full max-w-[320px]" value={policies.deviceName} placeholder={defaultDeviceName()} onChange={(event) => void applyDesktop({ deviceName: event.target.value })} />
                    <p className="mt-2 text-[11px] leading-5 text-white/35">Shown on the menu-bar icon so you can tell this computer apart from others.{remote.applying ? " Applying…" : remote.available ? " Scan the code to open this device in Remote Control, or " : " Remote control needs a network address. Connect to Wi-Fi or ethernet first."}{remote.available && <button type="button" className="settings-inline-link" onClick={() => void desktop()?.openExternal?.(remote.lanUrl)}>copy link</button>}</p>
                  </div>
                  {policies.remoteControl && qr && <img src={qr} alt={`QR code for ${remote.lanUrl}`} className="size-[132px] shrink-0 rounded-xl border border-white/10" />}
                </div>
              </Card>
            </Group>
            <Group label="Notifications">
              <Card>
                <Row title="Notification Settings" description="To modify notification settings, open your operating system's system preferences.">
                  <button type="button" className="settings-control" onClick={() => {
                    const bridge = desktop();
                    if (bridge?.openSystemNotifications) void bridge.openSystemNotifications().then((result) => { if (result && !result.ok) setError(result.message || "The system panel did not open."); });
                    else setError("Opening system preferences needs the desktop app.");
                  }}>Open System Preferences</button>
                </Row>
                <Row title="Completion sound" description="Play a short chime when a task finishes while Calvras is in the background.">
                  <Switch label="Completion sound" checked={preferences.completionSound} onChange={(completionSound) => updatePreferences({ completionSound })} />
                </Row>
              </Card>
            </Group>
            <Group label="Version">
              <Card>
                <Row title="Calvras" description={`Version ${version}. The desktop bundle runs its own local server on this computer.`} />
              </Card>
            </Group>
          </>}

          {!activeProject && route.page === "appearance" && <>
            <Group label="Surfaces">
              <Card>
                <Row title="Workspace tone" description="Choose soft graphite surfaces or a deeper black finish.">
                  <select aria-label="Workspace tone" className="settings-control" value={preferences.palette} onChange={(event) => updatePreferences({ palette: event.target.value as Preferences["palette"] })}><option value="graphite">Graphite</option><option value="midnight">Midnight</option></select>
                </Row>
                <Row title="Reduce motion" description="Keep transitions and activity animations still. System preferences are also respected.">
                  <Switch label="Reduce motion" checked={preferences.reduceMotion} onChange={(reduceMotion) => updatePreferences({ reduceMotion })} />
                </Row>
              </Card>
            </Group>
          </>}

          {!activeProject && route.page === "projects" && <>
            <Group label="Folders">
              <Card>
                {projects.map((item) => {
                  const override = projectPolicies[projectKey(item)];
                  return <Row key={projectKey(item)} title={item.name} description={item.path || "No folder path remembered"} modified={{ count: override ? Object.keys(override).length : 0, detail: Object.entries(override || {}).map(([key, value]) => `${key} · ${String(value)}`) }}>
                    <button type="button" className="settings-control" onClick={() => setRoute({ page: "projects", project: projectKey(item) })}>Open</button>
                  </Row>;
                })}
                {!projects.length && <p className="settings-empty">No folders remembered yet. Add one from a new chat.</p>}
              </Card>
            </Group>
          </>}

          {route.page === "not-in-project" && <>
            <Group label="Defaults">
              <Card>
                <Row title="Security Preset" description={SECURITY_PRESETS.find((preset) => preset.value === policies.securityPreset)?.description}>
                  <select aria-label="Not in project security preset" className="settings-control" value={policies.securityPreset} onChange={(event) => update({ securityPreset: event.target.value as Policies["securityPreset"] })}>
                    {SECURITY_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                  </select>
                </Row>
                <Row title="Queued Messages" description="Configure when follow-up messages are sent in chats without a folder.">
                  <Segmented label="Queued Messages without a folder" value={policies.queuedDelivery} onChange={(queuedDelivery) => update({ queuedDelivery })} options={[{ value: "queue", label: "Queue" }, { value: "immediate", label: "Send Immediately" }]} />
                </Row>
                <Row title="Plan Review Policy" description="Whether the agent asks you to review its documents when no folder is open.">
                  <select aria-label="Not in project plan review" className="settings-control" value={policies.planReview} onChange={(event) => update({ planReview: event.target.value as Policies["planReview"] })}><option value="proceed">Always Proceed</option><option value="ask">Always Ask</option></select>
                </Row>
              </Card>
            </Group>
          </>}

          {route.page === "conversations" && <>
            <Group label="On this computer">
              <p className="settings-group-note">These lists live in this app profile. Clearing them does not touch any file in your folders.</p>
              <Card>
                <Row title="Projects" description={`${projects.length} folder${projects.length === 1 ? "" : "s"} Calvras remembers.`}><button type="button" className="settings-danger" disabled={!projects.length} onClick={() => { window.localStorage.removeItem("calvras_projects"); refresh(); setNotice("Project list cleared. Folders on disk are untouched."); }}>Clear</button></Row>
                <Row title="Conversations" description={`${readJson<unknown[]>("calvras_recents", []).length} recent conversation${readJson<unknown[]>("calvras_recents", []).length === 1 ? "" : "s"} in the sidebar.`}><button type="button" className="settings-danger" disabled={!readJson<unknown[]>("calvras_recents", []).length} onClick={() => { window.localStorage.removeItem("calvras_recents"); refresh(); setNotice("Conversation list cleared."); }}>Clear</button></Row>
                <Row title="Explored workspaces" description={`${readJson<string[]>("calvras_seen_workspaces", []).length} folder${readJson<string[]>("calvras_seen_workspaces", []).length === 1 ? "" : "s"} already mapped, so Calvras does not re-read them from scratch.`}><button type="button" className="settings-danger" disabled={!readJson<string[]>("calvras_seen_workspaces", []).length} onClick={() => { window.localStorage.removeItem("calvras_seen_workspaces"); refresh(); setNotice("Workspace exploration notes cleared. Calvras will re-read folders next time."); }}>Reset</button></Row>
                <Row title="Per-folder overrides" description={`${Object.keys(projectPolicies).length} folder${Object.keys(projectPolicies).length === 1 ? "" : "s"} deviate from General.`}><button type="button" className="settings-danger" disabled={!Object.keys(projectPolicies).length} onClick={() => { window.localStorage.removeItem("calvras_project_policies"); refresh(); setNotice("All folders follow General again."); }}>Reset</button></Row>
              </Card>
            </Group>
          </>}

          {route.page === "usage" && <>
            <Group label="Plan">
              <Card>
                <Row title="Your plan: Calvras Local" description="This install runs on this computer. Paid tiers are sold by Payments AI, which acts as the merchant of record for the card.">
                  <button type="button" className="settings-milk" onClick={openPricing}>Upgrade plan</button>
                </Row>
                {plans.map((plan) => (
                  <Row key={plan.planId} title={`${plan.productName} — ${plan.planName}`} description={`${money(plan)} · sold by Payments AI. Opening checkout does not charge you.`}>
                    <button type="button" className="settings-control" onClick={() => openCheckout(plan)}>Open checkout</button>
                  </Row>
                ))}
              </Card>
            </Group>

            <Group label="Activity on this computer">
              <Card>
                <div className="settings-usage-grid">
                  <span className="settings-usage-cell"><b>{taskEvents}</b><span>Tasks handed to the agent</span></span>
                  <span className="settings-usage-cell"><b>{replyEvents}</b><span>Replies written back</span></span>
                  <span className="settings-usage-cell"><b>{stats ? stats.toolCalls : "—"}</b><span>Tool calls recorded{stats && stats.failures ? ` · ${stats.failures} failed` : ""}</span></span>
                  <span className="settings-usage-cell"><b>{stats ? stats.projects : projects.length}</b><span>Project folders worked in</span></span>
                  <span className="settings-usage-cell"><b>{readJson<unknown[]>("calvras_recents", []).length}</b><span>Conversations remembered</span></span>
                  <span className="settings-usage-cell"><b>{stats?.firstAt ? new Date(stats.firstAt).toLocaleDateString() : "—"}</b><span>Earliest recorded action</span></span>
                </div>
                {!stats?.available && <Row title="Nothing to total yet" description="The local server did not answer, or no folder has been worked in. Calvras will not show a number it cannot source." />}
                {stats?.capped && <Row title="Rolling window" description="Each folder keeps its most recent 300 operations, so these totals are the working history rather than an archive." />}
              </Card>
            </Group>

            <Group label="Where the work went">
              <Card>
                {stats && stats.byTool.length
                  ? stats.byTool.map((row) => <Row key={row.tool} title={row.tool} description={`${row.calls} call${row.calls === 1 ? "" : "s"}${row.failures ? ` · ${row.failures} failed` : ""}`} />)
                  : <Row title="No operations recorded" description="Run a task in a folder and every tool the agent uses shows up here." />}
                {stats && (stats.tasksDone || stats.tasksOpen) ? <Row title="Agent tasks" description={`${stats.tasksDone} finished · ${stats.tasksOpen} still open across those folders.`} /> : null}
              </Card>
            </Group>

            <Group label="Payments store">
              <Card>
                <Row title="Merchant id" description="The id shown in the Payments AI dashboard. Calvras reads its live plan catalogue with it.">
                  <span className="settings-row-control flex items-center gap-2">
                    <input aria-label="Merchant id" className="settings-control w-[290px]" placeholder="paste the merchant id" value={merchantDraft} onChange={(event) => setMerchantDraft(event.target.value)} />
                    <button type="button" className="settings-control" disabled={checking} onClick={() => void checkStore()}>{checking ? "Checking" : "Check"}</button>
                  </span>
                </Row>
                <Row title="Store credential" description={store.hasKey ? `Saved on this computer ${store.live ? "for live payments" : "in sandbox"} · ends ${store.keyHint}. It stays in the app's own folder and is never sent to this window.` : "No Payments AI credential is saved on this computer."} />
                {storeNote && <Row title="Store answer" description={storeNote} />}
              </Card>
            </Group>
          </>}

          {route.page === "shortcuts" && <>
            <Group label="Keyboard">
              <Card>
                {SHORTCUTS.map((item) => (
                  <div key={item.action} className="settings-row">
                    <div><h3><span>{item.action}</span></h3></div>
                    <span className="settings-row-control flex items-center gap-1">{item.keys.map((key) => <kbd key={key} className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-white/60">{key}</kbd>)}</span>
                  </div>
                ))}
              </Card>
            </Group>
          </>}

          {route.page === "feedback" && <>
            <Group label="Notes">
              <Card>
                <div className="settings-row settings-row-stack">
                  <div><h3><span>What went wrong?</span></h3><p>Notes are written to this computer only. Nothing is uploaded.</p></div>
                  <textarea aria-label="Feedback" className="settings-control mt-3 h-32 w-full resize-y" placeholder="The agent stopped before checking the preview…" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
                  <div className="flex justify-end gap-2">
                    <button type="button" className="settings-control" disabled={!feedback.trim()} onClick={() => {
                      const stored = readJson<{ at: number; text: string }[]>("calvras_feedback", []);
                      window.localStorage.setItem("calvras_feedback", JSON.stringify([...stored, { at: Date.now(), text: feedback.trim() }].slice(-100)));
                      setFeedback(""); setNotice(`Saved on this computer. ${stored.length + 1} note${stored.length + 1 === 1 ? "" : "s"} waiting to review.`);
                    }}>Save note</button>
                    <button type="button" className="settings-control" disabled={!feedback.trim()} onClick={() => void desktop()?.openExternal?.(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Calvras feedback")}&body=${encodeURIComponent(feedback)}`)}>Send by email</button>
                  </div>
                </div>
                <Row title="Saved notes" description={`${readJson<unknown[]>("calvras_feedback", []).length} note${readJson<unknown[]>("calvras_feedback", []).length === 1 ? "" : "s"} stored locally.`}><button type="button" className="settings-danger" disabled={!readJson<unknown[]>("calvras_feedback", []).length} onClick={() => { window.localStorage.removeItem("calvras_feedback"); refresh(); setNotice("Notes cleared."); }}>Clear</button></Row>
              </Card>
            </Group>
          </>}

          {route.page === "account" && <>
            <Group label="General">
              <Card>
                <Row title="Enable Telemetry" description="Record what Calvras did on this computer so the Account page can show real activity. Nothing leaves this machine.">
                  <Switch label="Enable Telemetry" checked={policies.telemetry} onChange={(telemetry) => update({ telemetry })} />
                </Row>
                <Row title="Marketing Emails" description="Show a way to ask for product updates from inside the app.">
                  <Switch label="Marketing Emails" checked={policies.marketingEmails} onChange={(marketingEmails) => update({ marketingEmails })} />
                </Row>
                {policies.telemetry && <Row title="Activity log" description={`${usage} event${usage === 1 ? "" : "s"} recorded locally.`}><button type="button" className="settings-danger" disabled={!usage} onClick={() => { clearUsage(); refresh(); setNotice("Activity log cleared."); }}>Clear</button></Row>}
                {policies.marketingEmails && <Row title="Product updates" description="Opens your mail app with a note to the Calvras support address."><button type="button" className="settings-control" onClick={() => void desktop()?.openExternal?.(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Send me Calvras updates")}`)}>Ask for updates</button></Row>}
              </Card>
            </Group>
            <Group label="Account">
              <Card>
                <Row title="Your Plan: Calvras Local" description="This install runs entirely on this computer and is not tied to a hosted plan.">
                  <button type="button" className="settings-control" onClick={() => { const bridge = desktop(); if (bridge?.openExternal) void bridge.openExternal("https://calvras.com"); else setNotice("calvras.com — open it from a browser window."); }}>Learn more</button>
                </Row>
                <Row title="Email" description={profile.email || "Signed in locally without an email address."}>
                  <button type="button" className="settings-danger" onClick={() => { window.localStorage.removeItem(USER_KEY); window.location.href = "/app"; }}>Sign Out</button>
                </Row>
              </Card>
            </Group>
            <p className="mt-8 text-xs text-white/35">By using this app, you agree to its <button type="button" className="settings-inline-link" onClick={() => { const bridge = desktop(); if (bridge?.openExternal) void bridge.openExternal("https://calvras.com/terms"); else window.location.href = "/terms"; }}>Terms of Service</button></p>
          </>}

          {notice && <p role="status" className="mt-6 text-xs text-white/65">{notice}</p>}
          {error && <p role="alert" className="mt-6 text-xs leading-5 text-amber-200/80">{error}</p>}
        </div>
      </div>

      <Dialog open={dialog === "tools"} onOpenChange={(next) => { if (!next) setDialog(""); }}>
        <DialogContent className="settings-dialog"><DialogTitle>Tool Permissions</DialogTitle><ToolPermissions rules={policies.toolRules} onSave={(toolRules) => { update({ toolRules }); setDialog(""); setNotice(`${Object.keys(toolRules).length} tool override${Object.keys(toolRules).length === 1 ? "" : "s"} saved.`); }} /></DialogContent>
      </Dialog>
      <Dialog open={dialog === "network"} onOpenChange={(next) => { if (!next) setDialog(""); }}>
        <DialogContent className="settings-dialog"><DialogTitle>Network Access Rules</DialogTitle><RuleEditor title="network rules" description="Applies to every URL the agent reads: web search, documentation, probes. A denied host blocks the request before it leaves this computer." rules={policies.networkRules} onSave={(networkRules) => { update({ networkRules }); setDialog(""); }} /></DialogContent>
      </Dialog>
      <Dialog open={dialog === "sandbox"} onOpenChange={(next) => { if (!next) setDialog(""); }}>
        <DialogContent className="settings-dialog"><DialogTitle>Commands Outside Sandbox</DialogTitle><SandboxEditor commands={policies.outsideSandboxCommands} onSave={(outsideSandboxCommands) => { update({ outsideSandboxCommands }); setDialog(""); }} /></DialogContent>
      </Dialog>
      <Dialog open={dialog === "browser-rules"} onOpenChange={(next) => { if (!next) setDialog(""); }}>
        <DialogContent className="settings-dialog"><DialogTitle>Browser Actuation Rules</DialogTitle><RuleEditor title="browser rules" description="Applies to clicking, typing, and uploading on real sites. Local previews are always allowed." rules={policies.browserRules} onSave={(browserRules) => { update({ browserRules }); setDialog(""); }} /></DialogContent>
      </Dialog>
    </div>
  );
}

function SandboxEditor({ commands, onSave }: { commands: string[]; onSave: (next: string[]) => void }) {
  const [draft, setDraft] = useState(commands);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setDraft(commands); }, [commands]);
  return (
    <div className="settings-editor">
      <p className="text-xs leading-6 text-white/45">Commands that reach outside this project — installers, containers, deploy tools — normally ask first. List a command name to let it run without a prompt.</p>
      <div className="settings-editor-add">
        <input aria-label="Command name" className="settings-control min-w-0 flex-1" placeholder="docker" value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (/^[a-z][a-z0-9._-]{0,40}$/i.test(value.trim())) { setDraft([...new Set([...draft, value.trim().toLowerCase()])]); setValue(""); setError(""); } else setError("Use a plain command name such as docker."); } }} />
        <button type="button" className="settings-control" onClick={() => { if (/^[a-z][a-z0-9._-]{0,40}$/i.test(value.trim())) { setDraft([...new Set([...draft, value.trim().toLowerCase()])]); setValue(""); setError(""); } else setError("Use a plain command name such as docker."); }}><Plus size={13} />Add</button>
      </div>
      {error && <p role="alert" className="text-xs text-amber-200/80">{error}</p>}
      <ul className="settings-rule-list">
        {draft.length === 0 && <li className="settings-empty">Nothing is pre-approved. Outside commands ask first.</li>}
        {draft.map((command) => (
          <li key={command}><span className="min-w-0 flex-1 truncate">{command}</span><span className="settings-rule-effect">Allowed</span><button type="button" aria-label={`Remove ${command}`} className="settings-icon-button" onClick={() => setDraft(draft.filter((item) => item !== command))}><Trash2 size={13} /></button></li>
        ))}
      </ul>
      <div className="settings-editor-actions"><button type="button" className="settings-control" onClick={() => onSave(draft)}>Save commands</button></div>
    </div>
  );
}

function ProjectPage({ project, policies, global, onChange }: { project: RememberedProject; policies: ProjectOverrides; global: Policies; onChange: (patch: ProjectOverrides) => void }) {
  return (
    <Group label="This folder">
      <Card>
        <Row title="Security Preset" description={`Follows General (${SECURITY_PRESETS.find((preset) => preset.value === global.securityPreset)?.label}) until you choose something else.`}>
          <select aria-label="Project security preset" className="settings-control" value={policies.securityPreset || ""} onChange={(event) => onChange({ securityPreset: (event.target.value || undefined) as ProjectOverrides["securityPreset"] })}>
            <option value="">Follow General</option>
            {SECURITY_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
          </select>
        </Row>
        <Row title="Plan Review Policy" description={`Follows General (${global.planReview === "ask" ? "Always Ask" : "Always Proceed"}).`}>
          <select aria-label="Project plan review" className="settings-control" value={policies.planReview || ""} onChange={(event) => onChange({ planReview: (event.target.value || undefined) as ProjectOverrides["planReview"] })}>
            <option value="">Follow General</option><option value="proceed">Always Proceed</option><option value="ask">Always Ask</option>
          </select>
        </Row>
        <Row title="Queued Messages" description={`Follows General (${global.queuedDelivery === "queue" ? "Queue" : "Send Immediately"}).`}>
          <select aria-label="Project queued delivery" className="settings-control" value={policies.queuedDelivery || ""} onChange={(event) => onChange({ queuedDelivery: (event.target.value || undefined) as ProjectOverrides["queuedDelivery"] })}>
            <option value="">Follow General</option><option value="queue">Queue</option><option value="immediate">Send Immediately</option>
          </select>
        </Row>
        <Row title="Folder path" description={project.path || "Calvras does not remember a path for this entry."} />
      </Card>
    </Group>
  );
}
