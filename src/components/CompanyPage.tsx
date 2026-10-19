import { termsSections, privacySections } from "@/lib/legal-content";
import { DOWNLOAD } from "@/lib/download";
import { DownloadDetails } from "@/components/DownloadDetails";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, Copy, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MarketingHeader, MarketingFooter, DOWNLOAD_URL } from "@/components/MarketingLayout";

const INQUIRY_TO = "calvrasnoreply@gmail.com";
const INQUIRY_OPTIONS = [
  { id: "tools", label: "Tools and integrations", hint: "A connection between Calvras and a tool your developers already use." },
  { id: "education", label: "Education and communities", hint: "Workshops, learning programs, or a developer community." },
  { id: "research", label: "Product and research collaboration", hint: "Agent workflows, project context, developer experience." },
  { id: "other", label: "Something else", hint: "An idea that does not fit any of the boxes above." },
];

/** The partner page has no mail server of its own, so the form composes a real message and hands
 * it to the visitor's mail client — and keeps the same text on the clipboard as a fallback. */
export function InquirySheet({ onClose }: { onClose: () => void }) {
  const [area, setArea] = useState(INQUIRY_OPTIONS[0]!.id);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [org, setOrg] = useState("");
  const [details, setDetails] = useState("");
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = previous; };
  }, [onClose]);

  const chosen = INQUIRY_OPTIONS.find((option) => option.id === area) ?? INQUIRY_OPTIONS[0]!;
  const errors = useMemo(() => ({
    name: name.trim() ? "" : "Tell us who is writing.",
    email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) ? "" : "Add an address we can reply to.",
    details: details.trim().length >= 20 ? "" : "Give us a little more to read — 20 characters or more.",
  }), [name, email, details]);
  const valid = !errors.name && !errors.email && !errors.details;

  const message = useMemo(() => [
    `Area: ${chosen.label}`,
    `Name: ${name.trim()}`,
    org.trim() ? `Organization: ${org.trim()}` : "",
    `Reply to: ${email.trim()}`,
    "",
    details.trim(),
    "",
    `Sent from the Calvras partner page on ${new Date().toLocaleDateString()}.`,
  ].filter(Boolean).join("\n"), [chosen.label, name, org, email, details]);

  const mailto = `mailto:${INQUIRY_TO}?subject=${encodeURIComponent(`Calvras partnership — ${chosen.label}`)}&body=${encodeURIComponent(message)}`;

  const copy = async () => {
    try { await navigator.clipboard.writeText(`${chosen.label}\n\n${message}`); setNote("Copied. Paste it into a message to " + INQUIRY_TO + "."); }
    catch { setNote("Your browser blocked the clipboard. Select the text below and copy it by hand."); }
  };

  return (
    <div className="inquiry-root">
      <div className="inquiry-scrim" onClick={onClose} aria-hidden="true" />
      <div className="inquiry-sheet" role="dialog" aria-modal="true" aria-labelledby="inquiry-title">
        <header className="inquiry-head">
          <div>
            <span className="landing-eyebrow">START A CONVERSATION</span>
            <h2 id="inquiry-title">Tell us what you want to build together.</h2>
            <p>Pick the closest option, add your information, and the message goes to {INQUIRY_TO}. Please leave out confidential files and credentials.</p>
          </div>
          <button type="button" className="inquiry-close" onClick={onClose} aria-label="Close the form"><X size={16} /></button>
        </header>
        <fieldset className="inquiry-options">
          <legend>What kind of collaboration?</legend>
          {INQUIRY_OPTIONS.map((option) => (
            <label key={option.id} className={`inquiry-option${area === option.id ? " is-picked" : ""}`}>
              <input type="radio" name="inquiry-area" value={option.id} checked={area === option.id} onChange={() => setArea(option.id)} />
              <span><strong>{option.label}</strong><em>{option.hint}</em></span>
            </label>
          ))}
        </fieldset>
        <div className="inquiry-fields">
          <label>Name<input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" placeholder="Who you are" aria-invalid={checked && Boolean(errors.name)} /></label>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="you@company.com" aria-invalid={checked && Boolean(errors.email)} /></label>
          <label>Organization<input value={org} onChange={(event) => setOrg(event.target.value)} autoComplete="organization" placeholder="Optional" /></label>
        </div>
        <label className="inquiry-details">Your information<textarea value={details} onChange={(event) => setDetails(event.target.value)} rows={5} placeholder="The product or community you work on, the workflow you want to improve, and the outcome you have in mind." aria-invalid={checked && Boolean(errors.details)} /></label>
        {checked && !valid && <p className="inquiry-error" role="alert">{errors.name || errors.email || errors.details}</p>}
        <footer className="inquiry-foot">
          <a
            className="inquiry-send"
            href={mailto}
            onClick={(event) => {
              setChecked(true);
              if (!valid) { event.preventDefault(); setNote(""); return; }
              void navigator.clipboard?.writeText(`${chosen.label}\n\n${message}`).catch(() => undefined);
              setNote(`Your mail app has the message ready for ${INQUIRY_TO}. If nothing opened, the same text is on your clipboard.`);
            }}
          ><Check size={15} /> Send inquiry</a>
          <button type="button" className="inquiry-copy" onClick={() => void copy()}><Copy size={14} /> Copy instead</button>
          {note && <p role="status">{note}</p>}
        </footer>
      </div>
    </div>
  );
}

