import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    maxWorkers: 2,
    environment: "jsdom",
    globals: true,
    // Compiler-backed and accessibility-query tests legitimately run past 5s on a loaded
    // machine; the default budget made the suite fail without anything actually being broken.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
