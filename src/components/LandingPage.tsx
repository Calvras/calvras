import { DownloadDetails, useLatestRelease } from "@/components/DownloadDetails";
import { DOWNLOAD } from "@/lib/download";
import { ArrowUpRight, Check, Download, FileCheck2, FolderCode, TerminalSquare } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { MarketingHeader, MarketingFooter } from "@/components/MarketingLayout";

const workflow = [
  { number: "01", title: "Describe the work", copy: "Tell Calvras what you want to build or change." },
  { number: "02", title: "Build in your project", copy: "Calvras works with your files and runs commands on your computer." },
  { number: "03", title: "Review the result", copy: "See what changed and check the work before you ship it." },
];

export function LandingPage() {
  const latestRelease = useLatestRelease();

  return (
    <div className="calvras-landing">
      <section className="landing-hero">
        <MarketingHeader />
        <div className="landing-hero-grid">
          <div className="landing-hero-content">
            <span className="landing-eyebrow">A DESKTOP CODING AGENT</span>
            <h1>From idea<br /><span>to working code.</span></h1>
            <p className="landing-lede">Give Calvras a task. It works in your project, runs the commands, and leaves you with changes you can review.</p>
            <div className="landing-hero-actions">
              <a href={latestRelease.installer} className="landing-download"><Download size={16} />Download for Windows<ArrowUpRight size={15} /></a>
              <Link to="/capabilities" className="landing-text-link">Explore Calvras<ArrowUpRight size={15} /></Link>
            </div>
            <DownloadDetails />
          </div>

          <div className="landing-product-preview" aria-label="Calvras project workflow preview">
            <div className="preview-window-bar"><span className="preview-mark">C</span><span>Calvras <i>/</i> account-dashboard</span><span className="preview-live"><b /> READY</span></div>
            <div className="preview-workspace">
              <div className="preview-sidebar"><span className="preview-sidebar-label">PROJECT</span><span className="preview-project"><FolderCode size={14} /> account-dashboard</span><span className="preview-sidebar-label preview-sidebar-label-spaced">WORKSPACE</span><span className="preview-nav-item is-active">Overview</span><span className="preview-nav-item">Files</span><span className="preview-nav-item">Terminal</span></div>
              <div className="preview-main"><span className="preview-main-label">CURRENT TASK</span><h2>Improve account settings</h2><p>Update the profile form and verify the save flow.</p>
                <div className="preview-change"><FileCheck2 size={15} /><span><b>Profile form</b><small>Updated validation and layout</small></span><span className="preview-done"><Check size={13} /> Done</span></div>
                <div className="preview-terminal"><span><TerminalSquare size={13} /> CHECKS</span><b><Check size={13} /> Build completed successfully</b></div>
              </div>
            </div>
            <div className="preview-footer"><span>Changes stay in your project</span><span>Review before you ship <ArrowUpRight size={12} /></span></div>
          </div>
        </div>
        <div className="landing-capability-strip" aria-label="Calvras workflow">
          <span><Check size={14} />Your files stay on your computer</span>
          <span><Check size={14} />Commands run in your project</span>
          <span><Check size={14} />Review every change</span>
        </div>
      </section>

      <section className="home-journey" aria-labelledby="journey-title">
        <div className="home-journey-heading">
          <span className="landing-eyebrow">A STRAIGHTFORWARD WORKFLOW</span>
          <h2 id="journey-title">You stay in control<br /><span>at every step.</span></h2>
          <p>Move from a clear request to changes you can inspect.</p>
        </div>
        <div className="home-step-cards">
          {workflow.map((step) => (
            <article key={step.number}>
              <span>{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-bottom-cta">
        <div>
          <span className="landing-eyebrow">CALVRAS FOR WINDOWS</span>
          <h2>Start with your next idea.</h2>
          <p>{DOWNLOAD.platform} · x64 / 64-bit · version {latestRelease.version}</p>
        </div>
        <a href={latestRelease.installer} className="landing-download"><Download size={16} />Download Calvras<ArrowUpRight size={15} /></a>
      </section>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Calvras", url: "https://calvras.com/", applicationCategory: "DeveloperApplication", operatingSystem: "Windows 10, Windows 11 (x64)", softwareVersion: DOWNLOAD.version, downloadUrl: latestRelease.installer, image: "https://calvras.com/social-preview.png", description: "A Windows desktop coding agent that works with project files and local commands." }) }} />
      <MarketingFooter />
    </div>
  );
}
