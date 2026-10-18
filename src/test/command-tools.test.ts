// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { executeCommandTool, stopProjectProcesses } from '../lib/runtime/command-tools';
let root:string;
const call=(type:string,args:Record<string,any>={},options:any={}):Promise<any>=>executeCommandTool(type,args,root,options);
const node=(code:string)=>`"${process.execPath}" -e "${code}"`;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'calvras-commands-'));});
afterEach(async()=>{await stopProjectProcesses(root);await new Promise(resolve=>setTimeout(resolve,150));await fs.rm(root,{recursive:true,force:true});});
describe('command tools',()=>{
  it('runs finite commands and streams their real output',async()=>{
    const output:string[]=[];
    const result=await call('run_command',{command:node("console.log('hello')")},{onOutput:(text:string)=>output.push(text)});
    expect(result.ok).toBe(true);expect(result.output).toContain('hello');expect(output.join('')).toContain('hello');
    expect((await call('get_terminal_output')).output).toContain('hello');
  });
  it('executes JavaScript and TypeScript rather than returning suggested code',async()=>{
    expect((await call('run_code',{language:'js',code:'console.log(6 * 7)'})).output).toContain('42');
    expect((await call('run_code',{language:'ts',code:'const value: number = 8; console.log(value)'})).output).toContain('8');
  });
  it('returns actual failures and captured stack traces',async()=>{
    const result=await call('debug_code',{language:'js',code:'throw new Error("fixture failure")'});
    expect(result.ok).toBe(false);expect(result.output).toContain('fixture failure');
    expect((await call('get_stack_trace')).output).toContain('Error: fixture failure');
  });
  it('times out commands and supports cancellation',async()=>{
    const timed=await call('run_command',{command:node('setInterval(()=>{},1000)'),timeoutMs:1000});
    expect(timed.ok).toBe(false);expect(timed.output).toContain('timed out');
    const controller=new AbortController();controller.abort();
    await expect(call('run_code',{code:'console.log(1)'},{signal:controller.signal})).rejects.toThrow();
  });
  it('tracks background logs and stops only the selected process',async()=>{
    const job=await call('run_background_process',{command:node("console.log('running');setInterval(()=>{},1000)")});
    expect(job.running).toBe(true);expect(job.processId).toBeTruthy();
    for(let i=0;i<30;i++){if((await call('get_terminal_output',{processId:job.processId})).output.includes('running'))break;await new Promise(resolve=>setTimeout(resolve,100));}
    expect((await call('get_terminal_output',{processId:job.processId})).output).toContain('running');
    await call('stop_dev_server',{processId:job.processId});
    for(let i=0;i<30;i++){if(!(await call('get_terminal_output',{processId:job.processId})).running)break;await new Promise(resolve=>setTimeout(resolve,100));}
    expect((await call('get_terminal_output',{processId:job.processId})).running).toBe(false);
  });
  it('starts a real HTTP server, verifies its response, then stops it',async()=>{
    const code="const http=require('http');const s=http.createServer((q,r)=>r.end('ready'));s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port))";
    const result=await call('start_dev_server',{command:node(code),waitMs:5000});
    expect(result.running).toBe(true);expect(result.ready).toBe(true);
    expect(await (await fetch(result['url'])).text()).toBe('ready');
    await call('stop_dev_server');expect((await call('check_server')).running).toBe(false);
  });
  it('runs package scripts and reports absent scripts without pretending success',async()=>{
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node -e "console.log(123)"'}}));
    expect((await call('run_tests')).output).toContain('123');
    expect((await call('run_build')).ok).toBe(false);
    await expect(call('install_dependencies',{packages:['x;echo secret']})).rejects.toThrow('Invalid');
  });
  it('points a JavaScript-only project at a real verification instead of running tsc',async()=>{
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'plain',scripts:{test:'node -e "console.log(123)"'}}));
    const result=await call('run_typecheck');
    expect(result.output).toContain('no TypeScript setup');
    expect(result.output).not.toContain('tsc --noEmit');
  });
  it('uses direct git argv for real status/add/commit/log/diff operations',async()=>{
    execFileSync('git',['init'],{cwd:root,stdio:'ignore'});
    execFileSync('git',['config','user.name','Fixture'],{cwd:root});execFileSync('git',['config','user.email','fixture@example.test'],{cwd:root});
    await fs.writeFile(path.join(root,'a.txt'),'first');
    expect((await call('git_status')).output).toContain('a.txt');
    expect((await call('git_add',{path:'a.txt'})).ok).toBe(true);
    expect((await call('git_commit',{message:'literal $(echo no execution)'})).ok).toBe(true);
    expect((await call('git_log')).output).toContain('$(echo no execution)');
    await fs.writeFile(path.join(root,'a.txt'),'second');expect((await call('git_diff',{path:'a.txt'})).output).toContain('+second');
    await call('git_restore',{path:'a.txt'});expect(await fs.readFile(path.join(root,'a.txt'),'utf8')).toBe('first');
    await expect(call('git_checkout',{branch:'--orphan'})).rejects.toThrow('Invalid');
  });
});
