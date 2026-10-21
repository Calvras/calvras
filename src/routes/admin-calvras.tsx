import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { siteApiBase } from "@/lib/site-session";

/**
 * The owner's console. It reads only what the site's own ledger holds — who has signed in, which plan
 * each address carries, what each of them asked the agent to do, and what Payments AI reports as sold —
 * and it speaks to /api/site/admin with a bearer token that never leaves this browser.
 *
 * It is also meant to be left open. A revision call every few seconds is cheap enough to ask often, and
 * the whole ledger is only re-read when that number moves, so a sign-in or a sale that lands while the
 * owner is looking at the page appears on it by itself.
 */

const TOKEN_KEY = "calvras_admin_token";
const PLANS = ["free", "pro", "ultra"] as const;
const REV_POLL_MS = 4_000;

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
  city: string; country: string; places: string; blocked: number; blocked_at: number; blocked_by: string; last_used: number;
};
type LedgerEvent = { id: number; email: string; kind: string; detail: string; at: number };
type Task = { id: number; email: string; status: string; prompt: string; tools: number; seconds: number; plan: string; at: number };
type Sale = { reference: string; email: string; amount: string | number; currency: string; status: string; plan: string; at: string };
type Summary = {
  accounts: number; paid: number; blocked: number; byPlan: Record<string, number>; newThisWeek: number;
  activeThisWeek: number; activeToday: number; lastSeen: number; lastUsed: number;
};
type Board = {
  tasks: number; tasksToday: number; people: number; failures: number; medianTools: number;
  byPlan: Record<string, number>;
  perAccount: { email: string; tasks: number; lastUsed: number; failures: number }[];
  asks: { prompt: string; count: number; lastAt: number }[];
};
type Payload = {
  ok: boolean; error?: string; at?: number; summary?: Summary; board?: Board; accounts?: Account[]; events?: LedgerEvent[];
  sales?: { configured: boolean; sales: Sale[]; note?: string; error?: string; total?: number };
};
type Report = { ok: boolean; error?: string; at?: number; madeBy?: string; model?: string; text?: string; note?: string };
type Turn = { role: "owner" | "analyst"; text: string };

/** Cloudflare gives us a city when the plan exposes one and a country always. The ledger keeps every
 * distinct place an account has signed in from, and the console lists them newest first, so someone who
 * uses Calvras in two cities shows both instead of looking like they moved. A row written before that
 * column existed falls back to its last reported place. */
const places = (account: { city: string; country: string; places?: string }) => {
  const kept = String(account.places ?? "").split(";").map((value) => value.trim()).filter(Boolean).reverse();
  if (kept.length) return kept;
  const last = [account.city, account.country].filter(Boolean).join(", ");
  return last ? [last] : [];
};

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

/** Seconds since a moment, said the way a person reads a live badge. Its own component because it
 * counts every second, and nothing else on the page should redraw for that. */
