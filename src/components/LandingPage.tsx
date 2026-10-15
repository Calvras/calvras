import { DownloadDetails } from "@/components/DownloadDetails";
import { DOWNLOAD } from "@/lib/download";
import { useRef } from "react";
import { motion, useReducedMotion, useScroll } from "framer-motion";
import { ArrowUpRight, Download } from "lucide-react";
import { MarketingHeader, MarketingFooter } from "@/components/MarketingLayout";


const DOWNLOAD_URL = DOWNLOAD.installer;

export function LandingPage() {
  const reducedMotion = useReducedMotion();
  const journeyRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: journeyRef, offset: ["start 85%", "end 35%"] });
  const reveal = {
    initial: { opacity: 0, y: reducedMotion ? 0 : 20 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true },
    transition: { duration: reducedMotion ? 0 : 0.8 },
  };

  return (
    <div className="calvras-landing">
      <section className="landing-hero">
        <div className="landing-grain" aria-hidden="true" />
        <img className="landing-watermark" src="/calvras-logo.png" alt="" aria-hidden="true" />
        <MarketingHeader />

        <div className="landing-hero-content">
          <motion.div {...reveal} className="landing-eyebrow">BUILT FOR WHAT’S NEXT</motion.div>
          <motion.h1 {...reveal} transition={{ duration: reducedMotion ? 0 : 0.9, delay: reducedMotion ? 0 : 0.12 }}>
            Build Real Projects<br /><span>With AI Autonomy</span>
          </motion.h1>
          <motion.div {...reveal} transition={{ duration: reducedMotion ? 0 : 0.9, delay: reducedMotion ? 0 : 0.25 }}>
            <a href={DOWNLOAD_URL} className="landing-download"><Download size={17} /> Download for Windows <ArrowUpRight size={17} /></a>
          </motion.div>
          <DownloadDetails />
        </div>
        <div className="landing-hero-bottom" aria-hidden="true"><span>CALVRAS / DESKTOP</span><span className="landing-scroll-line" /></div>
      </section>

      <section className="landing-pitch">
        <motion.div {...reveal} className="landing-pitch-copy">
          <span className="landing-eyebrow">FROM IDEA TO EXECUTION</span>
          <h2>Describe the task.<br /><span>Ship the code.</span></h2>
          <p>Turn a plain-language task into production-ready code across multiple files. Calvras reads, writes, runs commands, and self-corrects — autonomously directly on your computer.</p>
          <a href={DOWNLOAD_URL} className="landing-text-link">Download Calvras Desktop <ArrowUpRight size={17} /></a>
        </motion.div>
        <motion.div {...reveal} className="landing-brand-card">
          <div className="landing-grain" aria-hidden="true" />
          <img className="landing-card-watermark" src="/calvras-logo.png" alt="" aria-hidden="true" />
          <div className="landing-card-wordmark">CALVRAS</div>
          <div className="landing-card-tagline">BUILT FOR WHAT’S NEXT</div>
          <span className="landing-card-rule" />
          <div className="landing-card-caption">Your next idea.<br />Already in motion.</div>
        </motion.div>
      </section>
      <section className="home-journey" ref={journeyRef} aria-labelledby="journey-title">
        <motion.div {...reveal} className="home-journey-heading">
          <span className="landing-eyebrow">ONE IDEA. A CLEAR PATH FORWARD.</span>
          <h2 id="journey-title">Watch the pieces<br /><span>come together.</span></h2>
          <p>From a first thought to the final check, keep your work in view.</p>
        </motion.div>
        <div className="home-journey-track" aria-hidden="true"><motion.div style={{ scaleY: reducedMotion ? 1 : scrollYProgress }} /></div>
        <div className="home-step-cards">
          {[
            { number: "01", title: "Give it direction.", text: "Start with a task, a constraint, or a rough idea. Make the goal clear." },
            { number: "02", title: "Build in context.", text: "Work across project files and commands, with the changes visible as you go." },
            { number: "03", title: "Make it yours.", text: "Inspect the output, run your checks, and decide when it is ready to ship." },
          ].map((step, i) => <motion.article key={step.number} {...reveal} transition={{ duration: reducedMotion ? 0 : .6, delay: reducedMotion ? 0 : i * .12 }}><span>{step.number}</span><h3>{step.title}</h3><p>{step.text}</p></motion.article>)}
        </div>
      </section>
      <div className="landing-technologies" aria-label="Built with">
        {["Electron", "TypeScript", "React 19", "Vite", "Nitro", "Tailwind CSS", "Inno Setup"].map(tech => <span key={tech}>{tech}</span>)}
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: '{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Calvras","url":"https://calvras.com/","applicationCategory":"DeveloperApplication","operatingSystem":"Windows 10, Windows 11 (x64)","softwareVersion":"10.0.0","downloadUrl":"https://github.com/SHIKARI-hey/Calvras/releases/download/v10.0.0/Calvras-Setup-win-x64.exe","image":"https://calvras.com/social-preview.png","description":"A Windows x64 desktop AI coding agent for project files, local commands, and visible change review."}' }} />
      <MarketingFooter />
    </div>
  );
}
