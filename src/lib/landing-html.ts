export const LANDING_HTML: string = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Calvras — The AI Coding Agent</title>
<meta content="Calvras is the autonomous AI coding agent that reads, writes, and runs code in your workspace. Build full-stack apps, websites, and mobile views with one prompt." name="description"/>
<meta content="Calvras — The AI Coding Agent" property="og:title"/>
<meta content="Calvras is the autonomous AI coding agent that reads, writes, and runs code in your workspace. Build full-stack apps, websites, and mobile views with one prompt." property="og:description"/>
<meta content="Calvras — The AI Coding Agent" name="twitter:title"/>
<meta content="Calvras is the autonomous AI coding agent that reads, writes, and runs code in your workspace. Build full-stack apps, websites, and mobile views with one prompt." name="twitter:description"/>
<meta property="og:type" content="website"/>
<meta content="summary_large_image" name="twitter:card"/>
<meta content="width=device-width, initial-scale=1" name="viewport"/>
<meta content="DkTYHh81lTQx0P4FlcxMUmEooDBy-ZpJlM-S5aXMwLk" name="google-site-verification"/>
<link rel="icon" href="/calvras-logo.ico"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous"/>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet"/>
<style>
  :root{
    --page:#0a0c12;
    --frame:#13161f;
    --panel:#1a1e29;
    --panel-2:#232838;
    --line:#2b3140;
    --ink:#eef1f7;
    --muted:#9aa2b4;
    --faint:#6b7385;
    --steel:#8b93a7;
    --steel-deep:#6f7686;
    --radius:30px;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{background:var(--page);}
  body{
    font-family:'Inter',system-ui,sans-serif;
    color:var(--ink);
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:40px 24px;
    -webkit-font-smoothing:antialiased;
  }
  a{color:inherit;text-decoration:none;}
  .frame{
    width:100%;
    max-width:1216px;
    background:var(--frame);
    border:1px solid var(--line);
    border-radius:var(--radius);
    padding:22px 26px 26px;
    position:relative;
    box-shadow:0 40px 120px rgba(0,0,0,0.55);
  }
  /* ── top bar ── */
  .topbar{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:24px;
    padding:6px 14px 20px;
  }
  .brand{display:flex;align-items:center;gap:11px;}
  .brand img{width:34px;height:34px;object-fit:contain;}
  .brand .word{
    font-family:'Oswald',sans-serif;
    font-weight:600;
    font-size:21px;
    letter-spacing:0.30em;
    color:var(--ink);
  }
  .nav{display:flex;align-items:center;gap:30px;}
  .nav a{
    font-family:'Space Mono',monospace;
    font-size:12.5px;
    color:var(--muted);
    display:flex;
    align-items:baseline;
    gap:7px;
    transition:color .18s ease;
  }
  .nav a:hover{color:var(--ink);}
  .nav a .num{font-size:9.5px;color:var(--faint);}
  .top-actions{display:flex;align-items:center;gap:18px;}
  .download-pill{
    font-family:'Space Mono',monospace;
    font-weight:700;
    font-size:12.5px;
    letter-spacing:0.12em;
    background:var(--steel);
    color:#0b0d14;
    padding:12px 26px;
    border-radius:999px;
    transition:background .18s ease,transform .18s ease;
  }
  .download-pill:hover{background:#a7aec0;transform:translateY(-1px);}
  .burger{display:flex;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:6px 2px;}
  .burger span{display:block;width:24px;height:2px;background:var(--ink);border-radius:2px;}
  /* ── hero ── */
  .hero{
    position:relative;
    height:600px;
    border-radius:24px;
    overflow:hidden;
    background:
      radial-gradient(120% 90% at 70% 20%, #2a3040 0%, #1a1e29 45%, #10131c 100%);
    border:1px solid var(--line);
  }
  .watermark{
    position:absolute;
    top:46%;
    left:50%;
    transform:translate(-50%,-50%);
    font-family:'Oswald',sans-serif;
    font-weight:700;
    font-size:230px;
    letter-spacing:0.04em;
    color:rgba(255,255,255,0.035);
    white-space:nowrap;
    pointer-events:none;
    user-select:none;
  }
  .hero-logo{
    position:absolute;
    top:50%;
    left:54%;
    transform:translate(-50%,-50%);
    width:440px;
    height:440px;
    object-fit:contain;
    filter:drop-shadow(0 30px 60px rgba(0,0,0,0.5));
    pointer-events:none;
  }
  .eyebrow{
    position:absolute;
    top:108px;
    left:46px;
    font-family:'Space Mono',monospace;
    font-size:12px;
    letter-spacing:0.18em;
    color:var(--muted);
    display:flex;
    gap:60px;
  }
  .headline-left{
    position:absolute;
    top:138px;
    left:42px;
    font-family:'Oswald',sans-serif;
    font-weight:600;
    font-size:96px;
    line-height:0.94;
    letter-spacing:0.005em;
    text-transform:uppercase;
    color:var(--ink);
  }
  .headline-right{
    position:absolute;
    right:46px;
    bottom:44px;
    text-align:right;
    font-family:'Oswald',sans-serif;
    font-weight:600;
    font-size:90px;
    line-height:0.94;
    text-transform:uppercase;
    color:var(--ink);
  }
  .stat-card{
    position:absolute;
    left:0;
    bottom:96px;
    display:flex;
    align-items:center;
    gap:22px;
    background:var(--panel-2);
    border:1px solid var(--line);
    border-left:none;
    border-radius:0 18px 18px 0;
    padding:18px 26px 18px 46px;
  }
  .stat-card .big{font-family:'Oswald',sans-serif;font-weight:600;font-size:34px;line-height:1;color:var(--ink);}
  .stat-card .small{font-size:12px;color:var(--muted);margin-top:5px;}
  .avatars{display:flex;}
  .avatars span{
    width:38px;height:38px;border-radius:50%;
    border:2px solid var(--panel-2);
    background:linear-gradient(135deg,#aeb6c6,#6f7686);
    display:flex;align-items:center;justify-content:center;
    font-size:13px;font-weight:600;color:#13161f;
  }
  .avatars span+span{margin-left:-12px;background:linear-gradient(135deg,#8b93a7,#4a5162);}
  .inset-tile{
    position:absolute;
    top:124px;
    right:96px;
    width:176px;
    height:176px;
    border-radius:20px;
    overflow:hidden;
    border:1px solid var(--line);
    background:var(--panel-2);
    box-shadow:0 20px 40px rgba(0,0,0,0.4);
  }
  .inset-tile img{width:100%;height:100%;object-fit:cover;}
  .social-rail{
    position:absolute;
    top:124px;
    right:30px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap:18px;
    background:var(--panel-2);
    border:1px solid var(--line);
    border-radius:999px;
    padding:16px 11px;
  }
  .social-rail a{color:var(--muted);display:flex;transition:color .18s ease;}
  .social-rail a:hover{color:var(--ink);}
  .social-rail svg{width:17px;height:17px;}
  /* ── footer tagline ── */
  .tagline{
    display:flex;
    align-items:center;
    gap:18px;
    padding:22px 16px 4px;
  }
  .tagline .dot{
    width:42px;height:42px;border-radius:50%;
    background:var(--steel);
    display:flex;align-items:center;justify-content:center;
    flex-shrink:0;
  }
  .tagline .dot svg{width:18px;height:18px;color:#0b0d14;}
  .tagline p{font-size:14px;line-height:1.5;color:var(--muted);}
  .tagline p strong{color:var(--ink);font-weight:500;}
  @media (max-width:900px){
    .nav{display:none;}
    .hero{height:520px;}
    .headline-left{font-size:64px;}
    .headline-right{font-size:58px;bottom:70px;}
    .hero-logo{width:300px;height:300px;left:60%;}
    .inset-tile{width:120px;height:120px;right:74px;}
    .watermark{font-size:140px;}
  }
</style>
</head>
<body>
  <div class="frame">
    <div class="topbar">
      <a class="brand" href="/">
        <img src="/calvras-logo.png" alt="Calvras"/>
        <span class="word">CALVRAS</span>
      </a>
      <nav class="nav">
        <a href="/about"><span class="num">01</span>features</a>
        <a href="/capabilities"><span class="num">02</span>capabilities</a>
        <a href="/pricing"><span class="num">03</span>pricing</a>
        <a href="/docs"><span class="num">04</span>docs</a>
      </nav>
      <div class="top-actions">
        <a class="download-pill" href="/calvras-setup.exe" download>DOWNLOAD</a>
        <button class="burger" aria-label="Menu"><span></span><span></span></button>
      </div>
    </div>

    <div class="hero">
      <div class="watermark">CALVRAS</div>
      <img class="hero-logo" src="/calvras-logo.png" alt="Calvras logo"/>

      <div class="eyebrow"><span>[ DESKTOP AI AGENT</span><span>2026 ]</span></div>
      <h1 class="headline-left">Code<br/>Without<br/>Limits</h1>

      <div class="stat-card">
        <div>
          <div class="big">10K+</div>
          <div class="small">Trusted by developers &amp; teams</div>
        </div>
        <div class="avatars"><span>C</span><span>K</span></div>
      </div>

      <div class="inset-tile"><img src="/social-preview.png" alt="Calvras app preview"/></div>

      <div class="social-rail">
        <a href="https://github.com/Calvras/calvras" aria-label="GitHub" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/></svg>
        </a>
        <a href="/docs" aria-label="Docs">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        </a>
        <a href="/support" aria-label="Support">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </a>
      </div>

      <div class="headline-right">Ship<br/>Fast</div>
    </div>

    <div class="tagline">
      <span class="dot">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </span>
      <p><strong>Start building in 30 seconds.</strong><br/>Designed for developers who ship.</p>
    </div>
  </div>
</body>
</html>`;