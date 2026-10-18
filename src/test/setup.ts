import "@testing-library/jest-dom/vitest";

// Node 24 ships a global localStorage stub that shadows jsdom's Storage when
// no --localstorage-file is configured, so install a real in-memory Storage.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.get(key) ?? null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
}

if (typeof window !== "undefined") {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, "localStorage", { configurable: true, value: local });
    Object.defineProperty(target, "sessionStorage", { configurable: true, value: session });
  }
}

if (typeof window !== "undefined") Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

if (typeof window !== "undefined") Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// jsdom has no 2D backend. Returning null keeps a canvas component from painting in a test and
// from logging "Not implemented" for every render; the element contract is what is asserted.
if (typeof window !== "undefined") HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