function Since({ at }: { at: number }) {
  const [, setBeat] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setBeat((previous) => previous + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!at) return <>not yet</>;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return <>{seconds}s ago</>;
  if (seconds < 3_600) return <>{Math.round(seconds / 60)} min ago</>;
  return <>{ago(at)}</>;
}

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
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [notice, setNotice] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const [fresh, setFresh] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [ask, setAsk] = useState("");
  const [askBusy, setAskBusy] = useState(false);

  const revision = useRef("");
  const seen = useRef<string[]>([]);
  const busyRef = useRef(false);

  useEffect(() => {
    const stored = String(window.localStorage.getItem(TOKEN_KEY) || "");
    if (stored) setToken(stored);
  }, []);

  const headers = useMemo(() => ({ authorization: `Bearer ${token}` }), [token]);

  const load = useCallback(async (showBusy = true) => {
    if (!token) return;
    if (showBusy) { busyRef.current = true; setBusy(true); }
    setError("");
    try {
      const response = await fetch(`${siteApiBase()}/api/site/admin/summary?q=${encodeURIComponent(query)}`, { headers });
      const payload = (await response.json().catch(() => null)) as Payload | null;
      if (!response.ok || !payload?.ok) {
        setError(payload?.error || `The site answered ${response.status}.`);
        setUnlocked(response.status !== 401);
        return;
      }
      setUnlocked(true);
      setData(payload);
      setCheckedAt(Date.now());
      // An account the owner has not seen on this page yet is worth a colour, because that is the
      // moment the console is supposed to catch.
      const emails = (payload.accounts || []).map((account) => account.email);
      const arrivals = emails.filter((email) => !seen.current.includes(email));
      if (seen.current.length && arrivals.length) {
        setFresh(arrivals);
        window.setTimeout(() => setFresh([]), 8_000);
      }
      seen.current = emails;
      window.localStorage.setItem(TOKEN_KEY, token.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The site could not be reached.");
    } finally {
      busyRef.current = false;
      if (showBusy) setBusy(false);
    }
  }, [headers, query, token]);

  const readReport = useCallback(async (refresh: boolean) => {
    setReportBusy(true);
    const response = await fetch(`${siteApiBase()}/api/site/admin/report${refresh ? "?refresh=1" : ""}`, { headers }).catch(() => null);
    setReport(((await response?.json().catch(() => null)) as Report | null) || { ok: false, error: "The site could not be reached." });
    setReportBusy(false);
  }, [headers]);

  // One loop for the whole page: read the ledger, then keep asking only whether it moved.
  useEffect(() => {
    if (!token) return;
    let live = true;
    void load(false);
    void readReport(false);
    const timer = window.setInterval(async () => {
      if (!live || busyRef.current) return;
      try {
        const response = await fetch(`${siteApiBase()}/api/site/admin/revision`, { headers });
        const payload = (await response.json().catch(() => null)) as { rev?: string } | null;
        if (!payload?.rev) return;
        setCheckedAt(Date.now());
        if (payload.rev !== revision.current) {
          revision.current = payload.rev;
          await load(false);
        }
      } catch { /* a site that cannot be reached now will be asked again in a moment */ }
    }, REV_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [headers, load, readReport, token]);

  /** An owner action is applied to the row on screen the moment the site accepts it, then the ledger
   * is read again — so the page never sits on a stale answer while the poll catches up. */
  const act = async (path: string, body: { email: string; plan?: string; blocked?: boolean }) => {
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${siteApiBase()}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; account?: Account } | null;
      if (!response.ok || !payload?.ok) { setError(payload?.error || `The site answered ${response.status}.`); return; }
      if (payload.account) setData((previous) => previous ? { ...previous, accounts: (previous.accounts || []).map((row) => row.email === payload.account!.email ? payload.account! : row) } : previous);
      setNotice(path.endsWith("/remove") ? `${body.email} is forgotten — the account, the tasks it reported and every event attached to it are gone from the ledger.`
        : path.endsWith("/block") ? (body.blocked === false ? `${body.email} can use Calvras again.`
          : `${body.email} is blocked: the site now refuses their sign-in, their app opening and their usage reports.`)
        : `${body.email} is now on ${body.plan}.`);
      revision.current = "";
      await load(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The site could not be reached.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const showHistory = async (email: string) => {
    if (open === email) { setOpen(""); setHistory([]); setTasks(null); return; }
    setOpen(email);
    setHistory([]);
    setTasks(null);
    const response = await fetch(`${siteApiBase()}/api/site/admin/history?email=${encodeURIComponent(email)}`, { headers }).catch(() => null);
    const payload = (await response?.json().catch(() => null)) as { events?: LedgerEvent[] } | null;
    setHistory(payload?.events || []);
  };

  const showTasks = async (email: string) => {
    if (open === email && tasks) { setOpen(""); setTasks(null); return; }
    setOpen(email);
    setHistory([]);
    setTasks([]);
    const response = await fetch(`${siteApiBase()}/api/site/admin/usage?email=${encodeURIComponent(email)}`, { headers }).catch(() => null);
    const payload = (await response?.json().catch(() => null)) as { tasks?: Task[] } | null;
    setTasks(payload?.tasks || []);
  };

  const askAnalyst = async () => {
    const question = ask.trim();
    if (!question || askBusy) return;
    setAsk("");
    setAskBusy(true);
    setError("");
    const next: Turn[] = [...turns, { role: "owner", text: question }];
    setTurns(next);
    try {
      const response = await fetch(`${siteApiBase()}/api/site/admin/chat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ question, history: next.slice(0, -1) }) });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; text?: string; error?: string } | null;
      setTurns([...next, { role: "analyst", text: payload?.ok ? String(payload.text || "") : (payload?.error || `The site answered ${response.status}.`) }]);
    } catch {
      setTurns([...next, { role: "analyst", text: "The site could not be reached." }]);
    } finally {
      setAskBusy(false);
    }
  };

  const accounts = data?.accounts || [];
  const board = data?.board;
  const sales = data?.sales?.sales || [];
  const revenue = useMemo(() => sales.reduce((total, sale) => total + (Number(sale.amount) || 0), 0), [sales]);
  /** Which buyer paid for what, matched by the address they paid with — the row the owner reads as
   * "when they pay". Sales are never copied into the ledger, so this join is made on the page. */
  const paidFor = useMemo(() => {
    const byEmail = new Map<string, Sale>();
    for (const sale of sales) if (sale.email) byEmail.set(sale.email.toLowerCase(), sale);
    return byEmail;
  }, [sales]);

  const exportCsv = () => {
    const rows = [["email", "name", "plan", "set_by", "blocked", "signins", "tasks", "failed", "first_seen", "last_seen", "last_used", "location", "platform", "version"]];
    const usage = new Map((board?.perAccount || []).map((row) => [row.email, row]));
    for (const account of accounts) {
      const mine = usage.get(account.email);
      rows.push([account.email, account.name, account.plan, account.plan_set_by, account.blocked ? "blocked" : "", String(account.signins), String(mine?.tasks ?? 0), String(mine?.failures ?? 0), new Date(account.first_seen).toISOString(), new Date(account.last_seen).toISOString(), account.last_used ? new Date(account.last_used).toISOString() : "", places(account).join(" · "), account.platform, account.version]);
    }
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
          <p>This page lists the accounts that have signed in to Calvras, what they have asked the agent to do, the plans they carry and what they paid. It opens only with the owner token set on the site.</p>
          <input className="admin-field" type="password" autoComplete="off" placeholder="Owner token" value={token} onChange={(event) => setToken(event.target.value)} aria-label="Owner token" />
          {error && <p className="admin-error">{error}</p>}
          <button type="submit" className="admin-milk" disabled={busy || !token.trim()}>{busy ? "Checking…" : "Open console"}</button>
          <p className="admin-fineprint">The token is kept in this browser only, and is sent as a bearer header to calvras.com.</p>
        </form>
      </div>
    );
  }

  const summary = data?.summary;
  const live = data ? `${(board?.tasksToday ?? 0) + (summary?.activeToday ?? 0)}` : "—";
  return (
    <div className="admin-shell">
      <header className="admin-bar">
        <div>
          <span className="admin-eyebrow">CALVRAS · OWNER CONSOLE</span>
          <h1>Accounts</h1>
          <p className="admin-live"><i className={error ? "is-off" : ""} aria-hidden="true" />live — checked <Since at={checkedAt} />. New sign-ins, tasks and grants arrive on their own.</p>
        </div>
        <div className="admin-bar-actions">
          <label className="admin-search">
            <Search size={13} aria-hidden="true" />
            <input value={query} onChange={(event) => { setQuery(event.target.value); setOpen(""); setHistory([]); setTasks(null); }} placeholder="Search email or name" aria-label="Search accounts" />
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
        <span><b>{summary ? summary.blocked : "—"}</b><span>Blocked</span></span>
        <span><b>{summary ? summary.activeToday : "—"}</b><span>Used the app today</span></span>
        <span><b>{board ? board.tasksToday : "—"}</b><span>Tasks in 24 hours</span></span>
        <span><b>{board ? `${board.failures}/${board.tasks}` : "—"}</b><span>Turns that did not finish</span></span>
        <span><b>{data?.sales?.configured ? `${sales.length ? "$" : "—"}${sales.length ? revenue.toFixed(2) : live}` : "—"}</b><span>Reported by Payments AI</span></span>
      </section>

      <section className="admin-panel" aria-label="Daily report">
        <div className="admin-panel-heading">
          <h2>Today</h2>
          <span>{report?.madeBy === "ai" ? `written by ${report.model || "the model"}` : report?.at ? "written from the ledger" : ""}{report?.at ? ` · ${ago(report.at)}` : ""}</span>
        </div>
        {report && !report.ok ? (
          <p className="admin-empty">{report.error || "The report could not be read."}</p>
        ) : reportBusy && !report ? (
          <p className="admin-empty">Reading the ledger…</p>
        ) : (
          <div className="admin-report">
            <p>{report?.text || "No report yet."}</p>
            <div className="admin-report-actions">
              <button type="button" className="admin-control" disabled={reportBusy} onClick={() => void readReport(true)}>{reportBusy ? "Reading the ledger…" : "Write it again now"}</button>
              {report?.note && <span className="admin-fineprint">{report.note}</span>}
            </div>
          </div>
        )}
      </section>

      <section className="admin-panel" aria-label="Usage">
        <div className="admin-panel-heading"><h2>What people ask</h2><span>{board ? `${board.tasks} task${board.tasks === 1 ? "" : "s"} recorded, ${board.people} account${board.people === 1 ? "" : "s"}, median ${board.medianTools} actions a task` : "reading…"}</span></div>
        {!board?.tasks ? (
          <p className="admin-empty">No task has been reported yet. The app sends one line per finished turn — what was asked, how many actions it took and how it ended — and only while that person's Telemetry setting is on.</p>
        ) : (
          <div className="admin-asks">
            <ol>
              {board.asks.map((asked) => (
                <li key={asked.prompt}><span className="admin-ask-count">x{asked.count}</span><b>{asked.prompt}</b><time>{ago(asked.lastAt)}</time></li>
              ))}
            </ol>
            <div className="admin-scroll">
              <table className="admin-usage">
                <thead><tr><th scope="col">Account</th><th scope="col">Tasks</th><th scope="col">Not finished</th><th scope="col">Last active</th></tr></thead>
                <tbody>{board.perAccount.map((row) => (
                  <tr key={row.email}>
                    <td data-label="Account">{row.email}</td>
                    <td data-label="Tasks">{row.tasks}</td>
                    <td data-label="Failed">{row.failures ? <em className="admin-status failed">{row.failures}</em> : <span className="admin-status">—</span>}</td>
                    <td data-label="Last active">{ago(row.lastUsed)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
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
              <thead><tr><th scope="col">Reference</th><th scope="col">Buyer</th><th scope="col">Plan</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">When</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{sales.slice(0, 40).map((sale) => (
                <tr key={sale.reference || `${sale.email}-${sale.at}`}>
                  <td data-label="Reference">{sale.reference || "—"}</td>
                  <td data-label="Buyer">{sale.email || "—"}</td>
                  <td data-label="Plan">{sale.plan || "—"}</td>
                  <td data-label="Amount">{sale.amount === "" ? "—" : `${sale.currency || "$"}${sale.amount}`}</td>
                  <td data-label="Status"><em className={`admin-status ${String(sale.status).toLowerCase()}`}>{sale.status || "—"}</em></td>
                  <td data-label="When">{sale.at ? when(Date.parse(sale.at)) : "—"}</td>
                  <td data-label="Action">
                    <div className="admin-row-actions">
                      {sale.email && accounts.some((account) => account.email === sale.email) && /pro|ultra/i.test(sale.plan) && (
                        <button type="button" className="admin-control" disabled={busy} onClick={() => void act("/api/site/admin/grant", { email: sale.email, plan: sale.plan.toLowerCase().includes("ultra") ? "ultra" : "pro" })}>Give {/ultra/i.test(sale.plan) ? "ultra" : "pro"}</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-panel" aria-label="Signed-in accounts">
        <div className="admin-panel-heading"><h2>Signed in</h2><span>{accounts.length ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}${query ? ` matching “${query}”` : ""}` : "Nobody yet"}</span></div>
        {!accounts.length ? (
          <p className="admin-empty">{query ? `No account matches “${query}”.` : "No account has signed in through the desktop app yet. The ledger fills the moment someone does."}</p>
        ) : (
          <div className="admin-scroll">
            <table className="admin-accounts">
              <thead><tr><th scope="col">Account</th><th scope="col">Plan</th><th scope="col">Paid</th><th scope="col">Usage</th><th scope="col">Last active</th><th scope="col">Location</th><th scope="col">Grant</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {accounts.map((account) => {
                  const mine = board?.perAccount.find((row) => row.email === account.email);
                  const sale = paidFor.get(account.email);
                  return (
                    <tr key={account.email} className={`${open === account.email ? "admin-row-open" : ""} ${fresh.includes(account.email) ? "admin-row-new" : ""}`}>
                      <td data-label="Account">
                        <b>{account.name || account.email}</b>
                        <span className="admin-sub">{account.email}</span>
                        <span className="admin-sub">{[account.platform, account.version].filter(Boolean).join(" · ") || "device unknown"} · {account.signins} sign-in{account.signins === 1 ? "" : "s"} · first seen {when(account.first_seen)}</span>
                        {Boolean(account.blocked) && <em className="admin-blocked">blocked {ago(account.blocked_at)}{account.blocked_by ? ` by ${account.blocked_by}` : ""}</em>}
                      </td>
                      <td data-label="Plan"><em className={`admin-plan ${account.plan}`}>{account.plan}</em>{account.plan_set_by && <span className="admin-sub">{account.plan_set_by} · {when(account.plan_set_at)}</span>}</td>
                      <td data-label="Paid">{sale ? <>{`${sale.currency || "$"}${sale.amount}`}<span className="admin-sub">{when(Date.parse(sale.at)) || "date unknown"}</span></> : <span className="admin-status">not paid</span>}</td>
                      <td data-label="Usage">{mine ? <>{mine.tasks} task{mine.tasks === 1 ? "" : "s"}{mine.failures ? <span className="admin-sub">{mine.failures} not finished</span> : null}</> : <span className="admin-status">nothing reported</span>}</td>
                      <td data-label="Last active">{ago(account.last_used || account.last_seen)}</td>
                      <td data-label="Location">{places(account).length ? <div className="admin-places">{places(account).map((place) => <span key={place} className="admin-place">{place}</span>)}</div> : "—"}</td>
                      <td data-label="Grant">
                        <div className="admin-grants">
                          {PLANS.map((plan) => (
                            <button key={plan} type="button" className={account.plan === plan ? "admin-chip is-current" : "admin-chip"} disabled={busy || account.plan === plan} onClick={() => void act("/api/site/admin/grant", { email: account.email, plan })}>{plan}</button>
                          ))}
                        </div>
                      </td>
                      <td data-label="Actions">
                        <div className="admin-row-actions">
                          <button type="button" className="admin-control" onClick={() => void showTasks(account.email)}>{open === account.email && tasks ? "Hide tasks" : "Tasks"}</button>
                          <button type="button" className="admin-control" onClick={() => void showHistory(account.email)}>History</button>
                          {account.blocked ? (
                            <button type="button" className="admin-control" disabled={busy} onClick={() => void act("/api/site/admin/block", { email: account.email, blocked: false })}>Unblock</button>
                          ) : (
                            <button type="button" className="admin-danger" disabled={busy} onClick={() => { if (window.confirm(`Block ${account.email}? The site will refuse their sign-in, and their app stops working the next time it opens.`)) void act("/api/site/admin/block", { email: account.email, blocked: true }); }}>Block</button>
                          )}
                          <button type="button" className="admin-danger" disabled={busy} onClick={() => { if (window.confirm(`Forget ${account.email} — the record, their tasks and every event attached to them?`)) void act("/api/site/admin/remove", { email: account.email }); }}>Forget</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {open && (
          <div className="admin-history">
            <h3>{open}</h3>
            {tasks ? (
              !tasks.length ? <p className="admin-empty">Nothing this account has asked the agent, yet.</p> : (
                <ul className="admin-tasks">{tasks.map((task) => (
                  <li key={task.id}><time>{when(task.at)}</time><em className={`admin-status ${task.status === "finished" ? "succeeded" : "failed"}`}>{task.status}</em><b>{task.prompt || "(no words — an attachment)"}</b><span>{task.tools} actions · {task.seconds}s · {task.plan || "free"}</span></li>
                ))}</ul>
              )
            ) : !history.length ? <p className="admin-empty">Nothing recorded for this account yet.</p> : (
              <ul>{history.map((event) => <li key={event.id}><b>{event.kind}</b><span>{event.detail || "—"}</span><time>{when(event.at)}</time></li>)}</ul>
            )}
          </div>
        )}
      </section>

      <section className="admin-panel" aria-label="Ask the analyst">
        <div className="admin-panel-heading"><h2>Ask about it</h2><span>{turns.length ? `${turns.filter((turn) => turn.role === "owner").length} question${turns.filter((turn) => turn.role === "owner").length === 1 ? "" : "s"} this session` : "the console reads its own ledger"}</span></div>
        {!!turns.length && (
          <ul className="admin-chat">
            {turns.map((turn, index) => (
              <li key={index} className={turn.role}><b>{turn.role === "owner" ? "You" : "Console"}</b><p>{turn.text}</p></li>
            ))}
            {askBusy && <li className="analyst"><b>Console</b><p>Reading the ledger…</p></li>}
          </ul>
        )}
        <form className="admin-ask" onSubmit={(event) => { event.preventDefault(); void askAnalyst(); }}>
          <input className="admin-field" value={ask} onChange={(event) => setAsk(event.target.value)} placeholder="Who used it most this week?" aria-label="Ask the console" disabled={askBusy} />
          <button type="submit" className="admin-milk" disabled={askBusy || !ask.trim()}>{askBusy ? "Thinking…" : "Ask"}</button>
        </form>
        <p className="admin-fineprint">Questions are answered from the account ledger on this site. Nothing you type here leaves the browser except to calvras.com, and the answers come from the same numbers the tables above show.</p>
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
