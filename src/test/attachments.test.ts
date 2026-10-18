import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeAttachments } from "../lib/runtime/attachments";

let vault: string | undefined;
afterEach(async () => {
  delete process.env["CALVRAS_ATTACHMENTS_DIR"];
  if (vault) await rm(vault, { recursive: true, force: true });
  vault = undefined;
});

describe("attachment vault", () => {
  it("stores attachments without a project folder", async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), "calvras-vault-"));
    process.env["CALVRAS_ATTACHMENTS_DIR"] = vault;
    const [file] = await storeAttachments(undefined, [{
      name: "Emmanuel_Daniel_CV.pdf",
      type: "application/pdf",
      dataUrl: `data:application/pdf;base64,${Buffer.from("pdf bytes").toString("base64")}`,
      text: "Emmanuel Daniel — CV",
    }]);
    expect(file?.scope).toBe("vault");
    expect(file?.relativePath).toBe(file?.path);
    expect(await readFile(file!.path, "utf8")).toBe("pdf bytes");
    expect(await readFile(file!.textPath!, "utf8")).toBe("Emmanuel Daniel — CV");
  });
});
