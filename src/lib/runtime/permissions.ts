import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_RISK, type AccessMode, type ToolAction, toolQuestion } from "../tool-catalog";
import { blockReason, ruleEffect, urlHost, type Policies } from "../policy-rules";

export type Approval = { id: string; question: string; action: ToolAction; status: "pending" | "allowed" | "denied"; scope?: "once" | "task"; reason: string };
export type EnforcementRules = Pick<Policies, "toolRules" | "networkRules" | "outsideSandboxCommands" | "browserRules" | "browserJs" | "planReview">;
export const NO_RULES: EnforcementRules = { toolRules: {}, networkRules: [], outsideSandboxCommands: [], browserRules: [], browserJs: "proceed", planReview: "proceed" };
export class ApprovalNeeded extends Error {
  constructor(public approval: Approval) { super(approval.question); }
}
export function guardedRoot(projectPath: string) {
  const root = fs.realpathSync(path.resolve(projectPath));
  if (!fs.statSync(root).isDirectory()) throw new Error("Select a project directory.");
  if (root === path.parse(root).root) throw new Error("Choose a project folder, not an entire drive.");
  return root;
}
export function actionRisk(action: ToolAction): { ask: boolean; reason: string; external: boolean; destructive: boolean } {
  const risk = TOOL_RISK[action.type];
  const command = [action.command,...(['run_code','debug_code'].includes(action.type)?[action['code'],action.content]:[])].filter(value=>typeof value==='string').join('\n');
  const destructive = risk === "destructive" || action['destructive'] === true || /(?:\brm\s|\brmdir\b|\bdel\s|\bRemove-Item\b|\bformat\s|\b(?:git\s+reset\s+--hard|git\s+clean|git\s+push.*(?:--force|\s-f\b))|\b(?:drop\s+(?:database|table)))|\b(?:shutdown|reg\s+delete)\b|\b(?:rmSync|rmdirSync|unlinkSync|unlink|rmtree|remove)\s*\(/i.test(command);
  const outside = /(?:\b(?:curl|wget|Invoke-WebRequest|ssh|scp|docker|npx|npm\s+(?:install|i\b))\b|https?:\/\/|\b(?:git\s+(?:push|clone))\b|\b(?:vercel|netlify|wrangler|flyctl)\b)/i.test(command);
  const networkTypes = ["install_dependencies", "install_deps", "deploy_application", "github_request", "configure_mcp", "call_mcp_tool", "git_push", "git_clone", "search_documentation", "probe_key"];
  let external = outside || networkTypes.includes(action.type);
  if (["open_browser", "navigate_browser", "click_element", "fill_input", "click_at", "drag_at", "type_into_page"].includes(action.type)) {
    try { external = !["localhost", "127.0.0.1", "[::1]"].includes(new URL(String(action['url'])).hostname); } catch { external = true; }
  }
  const unknownShell = ["run_command", "run_terminal", "run_background_process", "run_code", "debug_code"].includes(action.type);
  return { ask: destructive || external || action.type === "request_user_approval" || unknownShell, reason: destructive ? "This operation can remove or replace existing work." : external ? "This action accesses an external service or downloads executable code." : unknownShell ? "This command can act with your operating-system permissions." : "", external, destructive };
}
const SHELL_TOOLS = ["run_command", "run_terminal", "run_background_process", "run_code", "debug_code"];
const ACTUATION_TOOLS = ["open_browser", "navigate_browser", "click_element", "fill_input", "upload_file_to_page", "press_page_key", "scroll_page", "go_back", "test_responsive_layout", "click_at", "hover_at", "drag_at", "type_into_page"];
const SCRIPT_TOOLS = ["run_page_script"];

/** The remote host an action reaches, whether it names one directly or hides one inside a command. */
export function actionHost(action: ToolAction): string {
  for (const key of ["url", "endpoint", "target_url", "dest"]) {
    const host = urlHost(action[key]);
    if (host) return host;
  }
  const text = [action.command, action["code"], action.content].filter((value) => typeof value === "string").join(" ");
  return /https?:\/\/([a-z0-9.-]+)/i.exec(text)?.[1] || "";
}
/** The program a shell action launches, used to match the outside-sandbox allow list. */
export function actionProgram(action: ToolAction): string {
  if (!SHELL_TOOLS.includes(action.type)) return "";
  return String(action.command || "").trim().split(/\s+/)[0]?.toLowerCase().replace(/^["'`]|["'`]$/g, "") || "";
}
export class PermissionScope {
  mode: AccessMode;
  private pending = new Map<string, Approval>();
  private approvals = new Map<string, string>();
  private grants = new Set<string>();
  private denied = new Set<string>();
  private expiry = new Map<string,number>();
  private tokenExpiry = new Map<string,number>();
  /** Plan review stays closed until the user approves something in this session. */
  private planCleared = false;
  rules: EnforcementRules = NO_RULES;
  constructor(mode: AccessMode = "automatic", rules?: Partial<EnforcementRules>) { this.mode = mode; if (rules) this.rules = { ...NO_RULES, ...rules }; }
  private canonical(value: any): any {
    if(Array.isArray(value))return value.map(item=>this.canonical(item));
    if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,this.canonical(value[key])]));
    return value;
  }
  private fingerprint(action: ToolAction) {
    // "intent" is only the sentence the model writes for the progress line. Leaving it in the
    // fingerprint would let a re-worded narration slip past a denial the user already made.
    const { intent: _intent, ...substance } = action as Record<string, unknown>;
    return createHash("sha256").update(JSON.stringify(this.canonical(substance))).digest("hex");
  }
  private immutable(value:any):any {if(value&&typeof value==='object'){for(const item of Object.values(value))this.immutable(item);Object.freeze(value);}return value;}
  private prune() {
    const now=Date.now();
    for(const [id,expires] of this.expiry)if(expires<=now){const item=this.pending.get(id);if(item?.status==='pending')item.status='denied';this.pending.delete(id);this.expiry.delete(id);}
    for(const [token,expires] of this.tokenExpiry)if(expires<=now){this.approvals.delete(token);this.tokenExpiry.delete(token);}
  }
  decision(id: string, choice: "once" | "task" | "deny") {
    this.prune();
    if(!['once','task','deny'].includes(choice))throw new Error('Invalid approval choice.');
    const approval = this.pending.get(id);
    if (!approval || approval.status !== "pending") throw new Error("This approval is no longer pending.");
    approval.status = choice === "deny" ? "denied" : "allowed";
    approval.scope=choice==='task'?'task':'once';
    if (choice !== "deny") {
      this.planCleared = true;
      const token = randomUUID(); this.approvals.set(token, this.fingerprint(approval.action));
      this.tokenExpiry.set(token,Date.now()+30*60*1000);
      const assessment=actionRisk(approval.action);
      if (choice === "task" && !assessment.destructive && !assessment.external && approval.action.type!=='request_user_approval') this.grants.add(approval.action.type);
      return { approval, token };
    }
    this.denied.add(this.fingerprint(approval.action));
    return { approval };
  }
  require(action: ToolAction, token?: string, scratch = false, userPressed = false) {
    this.prune();
    if(!TOOL_RISK[action.type])throw new Error('Unknown tool action.');
    const fingerprint = this.fingerprint(action);
    if(this.denied.has(fingerprint))throw new Error('The user denied this operation for this task. Do not retry it.');
    const host = actionHost(action);
    const blocked = blockReason(this.rules, action.type, host, ACTUATION_TOOLS.includes(action.type));
    if (blocked) throw new Error(blocked);
    if (token) {
      const approved=this.approvals.get(token);this.approvals.delete(token);this.tokenExpiry.delete(token);
      if(approved!==fingerprint)throw new Error('Approval token is expired, already used, or does not match this exact action.');
      return;
    }
    const risk = TOOL_RISK[action.type];
    const assessment = actionRisk(action);
    // Full access buys the terminal, not the workspace: commands, installs, builds, tests and
    // servers run without a prompt, but writing, creating or removing anything still asks the user.
    // use_user_file has its own native confirm and the two bookkeeping tools touch no user file.
    // A worker inside its own git checkout writes to scratch space, so its edits wait for the
    // resolve_worker approval that actually brings them back — Settings rules still apply.
    const FULL_ACCESS_QUIET = ["use_user_file", "write_memory", "create_checkpoint"];
    const forced = action.type === "request_user_approval";
    let ask = this.mode === "full" ? (["edit", "destructive"].includes(risk) && !(scratch && risk === "edit") && !FULL_ACCESS_QUIET.includes(action.type)) : forced || (this.mode === "ask" && risk !== "read" && risk !== "agent") || (this.mode === "automatic" && assessment.ask);
    // Settings rules outrank the preset in both directions: an allow list silences the
    // prompt it covers, an ask rule interrupts even Turbo Mode.
    const rule = this.rules.toolRules[action.type];
    const preapproved = SHELL_TOOLS.includes(action.type) && this.rules.outsideSandboxCommands.includes(actionProgram(action));
    const allowedHost = Boolean(host) && (ruleEffect(this.rules.networkRules, host) === "allow" || (ACTUATION_TOOLS.includes(action.type) && ruleEffect(this.rules.browserRules, host) === "allow"));
    if (rule === "allow") ask = false;
    else {
      if (rule === "ask") ask = true;
      else if ((preapproved || allowedHost) && !assessment.destructive) ask = false;
      if (SCRIPT_TOOLS.includes(action.type) && this.rules.browserJs === "ask") ask = true;
      // Plan review means nothing that changes the workspace runs until the user has
      // approved something in this session, whatever the preset says.
      if (this.rules.planReview === "ask" && !this.planCleared && ["edit", "execute", "destructive"].includes(risk)) ask = true;
    }
    if (this.mode !== "full" && forced) ask = true;
    // A control the user pressed is their approval already. The chat's Undo and a subagent's
    // Apply/Discard buttons run this action, so asking again would just be a second click for
    // the decision they made. A Settings block (above) still stops it.
    if (userPressed) ask = false;
    if (!ask || (this.grants.has(action.type) && !assessment.destructive && !assessment.external && action.type!=='request_user_approval')) return;
    const existing=[...this.pending.values()].find(item=>item.status==='pending'&&this.fingerprint(item.action)===fingerprint);
    if(existing)throw new ApprovalNeeded(existing);
    if(this.pending.size>=500) {
      const completed=[...this.pending.values()].find(item=>item.status!=='pending');
      if(completed){this.pending.delete(completed.id);this.expiry.delete(completed.id);}else throw new Error('Too many pending approvals. Resolve or cancel existing requests first.');
    }
    const snapshot=this.immutable(JSON.parse(JSON.stringify(this.canonical(action)))) as ToolAction;
    const approval: Approval = { id: randomUUID(), action:snapshot, question: toolQuestion(snapshot), status: "pending", reason: assessment.reason || "Your permission mode requires confirmation for this action." };
    this.pending.set(approval.id, approval);
    this.expiry.set(approval.id,Date.now()+30*60*1000);
    throw new ApprovalNeeded(approval);
  }
  list() { this.prune(); return [...this.pending.values()]; }
  denyPending() { for (const item of this.pending.values()) if (item.status === "pending") {item.status = "denied";this.denied.add(this.fingerprint(item.action));} this.approvals.clear(); this.tokenExpiry.clear(); this.grants.clear(); }
}
