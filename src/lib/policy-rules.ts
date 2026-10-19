import type { AccessMode } from "./tool-catalog";

/** `allow` runs without a prompt, `ask` always interrupts, `deny` blocks the tool outright. */
export type ToolEffect = "allow" | "ask" | "deny";
export type UrlRule = { pattern: string; effect: "allow" | "deny" };

export type Policies = {
  /** interrupt stops the running task and starts this one, immediate steers the live task, queue waits for it to finish. */
  queuedDelivery: "queue" | "immediate" | "interrupt";
  securityPreset: AccessMode;
  toolRules: Record<string, ToolEffect>;
  networkRules: UrlRule[];
  outsideSandboxCommands: string[];
  planReview: "ask" | "proceed";
  browserJs: "ask" | "proceed";
  browserRules: UrlRule[];
  preventSleep: boolean;
  keepInMenuBar: boolean;
  remoteControl: boolean;
  deviceName: string;
  telemetry: boolean;
  marketingEmails: boolean;
};

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

export const DEFAULT_POLICIES: Policies = {
  queuedDelivery: "interrupt",
  securityPreset: "automatic",
  toolRules: {},
  // Loopback has to stay reachable or the agent can never check its own preview; the
  // link-local metadata address has no legitimate use in a desktop app.
  networkRules: [{ pattern: "127.0.0.1", effect: "allow" }, { pattern: "localhost", effect: "allow" }, { pattern: "169.254.169.254", effect: "deny" }],
  outsideSandboxCommands: [],
  planReview: "proceed",
  browserJs: "proceed",
  browserRules: [],
  preventSleep: false,
  keepInMenuBar: false,
  remoteControl: false,
  deviceName: "",
  telemetry: true,
  marketingEmails: false,
};

function sanitizeRules(value: unknown, fallback: UrlRule[]): UrlRule[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((rule): rule is UrlRule =>
    Boolean(rule) && typeof rule.pattern === "string" && HOSTNAME.test(rule.pattern.trim().toLowerCase()) && ["allow", "deny"].includes(rule.effect))
    .map((rule) => ({ pattern: rule.pattern.trim().toLowerCase(), effect: rule.effect }));
}

function sanitizeCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && /^[a-z][a-z0-9._-]{0,40}$/i.test(item.trim())).map((item) => item.trim().toLowerCase()).slice(0, 100);
}

/** Turns anything (stored JSON, a request body) into a valid Policies object. */
export function sanitizePolicies(value: unknown): Policies {
  const stored = (value && typeof value === "object" ? value : {}) as Record<string, any>;
  return {
    queuedDelivery: ["interrupt", "immediate"].includes(String(stored["queuedDelivery"])) ? stored["queuedDelivery"] as Policies["queuedDelivery"] : "interrupt",
    securityPreset: ["ask", "automatic", "full"].includes(String(stored["securityPreset"])) ? stored["securityPreset"] as AccessMode : DEFAULT_POLICIES.securityPreset,
    toolRules: stored["toolRules"] && typeof stored["toolRules"] === "object"
      ? Object.fromEntries(Object.entries(stored["toolRules"] as Record<string, unknown>).filter((entry): entry is [string, ToolEffect] => ["allow", "ask", "deny"].includes(String(entry[1]))))
      : {},
    networkRules: sanitizeRules(stored["networkRules"], DEFAULT_POLICIES.networkRules),
    outsideSandboxCommands: sanitizeCommands(stored["outsideSandboxCommands"]),
    planReview: stored["planReview"] === "ask" ? "ask" : "proceed",
    browserJs: stored["browserJs"] === "ask" ? "ask" : "proceed",
    browserRules: sanitizeRules(stored["browserRules"], []),
    preventSleep: stored["preventSleep"] === true,
    keepInMenuBar: stored["keepInMenuBar"] === true,
    remoteControl: stored["remoteControl"] === true,
    deviceName: typeof stored["deviceName"] === "string" ? stored["deviceName"].slice(0, 64) : "",
    telemetry: stored["telemetry"] !== false,
    marketingEmails: stored["marketingEmails"] === true,
  };
}

/** `github.com` also covers `api.github.com`; a rule never matches a look-alike suffix. */
export function hostMatches(pattern: string, host: string): boolean {
  const clean = pattern.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const target = host.toLowerCase().replace(/:\d+$/, "");
  return Boolean(clean) && (target === clean || target.endsWith(`.${clean}`));
}

export function matchRule(rules: UrlRule[], host: string): UrlRule | undefined {
  if (!host) return undefined;
  return rules.find((rule) => rule.effect === "deny" && hostMatches(rule.pattern, host))
    || rules.find((rule) => rule.effect === "allow" && hostMatches(rule.pattern, host));
}

export function ruleEffect(rules: UrlRule[], host: string): "allow" | "deny" | undefined {
  return matchRule(rules, host)?.effect;
}

/** Host of anything that looks like a URL, so a bare "example.com" and a full href match the same rule. */
export function urlHost(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`).hostname; } catch { return ""; }
}

export type BlockingRules = Pick<Policies, "toolRules" | "networkRules" | "browserRules">;
/** The message the agent gets when Settings forbids this action, or "" when it is allowed. */
export function blockReason(rules: BlockingRules, type: string, host: string, actuation: boolean): string {
  if (rules.toolRules[type] === "deny") return `${type.replaceAll("_", " ")} is blocked in Settings under Tool Permissions. Choose another approach, or ask the user to unblock it.`;
  if (host && ruleEffect(rules.networkRules, host) === "deny") return `Settings denies ${host} in Network Access Rules. Work without that host or ask the user to allow it.`;
  if (actuation && host && ruleEffect(rules.browserRules, host) === "deny") return `Settings denies acting on ${host} in Browser Actuation Rules. Reading the page is fine; clicking, typing and uploading there are not.`;
  return "";
}
