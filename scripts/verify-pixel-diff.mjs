// Proves the screenshot comparison on real renders: a same-page capture at another pixel
// density still passes, while a recoloured or rearranged screen does not.
import { chromium } from "playwright";
import { pixelDiffScript, summarizeFidelity, fidelityNote } from "../src/lib/image-fidelity.ts";

const checks = [];
const check = (label, ok, detail = "") => checks.push([label, Boolean(ok), detail]);
const capture = async (target) => "data:image/png;base64," + (await target.screenshot()).toString("base64");

const row = (title, index, accent) => [
  '<div style="display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid #23232b">',
  '<span style="width:10px;height:10px;border-radius:50%;background:' + (index % 2 ? accent : "#3a3a45") + '"></span>',
  '<b style="flex:1;color:#e8e8ee">' + title + "</b>",
  '<span style="color:#8b8b98">' + (12 + index * 3) + "</span>",
  '<button style="background:' + (index % 3 ? "#22222b" : accent) + ';color:#fff;border:1px solid #34343f;padding:6px 14px;border-radius:8px">' + (index % 3 ? "Open" : "Send") + "</button>",
  "</div>",
].join("");

const ORIGINAL = ["Applications", "Bookings", "Listings", "Invoices", "Reports", "Signatures", "Queue"];
const RESTRUCTURED = ["Queue", "Invoices", "Signatures", "Bookings", "Applications", "Listings", "Reports"];

function pageMarkup(accent, variant) {
  const titles = variant === "restructured" ? RESTRUCTURED : ORIGINAL;
  const rows = titles.map((title, index) => row(title, index, accent)).join("");
  const extra = variant === "restructured"
    ? '<div style="padding:14px 16px;background:#191920;color:#ffd166">Bulk actions <button style="margin-left:8px;background:' + accent + ';color:#0b0b0e;border:0;padding:6px 12px;border-radius:8px">Apply to all</button></div>'
    : "";
  return "<!doctype html><meta charset=utf-8>"
    + '<body style="margin:0;font-family:system-ui;background:#101014">'
    + '<h1 style="padding:20px 16px 6px;margin:0;font-size:26px;color:#f4f4f6">' + (variant === "restructured" ? "Library" : "Workspace") + "</h1>"
    + '<div style="display:flex;gap:10px;padding:6px 16px 14px">'
    + '<button style="background:' + accent + ';color:#fff;border:0;padding:8px 16px;border-radius:10px">New</button>'
    + '<button style="background:#1c1c22;color:#e8e8ee;border:1px solid #2f2f38;padding:8px 16px;border-radius:10px">Filter</button>'
    + '<button style="background:#1c1c22;color:#e8e8ee;border:1px solid #2f2f38;padding:8px 16px;border-radius:10px">Export</button>'
    + "</div>" + extra + rows
    + '<div style="padding:16px;color:#7c7c88">Synced a few seconds ago</div>'
    + "</body>";
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();

await page.setContent(pageMarkup("#2f6df6", "original"));
const reference = await capture(page);
const numbers = (f) => `${f.similarity}% similar, diff ${f.diff}, palette ${f.palettePercent}, structure ${f.structurePercent}, shape ${f.shapeComparable}`;

const identical = summarizeFidelity(await page.evaluate(pixelDiffScript(reference, reference)));
check("identical page measures as a match", identical.matched === true, numbers(identical));
check("comparison returns a reference | render | difference strip", typeof identical.heatmap === "string" && identical.heatmap.startsWith("data:image/png"), "strip " + Math.round((identical.heatmap || "").length / 1024) + " KB");

// The same screen captured on a 2x display: what a user screenshot really is.
const hiresContext = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
const hiresPage = await hiresContext.newPage();
await hiresPage.setContent(pageMarkup("#2f6df6", "original"));
const crossScale = summarizeFidelity(await page.evaluate(pixelDiffScript(reference, await capture(hiresPage))));
await hiresContext.close();
check("the same screen from a higher-resolution display still passes", crossScale.matched === true, numbers(crossScale));

await page.setContent(pageMarkup("#e63946", "original"));
const recolored = summarizeFidelity(await page.evaluate(pixelDiffScript(reference, await capture(page))));
check("a recoloured screen fails on colours, not layout", recolored.matched === false && recolored.reasons.includes("the colours are not the ones in the screenshot"), numbers(recolored));

await page.setContent(pageMarkup("#2f6df6", "restructured"));
const restructured = summarizeFidelity(await page.evaluate(pixelDiffScript(reference, await capture(page))));
check("a rearranged screen fails the comparison", restructured.matched === false, numbers(restructured));
check("a rearranged screen names where it differs", restructured.hotspots.length > 0, restructured.hotspots.map((item) => item.region + " " + item.diff + "%").join(", "));
check("the note sends the agent back to work", fidelityNote(restructured).includes("compare_to_reference"), fidelityNote(restructured).slice(0, 150));

await page.setViewportSize({ width: 700, height: 700 });
await page.setContent(pageMarkup("#2f6df6", "original"));
const wrongShape = summarizeFidelity(await page.evaluate(pixelDiffScript(reference, await capture(page))));
check("a preview of another shape is reported as not comparable", wrongShape.matched === false && wrongShape.shapeComparable === false && wrongShape.reasons.some((reason) => reason.includes("different shape")), numbers(wrongShape));
await page.setViewportSize({ width: 1000, height: 700 });

await page.setContent(pageMarkup("#2f6df6", "original"));
const sameAgain = summarizeFidelity(await page.evaluate(pixelDiffScript(reference, await capture(page))));
check("fixing the screen takes the verdict back to a match", sameAgain.matched === true, numbers(sameAgain));

await browser.close();
for (const [label, ok, detail] of checks) console.log((ok ? "PASS" : "FAIL") + "  " + label + (detail ? " — " + detail : ""));
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
