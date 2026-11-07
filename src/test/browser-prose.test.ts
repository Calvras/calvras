import { describe, expect, it } from "vitest";
import { proseScript } from "../lib/browser-bridge";

/** The text a click reports back so the agent does not spend a whole model round looking for the
 * receipt the confirmation page just printed. Runs the page-side body the way the webview does. */
function read() {
  return new Function(`return ${proseScript()}`)() as { headings: string; text: string };
}

describe("reading a page from the click that changed it", () => {
  it("pulls the reference off the confirmation without a screenshot round", () => {
    document.body.innerHTML = `<h1>Application received</h1><p class="receipt">Reference AC-57573</p>
      <p>We will be in touch within five working days.</p>`;
    const page = read();
    expect(page.headings).toContain("Application received");
    expect(page.headings).toContain("AC-57573");
    expect(page.text).toContain("five working days");
  });

  it("carries a rejection reason, not just a success heading", () => {
    document.body.innerHTML = `<h2>Something is missing</h2><div role="alert">No résumé attached.</div>`;
    expect(read().headings).toContain("No résumé attached.");
  });

  it("keeps long pages short enough to send every round", () => {
    document.body.innerHTML = `<p>${"filler ".repeat(2000)}</p>`;
    expect(read().text.length).toBeLessThanOrEqual(1800);
  });
});
