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

export type SignInReport = { ok: boolean; plan?: string; email?: string; error?: string };

/**
 * Never throws and never blocks a sign-in: an unreachable site means the person still gets into
 * their own app, they just appear in the console once the site is reachable again.
 */
export async function reportSignIn(input: { idToken?: string; platform?: string; version?: string }): Promise<SignInReport> {
  const idToken = String(input.idToken || "");
  if (!idToken) return { ok: false, error: "Google did not hand back an identity token." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${siteApiBase()}/api/site/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken, platform: String(input.platform || "").slice(0, 40), version: String(input.version || "").slice(0, 40) }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; plan?: string; email?: string; error?: string } | null;
    if (!response.ok || !payload?.ok) return { ok: false, error: payload?.error || `The site answered ${response.status}.` };
    return { ok: true, ...(payload.plan ? { plan: payload.plan } : {}), ...(payload.email ? { email: payload.email } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The site could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}
