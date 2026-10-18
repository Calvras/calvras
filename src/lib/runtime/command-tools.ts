import { createRequire } from "node:module";
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runCommand, startServer, checkServer, stopServer, projectProcessEnv } from '../command-runner';
import { safeProjectPath } from './file-tools';

export const COMMAND_TOOLS=['run_command','run_terminal','run_code','install_dependencies','install_deps','start_dev_server','start_server','check_server','stop_dev_server','get_terminal_output','run_background_process','run_tests','run_single_test','run_linter','run_lint','run_typecheck','run_build','get_errors','get_stack_trace','debug_code','git_status','git_diff','git_show_diff','git_log','git_add','git_commit','git_checkout','git_branch','git_restore','git_push','git_clone'];
type Options={signal?:AbortSignal;onOutput?:(text:string)=>void};
type Result={ok:boolean;output:string;exitCode:number;[key:string]:any};
type Job={id:string;root:string;child:ChildProcess;output:string;running:boolean;exitCode:number|null};
const jobs=new Map<string,Job>(),last=new Map<string,Result>();
const cap=(text:string)=>text.slice(-64000);
function kill(child:ChildProcess) {
  if(!child.pid||child.exitCode!==null)return;
  if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
  else {try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}}
}
async function stopChild(child:ChildProcess) {
  if(child.exitCode!==null)return;
  await new Promise<void>(resolve=>{
    const timer=setTimeout(resolve,5000);
    child.once('close',()=>{clearTimeout(timer);resolve();});
    kill(child);
  });
}
function direct(binary:string,argv:string[],cwd:string,options:Options & {timeoutMs?:number;env?:NodeJS.ProcessEnv}={}):Promise<Result> {
  options.signal?.throwIfAborted();
  return new Promise(resolve=>{
    let output='',timedOut=false,settled=false;
    const child=spawn(binary,argv,{cwd,env:options.env||projectProcessEnv(),windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    const append=(data:any)=>{const text=String(data);output=cap(output+text);options.onOutput?.(text);};
    child.stdout?.on('data',append);child.stderr?.on('data',append);
    const abort=()=>kill(child);options.signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;append('\nExecution timed out.\n');kill(child);},options.timeoutMs??60000);
    const finish=(exitCode:number)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve({ok:exitCode===0&&!timedOut&&!options.signal?.aborted,exitCode,output});};
    child.on('error',e=>{append(e.message);finish(1);});child.on('close',code=>finish(code??1));
  });
}
async function packageInfo(root:string) {
  let pkg:any={};try{pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));}catch{}
  const entries=await fs.readdir(root);
  const manager=typeof pkg.packageManager==='string'?pkg.packageManager.split('@')[0]:entries.includes('pnpm-lock.yaml')?'pnpm':entries.includes('yarn.lock')?'yarn':entries.includes('bun.lockb')||entries.includes('bun.lock')?'bun':'npm';
  if(!['npm','pnpm','yarn','bun'].includes(manager))throw new Error('Unsupported package manager');
  return {manager:manager as string,pkg};
}
function safeArg(value:any,label='argument') {
  const text=String(value??'');if(!text||text.startsWith('-')||/[\0\r\n]/.test(text))throw new Error('Invalid '+label);return text;
}
function shellQuote(value:string) {
  if(process.platform==='win32') {
    // cmd expands percent and delayed exclamation variables even inside quotes.
    if(/["%!\r\n\0]/.test(value))throw new Error('Unsupported characters in package argument');
    return '"'+value+'"';
  }
  return "'"+value.replace(/'/g,"'\\''")+"'";
}
async function startBackground(command:string,root:string,options:Options,args:Record<string,any>) {
  if([...jobs.values()].filter(j=>j.root===root&&j.running).length>=8)throw new Error('At most eight background processes per project');
  options.signal?.throwIfAborted();
  const child=process.platform==='win32'?spawn(process.env['ComSpec']||'cmd.exe',['/d','/s','/c','"'+command+'"'],{cwd:root,env:projectProcessEnv(),windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore','pipe','pipe']}):spawn('/bin/sh',['-c',command],{cwd:root,env:projectProcessEnv(),detached:true,stdio:['ignore','pipe','pipe']});
  const job:Job={id:randomUUID(),root,child,output:'',running:true,exitCode:null};jobs.set(job.id,job);
  const append=(data:any)=>{const text=String(data);job.output=cap(job.output+text);options.onOutput?.(text);};
  child.stdout?.on('data',append);child.stderr?.on('data',append);
  const abort=()=>kill(child);options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{append('\nBackground process reached its time limit.\n');kill(child);},Math.max(1000,Math.min(Number(args['timeoutMs'])||3600000,86400000)));
  timer.unref();
  const finish=(code:number)=>{job.running=false;job.exitCode=code;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);};
  child.on('error',e=>{append(e.message);finish(1);});child.on('close',code=>finish(code??1));
  await new Promise(resolve=>setTimeout(resolve,100));
  return {ok:job.running||job.exitCode===0,output:job.output,exitCode:job.exitCode??0,processId:job.id,pid:child.pid,running:job.running};
}
export async function stopProjectProcesses(projectPath:string) {
  const root=await fs.realpath(projectPath);
  await Promise.all([...jobs.values()].filter(job=>job.root===root&&job.running).map(job=>stopChild(job.child)));
  return stopServer(root);
}

export async function executeCommandTool(type:string,args:Record<string,any>,projectPath:string,options:Options={}):Promise<Result> {
  if(!COMMAND_TOOLS.includes(type))throw new Error('Unsupported command tool: '+type);
  const root=await fs.realpath(projectPath),timeoutMs=Math.max(1000,Math.min(Number(args['timeoutMs']??args['timeout_ms'])||60000,600000));
  const requestedCwd=typeof args['cwd']==='string'&&args['cwd'].trim()?await safeProjectPath(root,args['cwd']):root;
  const save=(result:Result)=>{last.set(root,result);return result;};
  if(type==='get_errors'||type==='get_stack_trace') {
    const previous=last.get(root);return {ok:true,exitCode:0,output:previous&&!previous.ok?previous.output:'No failed command recorded.',lastExitCode:previous?.exitCode??null};
  }
  if(type==='check_server')return checkServer(root);
  if(type==='stop_dev_server') {
    const id=args['processId']??args['process_id'];
    if(id){const job=jobs.get(id);if(!job||job.root!==root)throw new Error('Unknown process for this project');await stopChild(job.child);return {ok:true,exitCode:0,output:'Process stopped.',processId:id,running:false};}
    return stopServer(root);
  }
  if(type==='get_terminal_output') {
    const id=args['processId']??args['process_id'];
    if(id){const job=jobs.get(id);if(!job||job.root!==root)throw new Error('Unknown process for this project');return {ok:job.running||job.exitCode===0,output:job.output,exitCode:job.exitCode??0,running:job.running,processId:id};}
    const server=await checkServer(root);return server.running?server:last.get(root)||{ok:true,output:'No command output yet.',exitCode:0};
  }
  if(type.startsWith('git_')) {
    let argv:string[];
    const file=async()=>path.relative(root,await safeProjectPath(root,String(args['path']||'.')))||'.';
    if(type==='git_commit') {
      const staged=await direct('git',['diff','--cached','--name-only','-z'],root,{...options,timeoutMs});
      if(!staged.ok)return save(staged);
      for(const stagedPath of staged.output.split('\0').filter(Boolean))await safeProjectPath(root,stagedPath,false);
    }
    switch(type){
      case 'git_status':argv=['status','--short'];break;
      case 'git_diff':case 'git_show_diff':argv=['diff',...(args['staged']?['--cached']:[]),'--',await file()];break;
      case 'git_log':argv=['log','--oneline','-n',String(Math.max(1,Math.min(Number(args['limit'])||20,100)))];break;
      case 'git_add':{
        const requested=await file();
        const listing=await direct('git',['ls-files','--cached','--others','--exclude-standard','-z','--',requested],root,{...options,timeoutMs});
        if(!listing.ok)return save(listing);
        const allowed:string[]=[];
        for(const candidate of listing.output.split('\0').filter(Boolean)) {
          try {await safeProjectPath(root,candidate,false);allowed.push(candidate);}catch{/* Protect environment files even for a directory-wide add. */}
        }
        if(!allowed.length)return save({ok:true,exitCode:0,output:'No unprotected files to stage.'});
        if(allowed.length>1000)throw new Error('Stage at most 1000 files per operation');
        argv=['add','--',...allowed];break;
      }
      case 'git_commit':argv=['commit','-m',String(args['message']||'Calvras changes')];break;
      case 'git_checkout':argv=['checkout',...(args['create']?['-b']:[]),safeArg(args['branch'],'branch')];break;
      case 'git_branch':argv=args['name']?['branch',safeArg(args['name'],'branch')]:['branch','--list'];break;
      case 'git_restore':argv=['restore',...(args['staged']?['--staged']:[]),'--',await file()];break;
      case 'git_push':argv=['push',safeArg(args['remote']||'origin','remote'),...(args['branch']?[safeArg(args['branch'],'branch')]:[])];break;
      case 'git_clone':{
        const destination=await safeProjectPath(root,String(args['destination']||args['path']||'cloned-project'),false);
        const url=safeArg(args['url'],'repository URL');
        if(!/^(https:\/\/|ssh:\/\/|git@)/.test(url))throw new Error('Use an HTTPS or SSH repository URL');
        argv=['clone','--',url,destination];break;
      }
      default:throw new Error('Unsupported git operation');
    }
    return save(await direct('git',argv,root,{...options,timeoutMs}));
  }
  if(type==='run_code'||type==='debug_code') {
    const language=String(args['language']||'javascript').toLowerCase();
    if(!['javascript','js','typescript','ts','python','py'].includes(language))throw new Error('Supported code languages: JavaScript, TypeScript, Python');
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),'calvras-code-'));
    try {
      let code=String(args['code']??args['content']??'');
      if(args['path'])code=await fs.readFile(await safeProjectPath(root,args['path']),'utf8');
      if(language==='typescript'||language==='ts'){const ts:typeof import('typescript')=createRequire(import.meta.url)('typescript');code=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;}
      const python=language==='python'||language==='py',file=path.join(temp,python?'main.py':'main.mjs');await fs.writeFile(file,code);
      const binary=python?(process.platform==='win32'?'python':'python3'):process.execPath;
      return save(await direct(binary,[...(!python&&type==='debug_code'?['--trace-uncaught']:[]),file],root,{...options,timeoutMs,env:{...projectProcessEnv(),ELECTRON_RUN_AS_NODE:'1'}}));
    } finally {await fs.rm(temp,{recursive:true,force:true});}
  }
  const {manager,pkg}=await packageInfo(root);
  const pmRun=(script:string)=>`${manager} run ${shellQuote(script)}`;
  let command=String(args['command']||'');
  if(type==='install_dependencies'||type==='install_deps') {
    const dependencies=args['packages']??args['dependencies']??[];
    if(!Array.isArray(dependencies))throw new Error('packages must be an array');
    const names=dependencies.map((name:any)=>{const value=safeArg(name,'package name');if(!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:@[^\s"'%!;&|<>]+)?$/i.test(value))throw new Error('Invalid package name');return shellQuote(value);});
    command=`${manager} ${names.length?(manager==='npm'?'install':'add'):'install'}${args['dev']?(manager==='npm'?' --save-dev':' --dev'):''}${names.length?' '+names.join(' '):''}`;
  }
  const scripts:Record<string,string>={run_tests:'test',run_single_test:'test',run_linter:'lint',run_lint:'lint',run_typecheck:'typecheck',run_build:'build'};
  if(scripts[type]) {
    const script=scripts[type]!;
    if(pkg.scripts?.[script])command=pmRun(script);
    // tsc only means something when the project actually configures TypeScript; otherwise the
    // run fails on a bogus "not the tsc command" error and the agent loses a round.
    else if(type==='run_typecheck') {
      const configured=await fs.stat(path.join(root,'tsconfig.json')).then(()=>true,()=>false);
      const deps=pkg as any;
      if(!configured&&!deps.devDependencies?.typescript&&!deps.dependencies?.typescript)return save({ok:false,exitCode:0,output:'This project has no TypeScript setup (no tsconfig.json, no typescript package). Verify with run_tests or by executing the code instead.'});
      command='npx --no-install tsc --noEmit';
    }
    else return save({ok:false,exitCode:1,output:`No ${script} script exists in package.json.`});
    if(type==='run_single_test') {
      if(!args['path']&&!args['test'])throw new Error('A test path is required');
      const test=path.relative(root,await safeProjectPath(root,String(args['path']||args['test'])));
      command+=' -- '+shellQuote(test);
    }
  }
  if(type==='start_dev_server'||type==='start_server') {
    if(!command) {
      const script=pkg.scripts?.dev?'dev':pkg.scripts?.start?'start':null;
      if(!script)return save({ok:false,exitCode:1,output:'No dev or start script exists. Supply a command.'});
      command=pmRun(script);
    }
    return save(await startServer(command,root,{...options,waitMs:Math.min(Number(args['waitMs'])||8000,15000)}));
  }
  if(!command.trim())throw new Error('A command is required');
  if(type==='run_background_process')return save(await startBackground(command,requestedCwd,options,args));
  return save(await runCommand(command,requestedCwd,{...options,timeoutMs}));
}
