// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalNeeded, PermissionScope, actionRisk } from '../lib/runtime/permissions';
import type { ToolAction } from '../lib/tool-catalog';
const request=(scope:PermissionScope,action:ToolAction)=>{
  try{scope.require(action);}catch(error){if(error instanceof ApprovalNeeded)return error.approval;throw error;}
  throw new Error('Expected approval');
};
afterEach(()=>vi.useRealTimers());
describe('permission enforcement',()=>{
  it('allows read operations and asks before edits in Ask first mode',()=>{
    const p=new PermissionScope('ask');expect(()=>p.require({type:'read_file',path:'a.ts'})).not.toThrow();
    expect(request(p,{type:'write_file',path:'a.ts',content:'x'}).status).toBe('pending');
  });
  it('buys the workspace and the terminal in Full access but still asks before removing work',()=>{
    const p=new PermissionScope('full');
    expect(()=>p.require({type:'run_build'})).not.toThrow();
    expect(()=>p.require({type:'run_command',command:'npm install left-pad'})).not.toThrow();
    expect(()=>p.require({type:'run_command',command:'node -v'})).not.toThrow();
    expect(()=>p.require({type:'github_request',endpoint:'/user'})).not.toThrow();
    expect(()=>p.require({type:'open_app',app:'chrome'})).not.toThrow();
    expect(()=>p.require({type:'run_command',command:'git reset --hard'})).not.toThrow();
    expect(()=>p.require({type:'git_push'})).not.toThrow();
    expect(()=>p.require({type:'deploy_application',command:'vercel deploy'})).not.toThrow();
    expect(()=>p.require({type:'request_user_approval',question:'Which repo?'})).not.toThrow();
    // Editing the folder is part of the deal now: a new file, a rewrite and a patch all run free.
    for(const action of [{type:'write_file',path:'a.ts',content:'x'},{type:'create_file',path:'b.ts',content:'x'},{type:'search_replace',path:'a.ts',search:'x',replace:'y'}] as ToolAction[]){
      expect(()=>p.require(action)).not.toThrow();
    }
    // What it takes back is work that already exists, and a worker living outside this folder.
    // Removing one file inside the folder is part of the deal: a build that cannot clean up its
    // own scratch file never finishes. Discarding work the user did not name still asks.
    expect(() => p.require({ type: "delete_file", path: "a.ts" })).not.toThrow();
    expect(request(p, { type: "rollback_changes", checkpointId: "cp-1" }).status).toBe("pending");
    expect(request(p, { type: "git_restore", path: "a.ts" }).status).toBe("pending");
    expect(request(p, { type: "undo_edit", checkpointId: "cp-1" }).status).toBe("pending");
    expect(request(p, { type: "resolve_worker", id: "job-1", action: "apply" }).status).toBe("pending");
    // use_user_file has its own native confirm, and these two never touch a user file.
    expect(()=>p.require({type:'use_user_file',path:'C:\\Users\\me\\Documents\\CV.pdf'})).not.toThrow();
    expect(()=>p.require({type:'write_memory',key:'stack',value:'vite'})).not.toThrow();
  });
  it('takes the decision from a control the person pressed instead of asking them twice',()=>{
    const p=new PermissionScope('full');
    expect(()=>p.require({type:'resolve_worker',id:'job-1',action:'apply'},undefined,false,true)).not.toThrow();
    expect(()=>p.require({type:'undo_edit',checkpointId:'cp-1'},undefined,false,true)).not.toThrow();
    // The same action without their click, or in another mode, is still the agent acting alone.
    expect(request(p,{type:'resolve_worker',id:'job-2',action:'apply'}).status).toBe('pending');
  });
  it('asks for unknown shell commands in Automatic mode',()=>{
    expect(request(new PermissionScope('automatic'),{type:'run_command',command:'node strange-script.js'}).status).toBe('pending');
  });
  it('keeps an Always allow answer silent, and a Settings ask rule loud, whatever the preset',()=>{
    // "Always allow" on an approval card writes exactly this rule, so the click has to hold for
    // the tool that was asked about — including one the risk table calls destructive.
    const allowed=new PermissionScope('automatic',{toolRules:{delete_file:'allow'}});
    expect(()=>allowed.require({type:'delete_file',path:'build'})).not.toThrow();
    const gated=new PermissionScope('full',{toolRules:{delete_file:'ask'}});
    expect(request(gated,{type:'delete_file',path:'build'}).status).toBe('pending');
  });
  it('binds one-use tokens to the full nested action and stable object order',()=>{
    const p=new PermissionScope('ask');
    const action:ToolAction={type:'configure_mcp',config:{command:'node',args:['safe.js'],env:{MODE:'safe'}}};
    const approval=request(p,action),token=p.decision(approval.id,'once').token!;
    expect(()=>p.require({config:{env:{MODE:'safe'},args:['safe.js'],command:'node'},type:'configure_mcp'},token)).not.toThrow();
    expect(()=>p.require(action,token)).toThrow('already used');
    const next=request(p,action),nextToken=p.decision(next.id,'once').token!;
    expect(()=>p.require({...action,config:{command:'node',args:['evil.js'],env:{MODE:'safe'}}},nextToken)).toThrow('exact action');
  });
  it('keeps the pending action immutable when the original object changes',()=>{
    const p=new PermissionScope('ask');const action:ToolAction={type:'call_mcp_tool',arguments:{path:'safe'}};
    const approval=request(p,action);action['arguments'].path='unsafe';
    const token=p.decision(approval.id,'once').token!;
    expect(()=>p.require(action,token)).toThrow('exact action');
  });
  it('does not let a task grant bypass a destructive or external shell command',()=>{
    const p=new PermissionScope('automatic');
    const safe:ToolAction={type:'run_command',command:'node --version'};
    const allowed=request(p,safe);p.decision(allowed.id,'task');
    expect(()=>p.require({type:'run_command',command:'node -v'})).not.toThrow();
    expect(request(p,{type:'run_command',command:'rm -rf src'}).status).toBe('pending');
    expect(request(p,{type:'run_command',command:'curl https://example.com'}).status).toBe('pending');
  });
  it('does not issue task grants for destructive commands classified as execute tools',()=>{
    const p=new PermissionScope('automatic');const a:ToolAction={type:'run_command',command:'Remove-Item -Recurse src'};
    p.decision(request(p,a).id,'task');
    expect(request(p,{type:'run_command',command:'Remove-Item -Recurse other'}).status).toBe('pending');
  });
  it('remembers denial for the same exact action and never creates a second prompt',()=>{
    const p=new PermissionScope('ask'),action:ToolAction={type:'write_file',path:'a.ts',content:'x'};
    p.decision(request(p,action).id,'deny');
    expect(()=>p.require(action)).toThrow('user denied');expect(p.list()).toHaveLength(1);
    p.mode='full';expect(()=>p.require(action)).toThrow('user denied');
  });
  it('reuses pending prompts and rejects stale decisions and expired tokens',()=>{
    vi.useFakeTimers();const p=new PermissionScope('ask'),a:ToolAction={type:'write_file',path:'a',content:'x'};
    const approval=request(p,a);expect(request(p,a).id).toBe(approval.id);
    const token=p.decision(approval.id,'once').token!;expect(()=>p.decision(approval.id,'once')).toThrow('no longer pending');
    vi.advanceTimersByTime(31*60*1000);expect(()=>p.require(a,token)).toThrow('expired');expect(p.list()).toHaveLength(0);
  });
  it('bounds pending approval accumulation to 500 requests',()=>{
    const p=new PermissionScope('ask');for(let i=0;i<500;i++)request(p,{type:'write_file',path:`${i}.ts`,content:'x'});
    expect(()=>p.require({type:'write_file',path:'overflow',content:'x'})).toThrow('Too many pending');expect(p.list()).toHaveLength(500);
  });
  it('requires approval for explicit destructive flags and code deletion calls',()=>{
    expect(actionRisk({type:'run_command',command:'custom-helper',destructive:true}).destructive).toBe(true);
    expect(actionRisk({type:'run_code',code:'fs.rmSync("src",{recursive:true})'}).destructive).toBe(true);
  });
  it('revokes outstanding approvals and grants on task cancellation',()=>{
    const p=new PermissionScope('ask'),a:ToolAction={type:'write_file',path:'a',content:'x'};
    const token=p.decision(request(p,a).id,'task').token!;p.denyPending();
    expect(()=>p.require(a,token)).toThrow('expired');expect(request(p,{...a,path:'b'}).status).toBe('pending');
  });
});
