import { describe, expect, it } from "vitest";
import { PAGE_SOURCE_SNAPSHOT_SOURCE } from "@/lib/runtime/page-localizer";
import { absolutizeCssUrls, buildStylesheet, dropImportRules, importUrls } from "@/lib/runtime/page-source";

/**
 * A saved page that still points at the origin for its CSS renders as a wall of unstyled text, which
 * reads exactly like a hand-written clone that got the spacing and the colour wrong. These are the
 * rules that keep the copy's own numbers in the file the user ends up serving.
 */
describe("the stylesheet a taken page gets", () => {
  it("resolves every url() against the sheet that declared it", () => {
    const base = "https://cdn.example.com/v2/site.css";
    expect(absolutizeCssUrls(`.a{background:url(/tile.png)}\n.b{background:url("fonts/x.woff2")}\n.c{background:url('a b.png')}`, base))
      .toBe(`.a{background:url("https://cdn.example.com/tile.png")}\n.b{background:url("https://cdn.example.com/v2/fonts/x.woff2")}\n.c{background:url("https://cdn.example.com/v2/a%20b.png")}`);
  });

  it("leaves an embedded image alone instead of rewriting it into a broken address", () => {
    expect(absolutizeCssUrls(`.a{background:url(data:image/svg+xml;base64,AAAA)}`, "https://cdn.example.com/site.css"))
      .toBe(`.a{background:url("data:image/svg+xml;base64,AAAA")}`);
  });

  it("reads an @import out as an address to fetch and then deletes the rule", () => {
    const css = '@import url("base.css") screen;\n@import "https://cdn.example.com/other.css";\nbody{color:red}';
    expect(importUrls(css, "https://example.com/site.css")).toEqual(["https://example.com/base.css", "https://cdn.example.com/other.css"]);
    expect(dropImportRules(css)).toBe("\n\nbody{color:red}");
  });

  it("keeps the sheets in document order and labels each with where it came from", () => {
    expect(buildStylesheet([{ href: "https://cdn/site.css", css: "a{color:red}" }], ["b{color:blue}"]))
      .toBe("/* https://cdn/site.css */\na{color:red}\n\n/* inline <style> 1 */\nb{color:blue}");
  });
});

describe("the markup a taken page hands back", () => {
  it("runs as page-side JavaScript and returns the document with its scripts gone", async () => {
    // This string is loaded straight into the browser, so a TypeScript cast in it is a syntax error
    // the whole call dies on — the shape of the result is checked here, in jsdom, before the run ever
    // reaches a real page.
    document.documentElement.innerHTML = `<head><title>Copy fixture</title><link rel="stylesheet" href="/site.css"><style>a{color:red}</style><script src="/app.js"></script><script>console.error("x")</script></head><body><img src="/logo.svg" width="24"><a href="/home">Home</a></body>`;
    const snap = await (new Function(`return (${PAGE_SOURCE_SNAPSHOT_SOURCE})`)() as Promise<any>);
    expect(snap.scriptCount).toBe(2);
    expect(snap.html).not.toContain("<script");
    expect(snap.html).toContain(`href="./calvras-page.css"`);
    expect(snap.html).toContain(`src="${new URL("/logo.svg", location.href).href}"`);
    expect(snap.stylesheetHrefs).toEqual([new URL("/site.css", location.href).href]);
    expect(snap.inlineStyles).toEqual(["a{color:red}"]);
    expect(snap.doctype).toBe("<!doctype html>");
  });
});
