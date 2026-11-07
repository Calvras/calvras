// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../lib/runtime/agent-runtime";
import { handleAgentApi } from "../lib/runtime/api";

let root: string;
let session: AgentSession;
const infer = vi.fn(async (_prompt: string) => "");
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-worker-question-"));
  infer.mockReset();
  infer.mockResolvedValueOnce(JSON.stringify({message:"I need the intended audience before continuing.",actions:[{type:"ask_user",question:"Who is this page for?",options:["Customers","Staff"]}],status:"continue"}));
  infer.mockResolvedValue(JSON.stringify({message:"The selected audience is confirmed.",actions:[],status:"complete"}));
  session = new AgentSession(root,"full",infer);
});
afterEach(async () => {
  session.stop();
  if (path.resolve(root).startsWith(path.join(os.tmpdir(),"calvras-worker-question-"))) await fs.rm(root,{recursive:true,force:true});
});

describe("subagent necessary questions", () => {
  it("pauses the worker, exposes composer choices and resumes with the actual API answer", async () => {
    const delegated = await session.execute({type:"delegate_task",role:"builder",task:"Determine the intended page audience"});
    await vi.waitFor(() => expect(session.status().questions).toHaveLength(1));
    const question = session.status().questions[0]!;
    expect(question).toMatchObject({question:"Who is this page for?",choices:["Customers","Staff"]});
    expect(infer).toHaveBeenCalledTimes(1);
    expect(session.pool.get(delegated.job.id).status).toBe("running");
    const response = await handleAgentApi(new Request("http://localhost/api/agent/answer",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:session.id,questionId:question.id,answer:"Customers"})}),infer);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ok:true});
    const finished = await session.pool.wait(delegated.job.id,1000);
    expect(finished.status).toBe("finished");
    expect(infer).toHaveBeenCalledTimes(2);
    expect(String(infer.mock.calls[1]?.[0])).toContain("Customers");
    expect(session.status().questions).toHaveLength(0);
    expect(() => session.answerQuestion(question.id,"Staff")).toThrow("no longer pending");
  });
  it("cancels pending questions when the worker is stopped", async () => {
    const delegated = await session.execute({type:"delegate_task",role:"researcher",task:"Determine audience before research"});
    await vi.waitFor(() => expect(session.status().questions).toHaveLength(1));
    await session.execute({type:"cancel_agent",id:delegated.job.id});
    expect((await session.pool.wait(delegated.job.id,1000)).status).toBe("stopped");
    expect(session.status().questions).toHaveLength(0);
    expect(infer).toHaveBeenCalledTimes(1);
  });
});
