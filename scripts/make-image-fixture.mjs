// Builds the reference screenshot used by the image-fidelity check: a deliberately
// minimal screen so any extra section the agent invents is easy to spot.
import { chromium } from "playwright";
import fs from "node:fs/promises";

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b1020;color:#e8ecff;font:16px system-ui;display:grid;place-items:center}
.card{width:340px;background:#151b31;border:1px solid #2a3357;border-radius:14px;padding:26px}
h1{font-size:22px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;background:#0d1226;border:1px solid #2a3357;border-radius:8px;color:#e8ecff;padding:10px;margin-bottom:14px}
button{background:#4c6fff;border:0;border-radius:8px;color:#fff;padding:10px 16px;font:inherit}
</style><div class="card"><h1>Vault</h1><input placeholder="Paste a secret"><button>Hide</button></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.setContent(html);
await fs.mkdir(".agents/artifacts/image-fidelity", { recursive: true });
await page.screenshot({ path: ".agents/artifacts/image-fidelity/reference.png" });
await browser.close();
console.log("reference screenshot written");