type PageKind = "terms" | "privacy" | "about" | "partner" | "changelog" | "docs" | "support";
const content = {
  terms: { eyebrow: "THE GROUND RULES", title: "Terms and Services", intro: "Clear terms for using Calvras, local project tools, and connected AI services.", sections: termsSections },
  privacy: { eyebrow: "KNOW WHAT YOU SHARE", title: "Privacy Policy", intro: "How Calvras handles project context, local storage, and external AI requests.", sections: privacySections },  changelog: {
    eyebrow: "A RECORD OF WHAT’S NEW", title: "Small changes. Forward motion.", intro: "Updates to the Calvras website and product experience. Website updates are separate from desktop installer releases.",
    sections: [
      ["01", "19 October 2026 · Desktop only", "Calvras no longer offers a browser workspace. The /app address is gone, the public home page is the product page, and the coding workspace lives only inside the Windows app. Its terminal now opens in the right-hand dock beside your files, and every conversation is kept per account, so History reopens the chat you clicked, not just its folder."],
      ["02", "18 October 2026 · An upgrade path", "Settings has a Usage page showing what the agent actually did on this computer, with an Upgrade plan button that opens the pricing page. Paid plans are sold by Payments AI as merchant of record: the store credential stays in Calvras’ own folder on your computer, and card details are entered on the Payments AI page, never inside Calvras."],
      ["03", "14 October 2026 · A new home", "The Calvras landing experience now lives at calvras.com. The former /landing address redirects to the home page. A scroll-drawn line and staggered cards add subtle motion to the charcoal-and-silver design."],
      ["04", "14 October 2026 · Clearer plans", "The pricing page has been rebuilt with monthly and yearly billing views, side-by-side feature comparisons, and answers to common billing questions. Existing plan prices are preserved. Paid checkout is not connected, so exploring a plan does not charge you."],
      ["05", "14 October 2026 · More to explore", "Explore Calvras now connects to Terms and Services, Privacy Policy, About, Partner, Changelog, Documentation, and Support. The menu opens on hover, by click, and by keyboard. The legal pages describe the current service and the limits of external-provider information."],
      ["06", "Desktop releases", `The website download links to the v${DOWNLOAD.version} Windows installer, the same version reported by the application's General settings. Check the version shown by your installed application when reporting a desktop issue.`],
    ],
  },
  docs: {
    eyebrow: "A LITTLE DIRECTION", title: "Your first project starts here.", intro: "A practical guide to installing Calvras, giving it direction, and reviewing its work.",
    sections: [
      ["01", "Download and open", "Use the Download button to get the Windows installer and follow its installation prompts. Open Calvras after installation. The public website explains the product; the coding workspace itself only runs inside the Calvras app. AI features use external services and need network access."],
      ["02", "Choose a project", "Open the folder you want to work in. Use a dedicated project folder rather than your entire home directory. Keep a backup or use version control before asking the agent to modify an existing codebase. Project access and command execution depend on the runtime you are using."],
      ["03", "Write a useful task", "Describe the result, the relevant files, and the constraints. For example: ‘Build a responsive pricing page with three plans. Keep the existing prices, use the current logo, and make the billing switch work by keyboard.’ Small, specific tasks are easier to inspect and verify."],
      ["04", "Set the pace", "Calvras offers Ask first, Work automatically, and Full access permission modes. Read the labels and choose the level of control appropriate to your project. Full access stops confirmation prompts for commands and edits, but the agent still asks you about decisions only you can make, such as an API key or a visual direction. Giving an agent broad permission does not replace backups, careful review, or security checks."],
      ["05", "Review and verify", "Read the implementation plan and inspect the changed files. Run the project’s relevant build or tests, check command output, and verify the result in the browser or app. If something is wrong, describe the observed behavior and ask for a focused correction."],
      ["06", "Model access and sensitive data", "Model availability depends on configured providers and valid credentials. Never paste private keys, passwords, or production secrets into a task. AI requests may contain prompts and selected project context; review the Privacy Policy to understand how external providers are involved."],
      ["07", "When something fails", "Check the error message, network connection, selected model, and project path. For a provider authentication error, review credentials in the provider’s settings and rotate any exposed key. If you need help, include the app version and steps to reproduce, with sensitive content removed."],
    ],
  },
  support: {
    eyebrow: "GET BACK TO BUILDING", title: "A clear path to help.", intro: "Report an issue, ask a question, or share feedback with the Calvras project.",
    sections: [
      ["01", "Before you write", "Check your network connection, model availability, and the folder selected for the task. Capture the exact error message and note whether it occurred on the website, in the web workspace, or in the desktop application. Do not include credentials or confidential project files."],
      ["02", "Report a reproducible issue", "Email calvrasnoreply@gmail.com with a short subject and the steps needed to reproduce the problem. Include the app version, operating system, expected result, actual result, and a redacted screenshot or log excerpt. A focused report makes it easier to understand what happened."],
      ["03", "Plan and billing questions", "Starter, Pro, and Ultra are described on the pricing page. Paid plans are sold by Payments AI as merchant of record, so the payment record, receipt and refund route all run through them. If you believe you were charged, check that merchant name on the statement before sharing any details, and never send full card numbers or payment credentials."],
      ["04", "Privacy and security", "Use the same contact address for privacy questions or a potential security issue, with ‘Privacy’ or ‘Security’ in the subject. Describe the concern without including live secrets or sensitive data. Do not publish exploit details or someone else’s private information in an initial report."],
      ["05", "Feedback and collaboration", "Tell us which workflow you are trying to improve and why the current experience gets in the way. For a proposed integration, workshop, or collaboration, visit the Partner page. No response time or service-level commitment is implied by this support page."],
    ],
  },
  about: {
    eyebrow: "BUILT FOR WHAT’S NEXT", title: "An idea deserves momentum.", intro: "Calvras brings an AI coding agent into the place where your work happens: your desktop.",
    sections: [
      ["01", "From conversation to creation", "Describe what you want to build in plain language. Calvras works with project context, proposes changes, edits files, and runs commands so a conversation can become a working project."],
      ["02", "A desktop-first foundation", "The native desktop application is built with Electron and TypeScript, and runs its tool runtime as a local service on your own machine. Filesystem access and command execution connect the agent to your local environment, while external AI providers supply model responses."],
      ["03", "Keep the work visible", "A useful agent should make its work understandable. Review plans, inspect changes, and verify output before shipping. Your judgment remains part of the process, especially for production code and sensitive tasks."],
      ["04", "Room for the next idea", "Start with the free Starter plan. Pro and Ultra are sold through Payments AI as merchant of record, and the pricing page shows the plans that store actually has on sale, with the tier benefits arriving in the release that enables them."],
    ],
  },
  partner: {
    eyebrow: "BUILD SOMETHING TOGETHER", title: "Good ideas go further together.", intro: "Explore ways to bring Calvras into your tools, workflows, and developer community.",
    sections: [
      ["01", "Tools and integrations", "Build connections that help developers work across their existing tools. Share the product you work on, the workflow you want to improve, and the integration you have in mind."],
      ["02", "Education and communities", "Bring practical AI-assisted development into workshops, learning programs, and developer communities. Tell us who you support and what you would like to build together."],
      ["03", "Product and research collaboration", "Explore agent workflows, project context, and developer experience with the Calvras project. Describe your area of expertise, the problem you want to investigate, and the outcome you hope to achieve."],
      ["04", "Start a conversation", "Use the form below to send a short introduction, your organization or project, and your proposed collaboration. It reaches the Calvras partnership inbox with everything in one message, so there is nothing to rewrite. Avoid including confidential project files or credentials in your first message. Partnership terms are agreed separately; an inquiry creates no commitment."],
    ],
  },
};
export function CompanyPage({ kind }: { kind: PageKind }) {
  const [inquiryOpen, setInquiryOpen] = useState(false);
  const page = content[kind];
  const legal = kind === "terms" || kind === "privacy";
  return <div className="calvras-landing company-page"><MarketingHeader /><main className="company-main"><div className="company-intro"><span className="landing-eyebrow">{page.eyebrow}</span><h1>{page.title}</h1><p>{page.intro}</p>{legal && <div className="company-draft">Updated · 14 October 2026</div>}</div><div className="company-body"><aside><span className="landing-eyebrow">ON THIS PAGE</span>{page.sections.map(([number, title]) => <a key={number} href={`#section-${number}`}>{title}</a>)}</aside><div>{page.sections.map(([number, title, body]) => <section id={`section-${number}`} key={number}><span>{number}</span><div><h2>{title}</h2><p>{body}</p></div></section>)}{kind === "partner" && <button type="button" className="landing-download inquiry-trigger" onClick={() => setInquiryOpen(true)}>Let’s talk <ArrowUpRight size={16} /></button>}{kind === "docs" && <DownloadDetails />}{(kind === "about" || kind === "docs") && <a className="landing-download" href={DOWNLOAD_URL}>Download Calvras <ArrowUpRight size={16} /></a>}{kind === "support" && <a className="landing-download" href="mailto:calvrasnoreply@gmail.com?subject=Calvras%20support">Contact support <ArrowUpRight size={16} /></a>}{kind === "privacy" && <p className="company-source-note">Privacy disclosures should reflect actual practices. <a href="https://www.ftc.gov/business-guidance/privacy-security" target="_blank" rel="noopener noreferrer">Read the FTC’s privacy guidance.</a></p>}</div></div><Link to="/pricing" className="landing-text-link">Explore the plans <ArrowUpRight size={16} /></Link></main><MarketingFooter />{kind === "partner" && inquiryOpen && createPortal(<InquirySheet onClose={() => setInquiryOpen(false)} />, document.body)}</div>;
}
