/**
 * GitHub does not sign a JWT the way Google does, so the proof it hands out is an access token.
 * The site checks that token by asking GitHub who it belongs to, which is the same trust chain
 * Google gives us in one step: the identity comes from the provider rather than from the app.
 */

export type GitHubIdentity = { email: string; subject: string; name: string; picture: string };

const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";
// GitHub refuses requests without an agent, and asks callers to name themselves.
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "Calvras", "x-github-api-version": "2022-11-28" };

type GitHubProfile = { id?: number; login?: string; name?: string | null; avatar_url?: string | null };
type GitHubEmail = { email?: string; primary?: boolean; verified?: boolean };

/**
 * Returns the person a token proves, or throws with the reason. The token must carry the same
 * `user:email` scope the desktop app asks GitHub for — a token minted for some other purpose is
 * not the sign-in this app performed, and only an address GitHub marks verified can key a ledger row.
 */
export async function verifyGitHubIdentity(accessToken: string, options: { fetchImpl?: typeof fetch } = {}): Promise<GitHubIdentity> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = String(accessToken ?? "").trim();
  if (!token) throw new Error("A GitHub sign-in token is required.");
  const headers = { ...HEADERS, authorization: `Bearer ${token}` };

  const profileResponse = await fetchImpl(USER_URL, { headers });
  if (profileResponse.status === 401) throw new Error("GitHub did not accept this sign-in. Sign in again.");
  const profile = (await profileResponse.json().catch(() => ({}))) as GitHubProfile;
  if (!profileResponse.ok || !profile.id) throw new Error(`GitHub could not confirm this sign-in (HTTP ${profileResponse.status}).`);
  const scopes = String(profileResponse.headers.get("x-oauth-scopes") || "");
  if (!scopes.split(",").map((scope) => scope.trim()).includes("user:email")) throw new Error("That GitHub token was not issued for a Calvras sign-in.");

  const emailsResponse = await fetchImpl(EMAILS_URL, { headers });
  const emails = (await emailsResponse.json().catch(() => [])) as GitHubEmail[];
  if (!emailsResponse.ok || !Array.isArray(emails)) throw new Error("GitHub did not list the email addresses on this account.");
  const usable = emails.filter((entry) => entry.verified === true && typeof entry.email === "string" && entry.email.trim());
  const chosen = usable.find((entry) => entry.primary === true) || usable[0];
  const email = String(chosen?.email || "").trim().toLowerCase();
  if (!email) throw new Error("This GitHub account has no verified email address, so it cannot be identified.");

  return {
    email,
    // Prefixed so the ledger can tell a GitHub subject from a Google one for the same address.
    subject: `github:${profile.id}`,
    name: String(profile.name || profile.login || email.split("@")[0]),
    picture: String(profile.avatar_url || ""),
  };
}
