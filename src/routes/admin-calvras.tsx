import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { siteApiBase } from "@/lib/site-session";

/**
 * The owner's console. It reads only what the site's own ledger holds — who has signed in, which plan
 * each address carries, and what Payments AI reports as sold — and it speaks to /api/site/admin with a
 * bearer token that never leaves this browser. Nothing here is on the desktop app's API and no account
 * record is shipped to a visitor.
 */

const TOKEN_KEY = "calvras_admin_token";
const PLANS = ["free", "pro", "ultra"] as const;

export const Route = createFileRoute("/admin-calvras")({
  head: () => ({
    meta: [
      { title: "Calvras console" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
    ],
    links: [],
  }),
  component: AdminConsole,
});

type Account = {
  email: string; name: string; plan: string; plan_set_by: string; plan_set_at: number;
  first_seen: number; last_seen: number; signins: number; platform: string; version: string;
  city: string; country: string;
};
type LedgerEvent = { id: number; email: string; kind: string; detail: string; at: number };
type Sale = { reference: string; email: string; amount: string | number; currency: string; status: string; plan: string; at: string };
type Summary = {
  accounts: number; paid: number; byPlan: Record<string, number>; newThisWeek: number;
  activeThisWeek: number; lastSeen: number;
};
type Payload = {
  ok: boolean; error?: string; at?: number; summary?: Summary; accounts?: Account[]; events?: LedgerEvent[];
  sales?: { configured: boolean; sales: Sale[]; note?: string; error?: string; total?: number };
};

/** Cloudflare gives us a city when the plan exposes one and a country always; the console shows
 * whichever half it has, and nothing at all before the first sign-in is recorded with a location. */
const place = (account: { city: string; country: string }) => [account.city, account.country].filter(Boolean).join(", ");

const when = (millis: number) => {
  if (!millis) return "—";
  const stamp = millis < 1e12 ? millis * 1000 : millis;
  return new Date(stamp).toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const ago = (millis: number) => {
  if (!millis) return "never";
  const stamp = millis < 1e12 ? millis * 1000 : millis;
  const minutes = Math.round((Date.now() - stamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

export function AdminConsole() {
  // The token is read in an effect, not during the first render: this page is server-rendered too,
  // and storage only exists in the browser, so reading it here would make hydration disagree with
  // the markup the server already sent.
  const [token, setToken] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState("");
  const [history, setHistory] = useState<LedgerEvent[]>([]);
  const [notice, setNotice] = useState("");

  // A browser that already holds the token gets the console without a keystroke; the read happens
  // after the first paint so the server markup and the first client render stay identical.
  useEffect(() => {
    const stored = String(window.localStorage.getItem(TOKEN_KEY) || "");
    if (stored) setToken(stored);
  }, []);

  const load = useCallback(async (showBusy = true) => {
    if (!token) return;
    if (showBusy) setBusy(true);
    setError("");
    try {
      const response = await fetch(`${siteApiBase()}/api/site/admin/summary?q=${encodeURIComponent(query)}`, { headers: { authorization: `Bearer ${token}` } });
      const payload = (await response.json().catch(() => null)) as Payload | null;
      if (!response.ok || !payload?.ok) {
        const reason = payload?.error || `The site answered ${response.status}.`;
        setError(reason);
        setUnlocked(response.status !== 401);
        return;
      }
      setUnlocked(true);
      setData(payload);
      window.localStorage.setItem(TOKEN_KEY, token.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The site could not be reached.");
    } finally {
      setBusy(false);
    }
  }, [query, token]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void load(false);
    // Payments and sign-ins both land while the page is open, so the console keeps itself current.
    const timer = window.setInterval(() => { if (live) void load(false); }, 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [load, token]);

  const act = async (path: string, body: { email: string; plan?: string }) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${siteApiBase()}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) setError(payload?.error || `The site answered ${response.status}.`);
      else setNotice(path.endsWith("remove") ? `Forgot ${body.email}.` : `${body.email} is now on ${body.plan}.`);
      await load(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The site could not be reached.");
    } finally {
      setBusy(false);
    }
  };

  const showHistory = async (email: string) => {
    if (open === email) { setOpen(""); setHistory([]); return; }
    setOpen(email);
    setHistory([]);
    const response = await fetch(`${siteApiBase()}/api/site/admin/history?email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    const payload = (await response?.json().catch(() => null)) as { events?: LedgerEvent[] } | null;
    setHistory(payload?.events || []);
  };

  const accounts = data?.accounts || [];
  const sales = data?.sales?.sales || [];
  const revenue = useMemo(() => sales.reduce((total, sale) => total + (Number(sale.amount) || 0), 0), [sales]);

  const exportCsv = () => {
    const rows = [["email", "name", "plan", "set_by", "signins", "first_seen", "last_seen", "location", "platform", "version"]];
    for (const account of accounts) rows.push([account.email, account.name, account.plan, account.plan_set_by, String(account.signins), new Date(account.first_seen).toISOString(), new Date(account.last_seen).toISOString(), place(account), account.platform, account.version]);
    const csv = `${rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `calvras-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!unlocked) {
    return (
      <div className="admin-shell admin-gate">
        <form
          onSubmit={(event) => { event.preventDefault(); if (token.trim()) void load(); }}
          className="admin-gate-card"
        >
          <span className="admin-eyebrow">CALVRAS · OWNER CONSOLE</span>
          <h1>Sign in as the owner</h1>
          <p>This page lists the accounts that have signed in to Calvras and the plans they carry. It opens only with the owner token set on the site.</p>
          <input className="admin-field" type="password" autoComplete="off" placeholder="Owner token" value={token} onChange={(event) => setToken(event.target.value)} aria-label="Owner token" />
          {error && <p className="admin-error">{error}</p>}
          <button type="submit" className="admin-milk" disabled={busy || !token.trim()}>{busy ? "Checking…" : "Open console"}</button>
          <p className="admin-fineprint">The token is kept in this browser only, and is sent as a bearer header to calvras.com.</p>
        </form>
      </div>
    );
  }

  const summary = data?.summary;
  return (
    <div className="admin-shell">
      <header className="admin-bar">
        <div>
          <span className="admin-eyebrow">CALVRAS · OWNER CONSOLE</span>
          <h1>Accounts</h1>
        </div>
        <div className="admin-bar-actions">
          <label className="admin-search">
            <Search size={13} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email or name" aria-label="Search accounts" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button>}
          </label>
          <button type="button" className="admin-control" onClick={exportCsv} disabled={!accounts.length}>Export CSV</button>
          <button type="button" className="admin-milk" onClick={() => void load()} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
          <button type="button" className="admin-control" onClick={() => { window.localStorage.removeItem(TOKEN_KEY); setToken(""); setUnlocked(false); setData(null); }}>Lock</button>
        </div>
      </header>

      {notice && <p className="admin-notice">{notice}</p>}
      {error && <p className="admin-error">{error}</p>}

      <section className="admin-stats" aria-label="Ledger totals">
        <span><b>{summary ? summary.accounts : "—"}</b><span>Accounts signed in</span></span>
        <span><b>{summary ? summary.paid : "—"}</b><span>On a paid plan</span></span>
        <span><b>{summary ? summary.newThisWeek : "—"}</b><span>New this week</span></span>
        <span><b>{summary ? summary.activeThisWeek : "—"}</b><span>Signed in this week</span></span>
        <span><b>{data?.sales?.configured ? `$${revenue.toFixed(2)}` : "—"}</b><span>Reported by Payments AI</span></span>
      </section>

      <section className="admin-panel" aria-label="Sales">
        <div className="admin-panel-heading"><h2>Sales</h2><span>{data?.sales?.configured ? `${sales.length} transaction${sales.length === 1 ? "" : "s"} read live from Payments AI` : "Store not connected"}</span></div>
        {!data?.sales?.configured ? (
          <p className="admin-empty">{data?.sales?.note || "The site has no Payments AI credential, so sales cannot be read yet. Grants below are made by hand."}</p>
        ) : data?.sales?.error ? (
          <p className="admin-empty">{data.sales.error}</p>
        ) : !sales.length ? (
          <p className="admin-empty">Payments AI returned no transactions for this merchant yet.</p>
        ) : (
          <div className="admin-scroll">
            <table>
              <thead><tr><th scope="col">Reference</th><th scope="col">Buyer</th><th scope="col">Plan</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">When</th></tr></thead>
              <tbody>{sales.slice(0, 40).map((sale) => (
                <tr key={sale.reference || `${sale.email}-${sale.at}`}>
                  <td>{sale.reference || "—"}</td>
                  <td>{sale.email || "—"}</td>
                  <td>{sale.plan || "—"}</td>
                  <td>{sale.amount === "" ? "—" : `${sale.currency || "$"}${sale.amount}`}</td>
                  <td><em className={`admin-status ${sale.status.toLowerCase()}`}>{sale.status || "—"}</em></td>
                  <td>{sale.at ? when(Date.parse(sale.at)) : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-panel" aria-label="Signed-in accounts">
        <div className="admin-panel-heading"><h2>Signed in</h2><span>{accounts.length ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}${query ? ` matching “${query}”` : ""}` : "Nobody yet"}</span></div>
        {!accounts.length ? (
          <p className="admin-empty">No account has signed in through the desktop app yet. The ledger fills the moment someone does.</p>
        ) : (
          <div className="admin-scroll">
            <table>
              <thead><tr><th scope="col">Account</th><th scope="col">Plan</th><th scope="col">Set by</th><th scope="col">Sign-ins</th><th scope="col">Last seen</th><th scope="col">Location</th><th scope="col">Grant</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.email} className={open === account.email ? "admin-row-open" : ""}>
                    <td>
                      <b>{account.name || account.email}</b>
                      <span className="admin-sub">{account.email}</span>
                      <span className="admin-sub">{[account.platform, account.version].filter(Boolean).join(" · ") || "device unknown"} · first seen {when(account.first_seen)}</span>
                    </td>
                    <td><em className={`admin-plan ${account.plan}`}>{account.plan}</em></td>
                    <td>{account.plan_set_by || (account.plan === "free" ? "default" : "—")}</td>
                    <td>{account.signins}</td>
                    <td>{ago(account.last_seen)}</td>
                    <td>{place(account) || "—"}</td>
                    <td>
                      <div className="admin-grants">
                        {PLANS.map((plan) => (
                          <button key={plan} type="button" className={account.plan === plan ? "admin-chip is-current" : "admin-chip"} disabled={busy || account.plan === plan} onClick={() => void act("/api/site/admin/grant", { email: account.email, plan })}>{plan}</button>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button type="button" className="admin-control" onClick={() => void showHistory(account.email)}>{open === account.email ? "Hide" : "History"}</button>
                        <button type="button" className="admin-danger" disabled={busy} onClick={() => { if (window.confirm(`Forget ${account.email} — the record and every event attached to it?`)) void act("/api/site/admin/remove", { email: account.email }); }}>Forget</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open && (
          <div className="admin-history">
            <h3>{open}</h3>
            {!history.length ? <p className="admin-empty">Nothing recorded for this account yet.</p> : (
              <ul>{history.map((event) => <li key={event.id}><b>{event.kind}</b><span>{event.detail || "—"}</span><time>{when(event.at)}</time></li>)}</ul>
            )}
          </div>
        )}
      </section>

      <section className="admin-panel" aria-label="Recent ledger events">
        <div className="admin-panel-heading"><h2>Everything, newest first</h2><span>{(data?.events || []).length} events</span></div>
        {!(data?.events || []).length ? <p className="admin-empty">No events yet.</p> : (
          <ul className="admin-feed">{(data?.events || []).slice(0, 40).map((event) => (
            <li key={event.id}><time>{when(event.at)}</time><b>{event.kind}</b><span>{event.email}</span><em>{event.detail || "—"}</em></li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}
