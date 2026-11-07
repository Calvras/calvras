import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageText, searchWeb } from "../lib/web-search";

const desktop = `<a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://examglow.example/about")}&amp;rut=x">Examglow</a><a class="result__snippet" href="#">Examglow is a study app.</a>`;
const lite = `<a rel="nofollow" href="https://examglow.example/" class='result-link'>Examglow home</a><td class='result-snippet'>Examglow is a study app.</td>`;

const signal = () => new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe("the web tools that need no folder", () => {
  it("returns only the hits the engine printed, with the redirect cleaned out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(desktop, { status: 200 })));
    const answer = await searchWeb("examglow", signal());
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.engine).toBe("DuckDuckGo");
    expect(answer.results).toEqual([{ title: "Examglow", url: "https://examglow.example/about", snippet: "Examglow is a study app." }]);
    expect(answer.instruction).toContain("do not add any you were not given");
  });
  it("falls back to the lite markup when the desktop page parses empty", async () => {
    const fetchStub = vi.fn(async (url: string | URL | Request) => String(url).includes("lite.")
      ? new Response(lite, { status: 200 })
      : new Response("<html>no results here</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const answer = await searchWeb("examglow", signal());
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.engine).toBe("DuckDuckGo Lite");
    expect(answer.results[0]).toEqual({ title: "Examglow home", url: "https://examglow.example/", snippet: "Examglow is a study app." });
  });
  it("reports a failed search as a failure instead of an empty success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>rate limited</html>", { status: 200 })));
    const answer = await searchWeb("examglow", signal());
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toContain("No web engine returned results");
    expect(answer.engines.map((attempt) => attempt.engine)).toEqual(["DuckDuckGo", "DuckDuckGo Lite"]);
  });
  it("reads one https page as text and refuses a plain http url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<style>x</style><h1>Examglow</h1><p>Study app</p>", { status: 200 })));
    const page = await fetchPageText("https://examglow.example/", signal());
    expect(page.ok).toBe(true);
    expect(page.content).toBe("Examglow Study app");
    await expect(fetchPageText("http://examglow.example/", signal())).rejects.toThrow("HTTPS");
  });
});
