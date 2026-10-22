# Calvras

**What it is.** Calvras is a Windows desktop app you have a conversation with. You talk to it in plain
language and it works as a software engineer inside your own folders: it reads code, edits it, runs
commands, drives a browser, and shows you what it did while it does it. It is made by Calvras Lab; the
product is the app, and calvras.com is the site, the download, and the update feed. There
is no web version of the app — the site never runs the agent.

Current published build: **10.0.8** (`Calvras-Setup-10.0.8.exe`, or `Calvras-10.0.8-win.zip` unpacked).
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
- **A big build is executed, not discussed — whatever length you asked for it in.** "Build a movie
  website" is a whole product in six words and is treated like a written spec: it inspects the folder
  first, keeps the stack it found, and writes the phases down in build order as a task plan before
  touching a screen. Then it ships one working phase at a time and reports the result phase by phase as
  implemented, implemented with limits, or not implemented — and a feature it cannot deliver for real is
  labelled as what it actually is rather than faked. It does not send back a list of questions asking you
  to spec out something it is able to decide; you can redirect a plan, you cannot redirect a question.
- **A multi-section spec is answered section by section.** Give it numbered sections, a feature list, or
  "inspect first, implement end to end, verify, report honestly" and each part gets one line of report,
  none of them marked done just because a file with that name exists.
- **Provider trouble stays invisible to you.** Quota, rate limits and dropped streams are retried inside
  the run — up to ten minutes of backoff per call — and a round that runs out of patience ends on the
  agent's own last line. You are never shown a provider error banner, and nothing in the app prints a
  canned failure sentence.
- **A run does not end because a round ended.** Once the agent writes a phase plan, the loop knows how
  many steps are still open and refuses to close the turn while real steps remain; it is told which step
  comes next and has to take it. A dead preview or an unmeasurable screenshot stops being a reason to
  quit — after four checks it becomes a disclosed caveat in the report instead. Hours-long tasks are
  ordinary here; only a finished plan, a genuine blocker, or your stop button ends a run.
- **A short run offers to carry on.** If a turn still ends with steps untouched, the reply lists exactly
  which steps were never reached and shows a *Pick it back up* control that resumes from the first open
  step instead of restarting the task. Only a run that got as far as a tool gets that card — an answer to
  a question has no unfinished work, and offering one there made the app send its own task brief at a list
  of programming languages and print the whole thing a second time.
- **A question about it gets the whole answer.** Asked what it can do, it names every capability as its
  own bullet — none left out because they didn't occur to it — and closes with exactly one specific
  follow-up question, never "what would you like to work on?". Any answer holding two or more items
  renders as a list rather than one comma-separated sentence, and a question about itself is answered as
  conversation, not routed to the file tools.
- **A conversation turn ends when it is answered.** The first reply to a chat message is the answer: the
  loop does not re-ask the model under a *Thinking…* header looking for actions that were never coming.
- **Code and data arrive as code, not bullets.** A program, a command, HTML, a config, a table of records
  or a JSON array comes back in one fenced block with its language named, every line break real, whatever
  the item count — and when the model returns that data un-fenced the bubble fences it anyway, so a stack
  of records never renders as six paragraphs or twenty list items. Bullets stay where they belong: prose
  you are explaining.
- **"Continue" reads the shape it just wrote.** Say *continue*, *go on* or *more* and it carries on in the
  same style — same fence or bullet form, same numbering, same level of detail — starting at the item or
  line the last reply stopped on, instead of restating what it said or switching format mid-answer.
- **It drives a site instead of describing it.** For web work it opens the page, screenshots it, clicks
  the numbered control, types into the focused field, scrolls until the thing it needs appears, and reads
  what the page says after each move. When one route is shut it ranks the alternatives — another entry
  point on the same site, the desktop web app, a listing page, a contact form — takes the best one in the
  same round, and reports which route it used. Dropdowns and consent boxes are filled by name, not
  clicked, because the popup a click opens never appears in its screenshot.
- **A claim needs the page's own words.** Before submitting a form it reads the form back to check every
  field carries what the user said, and a batch item only counts as confirmed when its report carries the
  code the confirmation printed. "Application submitted" is what every site says, so it does not close a
  target — and the fix is to go back to the confirmation and read the real code, never to submit again,
  because a duplicate application is harm the run caused. A done whose receipt was never read stays done
  and is named separately in the final count.
- **A queue decides when it is finished.** Saying "done", or "blocked", while targets are still open does
  not end the run: the ledger releases whatever it was holding, hands over the next chunk, and the work
  carries on — hours of targets are an ordinary run, not a reason to stop. A target dropped three times is
  closed as blocked by the ledger itself, an address no page ever printed is sent back before the run burns
  its budget on a 404, and the final reply gives the counts as they stand — X done, Y blocked, Z skipped
  out of N — instead of a sentence about stopping.
- **Final replies are a report, not a transcript.** What changed, how it works, what was verified, what
  is not done, and what is next — with a numbered brief answered one line per part.

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
  enough for applying to jobs or booking things on your behalf from a list. Closing a target needs the
  confirmation the page printed — a reference no page ever showed goes back on the queue rather than
  counting as done.
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

**What the site learns about an account**
- Signing in with Google writes one row on calvras.com: your email, display name, the city and country
  Cloudflare read off the request, your platform, the app version and a sign-in count. That row is what
  carries your plan, and it is also what lets the owner switch your account off. Sign in from a second
  city and the console lists both, newest first, up to the last four places it has seen you.
- The desktop app makes that report itself, from its own process, and keeps the sign-in for one retry on
  the next launch if the site never answered. Settings → Account says in plain words whether calvras.com
  knows about this sign-in, with a **Send again** button when it does not.
- The app then sends one line per finished turn — the first 300 characters of what you typed, whether
  it finished, how many actions it took and how long it took. Never a file, never a key, never the
  agent's reply. It goes with a session token the site signed at that same Google verification, so a
  report cannot be attributed to somebody else.
- This stops the moment you turn **Telemetry** off in Settings (it is on by default), and it stops on
  its own for a build that predates the session token. Turning it off means the owner's console shows
  your account signing in but nothing about what you asked.
- A blocked account is refused at three points: the sign-in itself, the check the app makes when it
  opens, and every usage report it tries to send. The app then returns to the sign-in screen with the
  owner's reason on it.

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
- **Owner console: sales are not connected.** `/admin-calvras` runs live on calvras.com against the
  account ledger — plans, blocks, per-account usage, the daily report and the chat over the ledger. Its
  Sales panel needs a Payments AI credential on the site, which is not set, so it says "Store not
  connected" rather than showing numbers it does not have.
- **Old sign-ins hold no session token.** An account that signed in before 10.0.7 cannot be blocked or
  report usage until it goes through Google once more.
- **Email sign-in is gone on purpose** — Google only; there is no outbox or SMTP path.
- Screen/pointer control is Windows-only today; that's the only platform the app ships on.
