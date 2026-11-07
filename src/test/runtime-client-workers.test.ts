// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../lib/runtime-client";
afterEach(() => vi.unstubAllGlobals());
describe("workers continue during conversation", () => {
  it.each([{active:{id:"job",status:"running"},queued:0},{active:null,queued:1}])("keeps an active same-project worker tree and pending approvals", async (worker) => {
    const request = vi.fn(async () => Response.json({ok:true,agents:[worker],approvals:[{id:"pending"}]}));
    vi.stubGlobal("fetch",request);
    const client = new RuntimeClient("project",async()=>undefined);client.id="session";
    expect(await client.preserveWorkersFor("project")).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/agent/session?id=session");
  });
  it("ends a completed tree so task-scoped grants are discarded with its session", async () => {
    const request = vi.fn(async () => Response.json({ok:true,agents:[{active:null,queued:0}]}));
    vi.stubGlobal("fetch",request);
    const client = new RuntimeClient("project",async()=>undefined);client.id="session";
    expect(await client.preserveWorkersFor("project")).toBe(false);
    expect(request).toHaveBeenLastCalledWith("/api/agent/session?id=session",{method:"DELETE"});
  });
  it("stops the old project when switching workspaces", async () => {
    const request = vi.fn(async()=>Response.json({ok:true}));vi.stubGlobal("fetch",request);
    const client = new RuntimeClient("old-project",async()=>undefined);client.id="session";
    expect(await client.preserveWorkersFor("new-project")).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/agent/session?id=session",{method:"DELETE"});
  });
});
