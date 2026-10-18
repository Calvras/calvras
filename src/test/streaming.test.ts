// @vitest-environment node
import { describe, expect, it } from "vitest";
import { partialMessage, readSSE } from "../lib/streaming";

describe("incremental streaming", () => {
  it("decodes events split across network and UTF-8 boundaries", async () => {
    const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"text":"héllo"}\r\n\r\ndata: [DONE]\n\n');
    const events: unknown[] = [];
    await readSSE(new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } })), (event) => events.push(event));
    expect(events).toEqual([{ text: "héllo" }]);
  });
  it("publishes text before the stream finishes", async () => {
    let finish!: () => void;
    const events: unknown[] = [];
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"text":"first"}\n\n')); finish = () => controller.close(); } }));
    const pending = readSSE(response, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([{ text: "first" }]);
    finish(); await pending;
  });
  it("decodes only a public message with incomplete escapes", () => {
    expect(partialMessage('{"message":"Reading\\nfile\\u0020')).toBe("Reading\nfile ");
    expect(partialMessage('{"message":"Read\\')).toBe("Read");
    expect(partialMessage('{"message":"Read","actions":[{"content":"secret')).toBe("Read");
    expect(partialMessage('{"reasoning":"private","message":"public')).toBeUndefined();
  });
  it("surfaces malformed stream events", async () => {
    await expect(readSSE(new Response('data: broken\n\n'), () => {})).rejects.toThrow();
  });
});
