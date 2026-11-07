import { beforeEach, describe, expect, it } from "vitest";
import { fillScript } from "../lib/browser-bridge";

/** Runs the page-side body of `fill_input` against a real form, the way the webview does, so a
 * dropdown or consent box that would silently keep its default is caught here rather than in a
 * submitted application. */
function fill(selector: string, value: string) {
  return new Function(`return ${fillScript(selector, value)}`)() as { tag: string; type: string; value?: string; checked?: boolean };
}

describe("filling a page control", () => {
  beforeEach(() => {
    document.body.innerHTML = `<form>
      <select id="role"><option>Frontend Engineer</option><option>Backend Engineer</option></select>
      <select id="availability"><option>Immediately</option><option>2 weeks</option><option>1 month</option></select>
      <label for="agree">I consent to storing this application</label><input id="agree" name="agree" type="checkbox" value="on">
      <label for="pro">Pro plan</label><input id="pro" name="plan" type="radio" value="pro">
      <input id="when" name="when" type="date">
      <textarea id="why" name="why"></textarea>
    </form>`;
  });

  it("chooses a dropdown option by its visible label", () => {
    expect((document.querySelector("#role") as HTMLSelectElement).value).toBe("Frontend Engineer");
    expect(fill("#role", "Backend Engineer").value).toBe("Backend Engineer");
    fill("#availability", "2 weeks");
    expect((document.querySelector("#availability") as HTMLSelectElement).selectedOptions[0]!.textContent!.trim()).toBe("2 weeks");
  });

  it("matches a dropdown option loosely instead of leaving the default in place", () => {
    fill("#role", "backend");
    expect((document.querySelector("#role") as HTMLSelectElement).value).toBe("Backend Engineer");
  });

  it("lists the real options when the requested one does not exist", () => {
    expect(() => fill("#availability", "next fortnight")).toThrow(/these options: Immediately \| 2 weeks \| 1 month/);
    expect((document.querySelector("#availability") as HTMLSelectElement).value).toBe("Immediately");
  });

  it("ticks a consent box by changing checked, which is what the form submits", () => {
    expect(fill("#agree", "on").checked).toBe(true);
    expect(new FormData(document.querySelector("form")! as HTMLFormElement).get("agree")).toBe("on");
    fill("#agree", "off");
    expect((document.querySelector("#agree") as HTMLInputElement).checked).toBe(false);
    expect(new FormData(document.querySelector("form")! as HTMLFormElement).get("agree")).toBeNull();
  });

  it("refuses to guess on a tick box and says what it can accept", () => {
    expect(() => fill("#agree", "probably")).toThrow(/currently unticked\. Fill it with "on" to tick it or "off"/);
  });

  it("selects a radio by its value or its label", () => {
    expect(fill("#pro", "pro").checked).toBe(true);
    fill("#pro", "off");
    expect((document.querySelector("#pro") as HTMLInputElement).checked).toBe(false);
    fill("#pro", "Pro plan");
    expect((document.querySelector("#pro") as HTMLInputElement).checked).toBe(true);
  });

  it("reports a date field that rejected the value instead of submitting an empty one", () => {
    expect(() => fill("#when", "14/11/2026")).toThrow(/kept "" instead of "14\/11\/2026"; a date field needs its exact format/);
    fill("#when", "2026-11-14");
    expect((document.querySelector("#when") as HTMLInputElement).value).toBe("2026-11-14");
  });

  it("writes a textarea and fires the events a page framework listens for", () => {
    const seen: string[] = [];
    document.querySelector("#why")!.addEventListener("input", () => seen.push("input"));
    document.querySelector("#why")!.addEventListener("change", () => seen.push("change"));
    fill("#why", "I have shipped TypeScript apps for four years.");
    expect((document.querySelector("#why") as HTMLTextAreaElement).value).toBe("I have shipped TypeScript apps for four years.");
    expect(seen).toEqual(["input", "change"]);
  });

  it("names the missing element rather than failing quietly", () => {
    expect(() => fill("#nope", "anything")).toThrow(/No element matches #nope/);
  });
});
