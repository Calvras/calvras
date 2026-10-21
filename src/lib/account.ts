/** The account signed into this copy of Calvras, read from the session the splash screen set. */
export const USER_KEY = "calvras_user";

export type CalvrasUser = { provider: "google"; email?: string; name?: string; picture?: string; plan?: string; joinedAt: number; /** The token calvras.com signed when it verified this Google account. The
 * app comes back with it on boot and after each task, which is how a plan the owner granted — or a
 * block they applied — reaches this computer. */ session?: string; /** Set by the site, not by anything on this machine: the owner switched this account off. */ blocked?: string };

/** Only a real Google account counts as signed in. Anything older, blanked or hand-written in
 * storage sends the person to sign-in rather than into an app with no owner behind it. */
export function storedUser(): CalvrasUser | null {
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CalvrasUser> | null;
    return value?.provider === "google" && typeof value.email === "string" && value.email ? value as CalvrasUser : null;
  } catch { return null; }
}

export function writeStoredUser(user: CalvrasUser | null) {
  try {
    if (user) window.localStorage.setItem(USER_KEY, JSON.stringify(user));
    else window.localStorage.removeItem(USER_KEY);
  } catch { /* storage unavailable */ }
}

/** Whose shelf this computer's data is on. Everything below the sign-in screen belongs to one
 * Google account, so a second person signing in on the same machine never sees the first one's
 * folders, chats or notes. */
export function accountScope(): string {
  const email = storedUser()?.email;
  return email ? email.toLowerCase() : "signed-out";
}

const PREFIX = "calvras/account";
/** Device-level preferences (permission mode, appearance, dock width) stay flat: they describe
 * the machine, not the person. Everything listed here is the account's own work. */
const LEGACY: Record<string, string> = {
  projects: "calvras_projects",
  recents: "calvras_recents",
  activeProject: "calvras_active_project",
  chats: "calvras_chat_messages",
  sessionMemory: "calvras_session_memory",
  feedback: "calvras_feedback",
};

/** `calvras/account/<email>/<name>`, with the old flat key carried over the first time. */
export function scopedKey(name: string): string {
  return `${PREFIX}/${accountScope()}/${name}`;
}

function claim(name: string): string {
  const key = scopedKey(name);
  if (window.localStorage.getItem(key) !== null) return key;
  const legacy = LEGACY[name];
  if (legacy && legacy !== "calvras_chat_messages" && window.localStorage.getItem(legacy) !== null) {
    // One account can inherit what the machine already holds; after the move the flat key is
    // gone, so the next person to sign in starts with a shelf of their own.
    window.localStorage.setItem(key, window.localStorage.getItem(legacy)!);
    window.localStorage.removeItem(legacy);
  }
  return key;
}

export function readScoped<T>(name: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(claim(name));
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch { return fallback; }
}

export function writeScoped(name: string, value: unknown) {
  try { window.localStorage.setItem(claim(name), JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function clearScoped(name: string) {
  try {
    window.localStorage.removeItem(scopedKey(name));
    const legacy = LEGACY[name];
    if (legacy) window.localStorage.removeItem(legacy);
  } catch { /* storage unavailable */ }
}

/** Settings can wipe this account's lists; the provider listens for this and re-reads storage
 * so the sidebar and the open conversation agree with what was just cleared. */
export function accountDataChanged() {
  try { window.dispatchEvent(new Event("calvras:account-data")); } catch { /* storage unavailable */ }
}

/** Conversation transcripts live in one map per account, so a chat the user leaves stays
 * reachable from History while a new one starts beside it. */
export type StoredChat = { id: string; label: string; projectPath?: string; projectName?: string; savedAt: number; messages: unknown[]; memory?: { summary: string; covered: number } };

export function readChats(): Record<string, StoredChat> {
  const stored = readScoped<unknown>("chats", {});
  const chats = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, StoredChat> : {};
  const carried = legacyTranscript();
  if (carried.length) {
    // One flat transcript from before conversations were separate becomes this account's most
    // recent chat, so the upgrade does not silently throw work away.
    const last = readScoped<unknown[]>("recents", [])[0] as { id?: string; label?: string; projectPath?: string; projectName?: string } | undefined;
    const id = last?.id || `chat-${Date.now()}`;
    if (!chats[id]) {
      chats[id] = {
        id,
        label: last?.label || "Earlier conversation",
        ...(last?.projectPath ? { projectPath: last.projectPath } : {}),
        ...(last?.projectName ? { projectName: last.projectName } : {}),
        savedAt: Date.now(),
        messages: carried,
      };
    }
    writeChats(chats);
  }
  return chats;
}

export function writeChats(chats: Record<string, StoredChat>) { writeScoped("chats", chats); }

/** A conversation's running summary lives beside the conversation, not beside the account, so
 * opening an old chat brings back what the agent already knew about it. */
export function memoryKeyFor(chatId: string | null): string {
  return `${scopedKey("sessionMemory")}/${chatId || "new"}`;
}

export function readMemoryAt(key: string): unknown {
  try { return JSON.parse(window.localStorage.getItem(key) || "null"); } catch { return null; }
}

export function writeMemoryAt(key: string, value: unknown) {
  try {
    const memory = value as { summary?: string } | null;
    if (memory && typeof memory.summary === "string" && memory.summary.trim()) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
}

/** The one transcript this machine saved before conversations were separate. It becomes the
 * first chat of the account that opens the app, so nobody loses their work on the upgrade. */
function legacyTranscript(): unknown[] {
  try {
    const raw = window.localStorage.getItem("calvras_chat_messages");
    if (!raw) return [];
    window.localStorage.removeItem("calvras_chat_messages");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
