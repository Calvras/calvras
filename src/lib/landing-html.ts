export const LANDING_HTML: string = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calvras — Build Real Projects | AI Coding Agent</title>
<meta name="description" content="Build real projects and harness AI-powered coding — up to 50× faster.">
<meta property="og:title" content="Calvras — Build Real Projects | AI Coding Agent">
<meta property="og:description" content="Build real projects with AI-powered coding.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="google-site-verification" content="DkTYHh81lTQx0P4FlcxMUmEooDBy-ZpJlM-S5aXMwLk">
<link rel="icon" href="/calvras-logo.ico" type="image/x-icon">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Manrope:wght@400;500;600;700;800&display=swap">
<style>
:root{
  --radius:0.625rem;
  --hero-from:oklch(0.72 0 0);
  --hero-to:oklch(0.96 0 0);
  --brand:oklch(0.68 0.2 40);
  --check-orange:oklch(0.7 0.18 45);
  --check-blue:oklch(0.65 0.17 245);
  --background:oklch(1 0 0);
  --foreground:oklch(0.15 0 0);
  --card:oklch(1 0 0);
  --primary:oklch(0.12 0 0);
  --primary-foreground:oklch(0.984 0.003 247.858);
  --border:oklch(0.929 0.013 255.508);
  --font-display:"Fraunces",Georgia,serif;
  --font-sans:"Manrope",system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;border-color:var(--border);}
