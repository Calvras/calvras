/** Parses SSE across arbitrary network and UTF-8 boundaries. */
export async function readSSE(response: Response, onData: (data: any) => void, signal?: AbortSignal) {
  if (!response.body) throw new Error("Streaming response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const dispatch = (event: string) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    onData(JSON.parse(data));
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        dispatch(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) { if (buffer.trim()) dispatch(buffer); break; }
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read only the top-level public message. Never expose partial actions or reasoning. */
export function partialMessage(raw: string): string | undefined {
  const match = /^\s*(?:```(?:json)?\s*)?\{\s*"message"\s*:\s*"/.exec(raw);
  if (!match) return undefined;
  let value = "";
  for (let i = match[0].length; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '"') return value;
    if (char !== "\\") { value += char; continue; }
    const escaped = raw[++i];
    if (escaped === undefined) break;
    if (escaped === "u") {
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[a-fA-F0-9]{4}$/.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else {
      value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[escaped] ?? escaped;
    }
  }
  return value;
}
