# Calvras

**What it is.** Calvras is a Windows desktop app you have a conversation with. You talk to it in plain
language and it works as a software engineer inside your own folders: it reads code, edits it, runs
commands, drives a browser, and shows you what it did while it does it. It is made by Calvras Lab; the
product is the app, and calvras.com is the site, the download, and the update feed. There
is no web version of the app — the site never runs the agent.

Current published build: **10.0.5** (`Calvras-Setup-10.0.5.exe`, or `Calvras-10.0.5-win.zip` unpacked).
Sign-in is Google only, by decision.

## How it behaves

- **It decides whether you're talking or working.** A greeting, an opinion or a general question gets a
  short answer in seconds — no tools, no folder scan, and worded differently every time. A message that
  names a tool or asks for something looked up becomes work.
- **It narrates work in plain sentences.** The live step reads like a person describing what they're
  doing, not a spinner. Tool rows collapse by default and open their code on click. Elapsed time shows
  minutes and seconds once a run passes a minute.
- **Sending while it works takes over.** Your new message interrupts the running turn instead of
  queueing behind it.
- **It keeps its own instructions private.** Asked for its system prompt, rules, tool list or model, it
  declines in one line and offers what it can actually give.
- **A long build brief is executed, not discussed.** Give it a multi-section spec ("inspect the repo,
  then implement end to end, verify, report honestly") and it inspects the folder first, keeps the stack
  it found, turns the brief into an ordered phase plan, and ships one working phase at a time. It reports
  the result section by section as implemented, implemented with limits, or not implemented — and a
  feature it cannot deliver for real is labelled as what it actually is rather than faked.
- **Provider trouble stays invisible to you.** Quota, rate limits and dropped streams are retried inside
  the run; you are never shown a provider error banner.

## What it can do

Roughly 70 tools are callable in a turn (`src/lib/tool-catalog.ts` and the runtime switch in
`src/lib/runtime/agent-runtime.ts`), each tagged read / edit / execute / destructive / external / agent.

**Code and files**
- Read, write, patch, search and list files; import a folder as a project (upload, or adopt a folder
  already on disk); create a new project folder only after you agree on where it lives.
- Code intelligence: symbol and semantic search, dependency inventory, explain code, refactor, generate
  tests, generate documentation, detect security issues.
- Edit incrementally rather than rewriting whole files, with a wholesale-rewrite guard.
- Undo is byte-exact. Every write checkpoints the prior bytes and restores them exactly, within snapshot
  caps of 2 MiB per file / 20 MiB total / 2000 entries, and it refuses to snapshot literal secrets.
- Attachments: up to 20 files at 25 MB each; PDF and text are extracted and read directly (up to 100
  pages), images are looked at, and a duplicate-a-design task is judged by pixel comparison against what
  it actually saw.

**Running things**
- `run_command` / `run_code` in the workspace, with a real terminal you can use yourself: a bottom panel
  holding one long-lived shell per folder (up to 4 sessions), its own scrollback, keystrokes, Ctrl-C and
  Ctrl-L — so a prompt for a password or a pager can be answered instead of hanging.
- Start and probe a dev server, then check the preview's health before claiming it works.

**Web**
- A browser panel inside the app the agent drives like a person does — pointing at the open page,
  clicking, typing, screenshotting — plus a headless browser for scraping and multi-step jobs.
- Real `web_search` with cited sources, `github_request`, and `deploy_application`.
- Batch work: a durable queue that dedupes, resumes after a restart, and survives a thousand targets;
  enough for applying to jobs or booking things on your behalf from a list.
- MCP: connect an MCP server in settings and its tools become callable.

**Long work, unsupervised**
- Subagents: builder / verifier / researcher roles, each routed to its own model tier, running in
  isolated git worktrees and merged back three-way, shown as live rows in the right dock.
- Scheduled runs: "every morning", "in an hour", "nightly at 09:30" — stored in `.calvras/schedule.json`
  in the project so it survives the app closing and fires on the next idle poll; list, pause, cancel.
- Task lists, progress tracking, and a persistent project journal so a later turn knows what is verified
  and what is unfinished.
- Module-level repo knowledge: it builds a knowledge map of a large codebase once and reads from it
  instead of re-reading the tree every turn. Context compresses at a 120k-token window; a turn may run
  up to 800 steps.

**Your machine**
- Screen and pointer control on Windows (clicks, typing, key combos) for the apps that have no API.
- Everything is keyed to your signed-in account: chats, projects and history live in that account's
  storage, so switching accounts switches the workspace memory. Clearing Conversations or Projects in
  Settings stays cleared.

**Distribution**
- The app checks `https://calvras.com/update.json`, and when a newer build is published a milky
  **Update** pill appears in the title bar. One click streams the real installer into the app's own
  updates folder, verifies it is a Windows executable it downloaded, and only then asks you to restart.
  It refuses to launch anything it did not write.

## What it deliberately does not do

- **Full access is not blanket access.** That mode frees the terminal, the file edits, and deleting a
  file inside the project — a build that has to ask before cleaning up its own scratch file never
  finishes. What still asks is discarding work you did not name: a rollback, an undo, a `git restore`
  or `git checkout`, applying a worker's branch, and a brand-new project folder.
- **Every approval is yours to answer in four ways.** The card that replaces the composer offers
  **Allow once**, **Always allow**, **Don't allow**, and a field for your own words. Always allow
  writes the same rule the Settings tool switches write, so it holds after a restart and you can take
  it back there. Typing instead of choosing refuses the action and hands what you wrote to the running
  task, which appears in the chat as your message — the agent follows it rather than retrying what
  you just declined.
- It will not open your whole drive, your home directory, or a system root as a project.
- It does not quote or paraphrase its own instructions.

## Not shipped yet (stated honestly)

- **Upgrade does not complete a purchase.** The pricing plans exist in the app but have no store plan id
  wired, so the checkout link is empty and the page says "Not on sale yet" instead of faking a payment.
- **Owner console needs server-side setup.** `/admin-calvras` and the sign-in ledger (email, city and
  country, platform, version, sign-in count) work only where the D1 binding and the admin token are set.
- **Email sign-in is gone on purpose** — Google only; there is no outbox or SMTP path.
- Screen/pointer control is Windows-only today; that's the only platform the app ships on.