html,body{height:100%;}
body{background:var(--background);color:var(--foreground);font-family:var(--font-sans);}
a{color:inherit;text-decoration:none;}
img{display:block;}
.page{min-height:100vh;background:var(--card);}
.wrap{display:flex;min-height:100vh;flex-direction:column;padding:12px;}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;padding:20px 32px;font-size:14px;font-weight:600;}
.brand{display:flex;align-items:center;gap:12px;}
.brand-mark{width:34px;height:28px;object-fit:contain;}
nav{display:none;align-items:center;gap:16px;}
nav .item{display:flex;align-items:center;gap:16px;}
.head-right{display:flex;align-items:center;gap:24px;}
.vdiv{display:none;height:24px;width:1px;background:var(--border);}
.pill-outline{border:1px solid var(--primary);border-radius:9999px;padding:10px 20px;}
.pill-outline .light{font-weight:400;}
.hero{background:linear-gradient(180deg,var(--hero-from),var(--hero-to));display:grid;flex:1;gap:40px;border-radius:22px;padding:64px 32px;}
.hero-left{display:flex;flex-direction:column;justify-content:center;}
.badge-row{display:flex;align-items:center;gap:12px;}
.badge-dot{display:flex;height:36px;width:36px;align-items:center;justify-content:center;border-radius:50%;background:var(--primary);color:var(--primary-foreground);font-size:12px;}
.badge-text{font-family:var(--font-display);line-height:1.25;}
.badge-text .big{font-size:18px;font-weight:600;}
.badge-text .small{font-size:14px;}
.badge-text a{font-weight:600;text-decoration:underline;}
h1{font-family:var(--font-display);margin-top:24px;font-size:96px;line-height:1;letter-spacing:-0.025em;font-weight:400;}
hr{margin-top:32px;border:0;border-top:1px solid oklch(0.15 0 0 / 0.2);}
.sub{margin-top:24px;font-size:18px;line-height:1.625;}
.testi{margin-top:24px;display:flex;align-items:center;gap:24px;border-bottom:1px solid oklch(0.15 0 0 / 0.2);padding-bottom:20px;font-family:var(--font-display);font-size:14px;}
.testi img{height:32px;width:32px;border-radius:50%;object-fit:cover;}
.testi .slash{font-family:var(--font-sans);}
.testi .rate{display:flex;align-items:center;gap:4px;font-weight:600;}
.testi .rate svg{height:12px;width:12px;fill:currentColor;}
.cta{margin-top:40px;display:flex;align-items:center;gap:32px;font-size:14px;font-weight:600;}
.pill-black{border-radius:9999px;background:var(--primary);color:var(--primary-foreground);padding:14px 24px;}
.pill-black .light{font-weight:400;}
.pricing{display:flex;align-items:center;gap:4px;text-decoration:underline;}
.pricing svg{height:16px;width:16px;}
.hero-right{position:relative;margin:0 auto;height:500px;width:100%;max-width:520px;}
.portrait{position:absolute;left:18%;top:0;height:100%;width:56%;overflow:hidden;border-radius:22px;background:var(--brand);}
.portrait img{height:100%;width:100%;object-fit:contain;}
.chip{position:absolute;display:flex;align-items:center;gap:12px;border-radius:9999px;background:var(--card);padding:10px 16px;font-size:14px;box-shadow:0 1px 3px 0 rgb(0 0 0 / 0.1),0 1px 2px -1px rgb(0 0 0 / 0.1);}
.chip .check{display:flex;height:20px;width:20px;align-items:center;justify-content:center;border-radius:4px;color:var(--card);}
.chip .check svg{height:12px;width:12px;}
.chip-fit{left:12%;top:20%;}
.chip-fit .check{background:var(--check-orange);}
.chip-design{left:0;top:30%;}
.chip-design .check{background:var(--check-blue);}
.play{position:absolute;left:46%;top:47%;display:flex;height:56px;width:56px;align-items:center;justify-content:center;border-radius:50%;background:var(--card);border:0;box-shadow:0 1px 3px 0 rgb(0 0 0 / 0.1),0 1px 2px -1px rgb(0 0 0 / 0.1);cursor:pointer;}
.play svg{height:16px;width:16px;fill:currentColor;}
.glass{background:oklch(1 0 0 / 0.35);backdrop-filter:blur(16px);border:1px solid oklch(1 0 0 / 0.5);}
.glass-stat{position:absolute;right:0;top:5%;width:160px;border-radius:22px;padding:20px;}
.glass-stat .k{font-size:10px;font-weight:600;}
.glass-stat .v{margin-top:12px;font-size:36px;font-weight:700;}
.glass-stat .d{margin-top:4px;font-size:14px;color:oklch(0.15 0 0 / 0.7);}
.glass-product{position:absolute;right:-16px;bottom:4%;display:flex;width:288px;align-items:center;gap:16px;border-radius:22px;padding:16px;}
.glass-product img{height:112px;width:112px;border-radius:18px;object-fit:cover;}
.glass-product .name{font-size:18px;line-height:1.25;}
.glass-product .price{margin-top:4px;font-size:24px;font-weight:700;}
.glass-product .rate{margin-top:8px;display:inline-flex;align-items:center;gap:4px;border-radius:9999px;background:var(--card);padding:2px 8px;font-size:14px;font-weight:600;}
.glass-product .rate svg{height:12px;width:12px;fill:currentColor;}
.logos{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-around;gap:24px;padding:40px 32px;font-size:24px;font-weight:800;letter-spacing:-0.025em;}
@media (min-width:768px){
  nav{display:flex;}
  .vdiv{display:block;}
  .hero{grid-template-columns:1fr 1fr;padding:64px 56px;}
  h1{font-size:144px;}
}
</style>
</head>
<body>
<div class="page">
  <div class="wrap">
    <header>
      <div class="brand">
        <img class="brand-mark" src="/calvras-logo.png" alt="Calvras">
        <span>/ Sales@calvras.com</span>
      </div>
      <nav>
        <span class="item"><a href="/about">Product</a></span>
        <span class="item"><span>.</span><a href="/capabilities">Solutions</a></span>
        <span class="item"><span>.</span><a href="/pricing">Pricing</a></span>
        <span class="item"><span>.</span><a href="/docs">Developers</a></span>
      </nav>
      <div class="head-right">
        <span class="vdiv"></span>
        <a href="/signin">Log in</a>
        <a href="https://github.com/Calvras/calvras/releases/download/v9.5.0/Calvras.Setup.9.5.0.exe" class="pill-outline">Get it Now <span class="light">— It's Free</span></a>
      </div>
    </header>

    <section class="hero">
      <div class="hero-left">
        <div class="badge-row">
          <span class="badge-dot">✦</span>
          <div class="badge-text">
            <p class="big">v9.5.0</p>
            <p class="small">Read Our <a href="https://github.com/Calvras/calvras/releases">Release Notes</a></p>
          </div>
        </div>
        <h1>Calvras</h1>
        <hr>
        <p class="sub">Build Real Projects, And Harness Ai-Powered Coding — Up To 50× Faster.</p>
        <div class="testi">
          <img src="/calvras-logo.png" alt="">
          <p>Loved the performance<br>100% Satisfied</p>
          <span class="slash">/</span>
          <span class="rate"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>4.9</span>
        </div>
        <div class="cta">
          <a href="https://github.com/Calvras/calvras/releases/download/v9.5.0/Calvras.Setup.9.5.0.exe" class="pill-black">Download <span class="light">— It's Free</span></a>
          <a href="/pricing" class="pricing">Our Pricing <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg></a>
        </div>
      </div>

      <div class="hero-right">
        <div class="portrait"><img src="/calvras-logo.png" alt="Calvras logo"></div>
        <div class="chip chip-fit"><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>How is the build?</div>
        <div class="chip chip-design"><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>Do you like the design?</div>
        <button aria-label="Play" class="play"><svg viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"/></svg></button>
        <div class="glass glass-stat">
          <p class="k">— UP TO</p>
          <p class="v">50×</p>
          <p class="d">Faster builds this week</p>
        </div>
        <div class="glass glass-product">
          <img src="/calvras-logo.png" alt="Calvras">
          <div>
            <p class="name">Calvras<br>Desktop</p>
            <p class="price">Free</p>
            <span class="rate"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>4.9</span>
          </div>
        </div>
      </div>
    </section>

    <div class="logos">
      <span>Desktop</span>
      <span>Terminal</span>
      <span>Preview</span>
      <span>Library</span>
      <span>Plugins</span>
    </div>
  </div>
</div>
</body>
</html>
`;