// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { batchCounts, batchStatus, claimBatch, enqueueBatch, readBatch, reportBatch, targetKey } from "../lib/runtime/batch-queue";

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "calvras-batch-"));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const postings = (count: number, host = "acme.test/jobs") =>
  Array.from({ length: count }, (_, index) => ({ url: `https://${host}/${index + 1}`, label: `Role ${index + 1}` }));

describe("batch ledger", () => {
  it("ignores the same link wearing different tracking parameters", async () => {
    expect(targetKey("https://www.Acme.test/jobs/7/?utm_source=linkedin&ref=gh#apply"))
      .toBe(targetKey("https://acme.test/jobs/7"));
    const root = await project();
    await enqueueBatch(root, "Acme roles", [{ url: "https://acme.test/jobs/7", label: "Role 7" }]);
    const again = await enqueueBatch(root, "Acme roles", [
      { url: "https://www.acme.test/jobs/7/?utm_source=google", label: "Role 7 again" },
      { url: "https://acme.test/jobs/8", label: "Role 8" },
    ]);
    expect(again.added).toBe(1);
    expect(again.duplicate).toBe(1);
    expect(again.total).toBe(2);
  });

  it("hands out chunks without ever giving the same target twice", async () => {
    const root = await project();
    await enqueueBatch(root, "Sweep", postings(7));
    const first = await claimBatch(root, 3);
    expect(first.claimed.map((item) => item.id)).toEqual(["acme.test/jobs/1", "acme.test/jobs/2", "acme.test/jobs/3"]);
    expect(first.queued).toBe(4);
    expect(first.running).toBe(3);
    const second = await claimBatch(root, 3);
    expect(second.claimed.map((item) => item.id)).toEqual(["acme.test/jobs/4", "acme.test/jobs/5", "acme.test/jobs/6"]);
    // A claim caps at ten targets so one round cannot swallow the whole queue.
    // Only untouched targets are handed out, so the last claim takes the one target left.
    expect((await claimBatch(root, 50)).claimed.map((item) => item.id)).toEqual(["acme.test/jobs/7"]);
  });

  it("records the outcome the site reported and keeps the queue honest", async () => {
    const root = await project();
    await enqueueBatch(root, "Sweep", postings(3));
    await claimBatch(root, 2);
    const done = await reportBatch(root, "acme.test/jobs/1", "done", "submitted", "APP-4471");
    expect(done.done).toBe(1);
    expect(done.running).toBe(1);
    expect(done.reference).toBe("APP-4471");
    expect(done.next.map((item) => item.id)).toEqual(["acme.test/jobs/3"]);
    const blocked = await reportBatch(root, "acme.test/jobs/2", "blocked", "needs a captcha");
    expect(blocked.blocked).toBe(1);
    expect(blocked.queued).toBe(1);
    await expect(reportBatch(root, "acme.test/jobs/99", "done")).rejects.toThrow(/No batch target/);
  });

  it("survives a restart and refuses to re-apply to finished targets", async () => {
    const root = await project();
    await enqueueBatch(root, "Sweep", postings(4));
    await claimBatch(root, 2);
    await reportBatch(root, "acme.test/jobs/1", "done", "", "APP-1");
    await reportBatch(root, "acme.test/jobs/2", "skipped", "already applied last month");
    // A later conversation reads the same file rather than a fresh in-memory copy.
    const reopened = await claimBatch(root, 3);
    expect(reopened.claimed.map((item) => item.id)).toEqual(["acme.test/jobs/3", "acme.test/jobs/4"]);
    const status = await batchStatus(root);
    expect(status.done).toBe(1);
    expect(status.skipped).toBe(1);
    expect(status.problems).toEqual([
      expect.objectContaining({ id: "acme.test/jobs/2", note: "already applied last month" }),
    ]);
    expect(status.completed[0]).toEqual(expect.objectContaining({ reference: "APP-1" }));
  });

  it("keeps a thousand targets readable by summarising instead of dumping", async () => {
    const root = await project();
    await enqueueBatch(root, "Big sweep", postings(1_000));
    // Asking for fifty still claims ten: one round cannot swallow the queue.
    await claimBatch(root, 50);
    const status = await batchStatus(root);
    expect(status.total).toBe(1_000);
    expect(status.queued).toBe(990);
    expect(status.pending).toHaveLength(10);
    expect(JSON.stringify(status).length).toBeLessThan(6_000);
    const stored = JSON.parse(await readFile(path.join(root, ".calvras", "batch.json"), "utf8"));
    expect(stored.items).toHaveLength(1_000);
    expect(batchCounts(stored.items).running).toBe(10);
  });

  it("does not lose a report when two workers write at the same moment", async () => {
    const root = await project();
    await enqueueBatch(root, "Sweep", postings(3));
    await claimBatch(root, 3);
    await Promise.all([
      reportBatch(root, "acme.test/jobs/1", "done", "", "A"),
      reportBatch(root, "acme.test/jobs/2", "done", "", "B"),
      reportBatch(root, "acme.test/jobs/3", "blocked", "site down"),
    ]);
    const batch = await readBatch(root);
    expect(batch.items.map((item) => item.status)).toEqual(["done", "done", "blocked"]);
    expect(batch.items.map((item) => item.reference)).toEqual(["A", "B", ""]);
  });

  it("starts empty without a file and tolerates a damaged ledger", async () => {
    const root = await project();
    expect((await batchStatus(root)).total).toBe(0);
    await mkdir(path.join(root, ".calvras"), { recursive: true });
    await writeFile(path.join(root, ".calvras", "batch.json"), JSON.stringify({ items: "not an array" }), "utf8");
    expect((await readBatch(root, "Fallback")).items).toEqual([]);
  });
});
