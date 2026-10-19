import { DOWNLOAD } from "@/lib/download";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Plus } from "lucide-react";

export const DOWNLOAD_URL = DOWNLOAD.installer;

export function CompanyMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`company-menu ${open ? "is-open" : ""}`} onPointerEnter={event => { if (event.pointerType === "mouse") setOpen(true); }} onPointerLeave={event => { if (event.pointerType === "mouse" && !event.currentTarget.contains(document.activeElement)) setOpen(false); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      <button type="button" className="company-menu-toggle" aria-expanded={open} aria-controls="company-links" onClick={() => setOpen(!open)}>Explore Calvras <Plus size={15} /></button>
      <div id="company-links" className="company-menu-panel" inert={!open}>
        <div>
          <Link to="/capabilities">Capabilities <ArrowUpRight size={14} /></Link>
          <Link to="/terms">Terms and Services <ArrowUpRight size={14} /></Link>
          <Link to="/privacy">Privacy Policy <ArrowUpRight size={14} /></Link>
          <Link to="/about">About Calvras <ArrowUpRight size={14} /></Link>
          <Link to="/partner">Partner <ArrowUpRight size={14} /></Link>
          <Link to="/changelog">Changelog <ArrowUpRight size={14} /></Link>
          <Link to="/docs">Documentation <ArrowUpRight size={14} /></Link>
          <Link to="/support">Support <ArrowUpRight size={14} /></Link>
        </div>
      </div>
    </div>
  );
}

export function MarketingHeader() {
  return <header className="landing-nav marketing-nav">
    <Link to="/" className="landing-brand" aria-label="Calvras home"><img src="/calvras-logo.png" alt="" /><span>CALVRAS</span></Link>
    <nav aria-label="Main navigation"><Link to="/">Home</Link><Link to="/pricing">Pricing</Link><a href={DOWNLOAD_URL} className="landing-nav-download">Download <ArrowUpRight size={15} /></a></nav>
  </header>;
}

export function MarketingFooter({ explore = true }: { explore?: boolean }) {
  return <footer className="marketing-footer"><Link to="/" className="footer-wordmark">CALVRAS</Link><span>Built for what’s next.</span>{explore && <CompanyMenu />}</footer>;
}
