/**
 * The desktop app proves who it is by handing calvras.com the Google token it just received. The
 * site verifies that token and writes the sign-in into its ledger, and answers with the plan the
 * owner has set for that address — which is how a grant made in the admin console reaches the app.
 */

const OVERRIDE_KEY = "calvras_site_base";

/** Point it at a local Worker with localStorage.setItem("calvras_site_base", "http://localhost:8787"). */
export function siteApiBase(): string {
  const override = typeof window === "undefined" ? "" : String(window.localStorage.getItem(OVERRIDE_KEY) || "");
  return (override || "https://calvras.com").replace(/\/+$/, "");
}

export type SignInReport = { ok: boolean; plan?: string; email?: string; session?: string; blocked?: boolean; stale?: boolean; error?: string };
export type SiteAnswer = { ok: boolean; plan?: string; email?: string; blocked?: boolean; stale?: boolean; error?: string };

const post = async (path: string, payload: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${siteApiBase()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  } finally {
    clearTimeout(timer);
  }
};

const answer = (status: number, body: Record<string, unknown>): SignInReport => {
  const plan = typeof body["plan"] === "string" ? body["plan"] : "";
  const email = typeof body["email"] === "string" ? body["email"] : "";
  const session = typeof body["session"] === "string" ? body["session"] : "";
  const error = typeof body["error"] === "string" ? body["error"] : "";
  const ok = status === 200 && body["ok"] === true;
  return {
    ok,
    ...(plan ? { plan } : {}),
    ...(email ? { email } : {}),
    ...(session ? { session } : {}),
    ...(body["blocked"] === true ? { blocked: true } : {}),
    ...(body["stale"] === true ? { stale: true } : {}),
    ...(!ok ? { error: error || `The site answered ${status}.` } : {}),
  };
};

/**
 * Never throws and never blocks a sign-in: an unreachable site means the person still gets into
 * their own app, they just appear in the console once the site is reachable again.
 */
export async function reportSignIn(input: { idToken?: string; platform?: string; version?: string }): Promise<SignInReport> {
  const idToken = String(input.idToken || "");
  if (!idToken) return { ok: false, error: "Google did not hand back an identity token." };
  try {
    const { status, body } = await post("/api/site/session", {
      idToken,
      platform: String(input.platform || "").slice(0, 40),
      version: String(input.version || "").slice(0, 40),
    }, 12_000);
    return answer(status, body);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The site could not be reached." };
  }
}

/**
 * What the site says about this sign-in right now: the plan the owner set, and whether they have
 * switched the account off. A site that cannot be reached is not a block, so an unreachable answer
 * lets the person carry on — the owner's controls work on the next time the app can ask.
 */
export async function checkSession(session: string, input: { platform?: string; version?: string } = {}): Promise<SignInReport> {
  if (!session) return { ok: false, stale: true, error: "This sign-in is older than the account ledger." };
  try {
    const { status, body } = await post("/api/site/pulse", { session, platform: String(input.platform || navigator.platform || "").slice(0, 40), version: String(input.version || "").slice(0, 40) }, 8_000);
    return answer(status, body);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The site could not be reached." };
  }
}

/**
 * One finished turn. Sent with the same session token, because the console's usage figures have to
 * be about a verified account rather than whatever an address somebody typed. Nothing leaves the
 * computer while the Telemetry setting is off — the caller checks that first.
 */
export async function reportTask(session: string, task: { status: string; prompt: string; tools: number; seconds: number; platform?: string; version?: string }): Promise<SiteAnswer> {
  if (!session) return { ok: false, stale: true };
  try {
    const { status, body } = await post("/api/site/usage", {
      session,
      status: task.status,
      prompt: task.prompt.slice(0, 300),
      tools: task.tools,
      seconds: task.seconds,
      platform: String(task.platform || navigator.platform || "").slice(0, 40),
      version: String(task.version || "").slice(0, 40),
    }, 8_000);
    return answer(status, body);
  } catch {
    // A report that cannot be sent is not the user's problem and not their message.
    return { ok: false, error: "The site could not be reached." };
  }
}
