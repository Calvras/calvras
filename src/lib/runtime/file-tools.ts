import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileDiff } from '../file-diff';

export const FILE_TOOLS = ['read_file','read_image','write_file','create_file','list_files','list_dir','rename_file','move_file','copy_file','delete_file','get_file_info','directory_tree','grep_search','search_files','find_files','search_replace','multi_replace','insert_code','delete_lines','undo_edit','apply_patch','apply_diff','format_file','format_code','multi_file_edit','rollback_changes','create_checkpoint','list_checkpoints'];
const MAX_BYTES = 2 * 1024 * 1024;
const ignored = new Set(['node_modules','.git','.output','dist','build','.next']);
const secret = (p: string) => p.split(/[\\/]/).some(s => /^\.git$/i.test(s) || /^\.env($|\.)/i.test(s) && !/\.(example|sample|template)$/i.test(s) || /^(id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.json)$/i.test(s) || /\.(pem|p12|pfx|key)$/i.test(s));
const inside = (root: string, target: string) => { const rel = path.relative(root,target); return rel === '' || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };

/** Validate every existing ancestor, including junctions and symlinked parent directories. */
export async function safeProjectPath(project: string, input: string, allowRoot = true) {
  const root = await fs.realpath(project);
  const target = path.resolve(root,input || '.');
  if (!inside(root,target) || (!allowRoot && root === target)) throw new Error('Path must remain inside the project and cannot target its root');
  if (secret(path.relative(root,target))) throw new Error('Secret and environment files are protected');
  let cursor = target;
  while (true) {
    try {
      const resolved = await fs.realpath(cursor);
      if (!inside(root,resolved) || secret(path.relative(root,resolved))) throw new Error('Path resolves outside the project or into a protected file');
      break;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  return target;
}

async function read(target: string): Promise<string | null> {
  const buffer = await readBytes(target);
  return buffer === null ? null : buffer.toString('utf8');
}
/** Raw bytes, so a checkpoint can put a file back exactly as it found it. */
async function readBytes(target: string): Promise<Buffer | null> {
  try {
    const st = await fs.stat(target);
    if (!st.isFile()) throw new Error('Expected a file');
    if (st.nlink > 1) throw new Error('Hardlinked files are protected to avoid reading or changing shared external files');
    if (st.size > MAX_BYTES) throw new Error('File exceeds the 2 MiB tool limit');
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) throw new Error('Binary file is not supported by text editing tools');
    return buffer;
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeBack(target: string, text: string, exact: string | undefined): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  // A file that is not valid UTF-8 comes back as the bytes that were there, not as the
  // decoded string, which would have replaced every unreadable byte with U+FFFD.
  await (exact === undefined ? fs.writeFile(target, text, 'utf8') : fs.writeFile(target, Buffer.from(exact, 'base64')));
}
type Change = { path: string; before: string | null; after: string | null; beforeBytes?: string; afterBytes?: string };
type Checkpoint = { id: string; root: string; createdAt: string; seq: number; changes: Change[]; restored?: boolean; snapshot?: boolean; label?: string };
/**
 * Undo has to replay edits in the exact order they happened. createdAt only reaches
 * milliseconds and a run of file tools lands well inside that, so ordering falls back on
 * this strictly increasing stamp instead of the timestamp.
 */
let lastSeq = 0;
function monotonicSeq() {
  const now = Date.now();
  lastSeq = now > lastSeq ? now : lastSeq + 1;
  return lastSeq;
}
async function checkpointDir(root: string) {
  const dir = path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(),'.local','share'),'Calvras','checkpoints',createHash('sha256').update(root).digest('hex'));
  await fs.mkdir(dir,{recursive:true,mode:0o700}); return dir;
}
export async function listCheckpoints(projectPath: string) {
  const root=await fs.realpath(projectPath),dir=await checkpointDir(root);
  const records=await Promise.all((await fs.readdir(dir)).filter(p=>/^[\da-f-]{36}\.json$/i.test(p)).map(async p=>JSON.parse(await fs.readFile(path.join(dir,p),'utf8')) as Checkpoint));
  return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(r=>({id:r.id,createdAt:r.createdAt,restored:!!r.restored,snapshot:!!r.snapshot,label:r.label,files:r.changes.map(c=>path.relative(root,c.path))}));
}
/** Persist a bounded text snapshot before major operations; secrets and generated files are excluded. */
export async function createProjectCheckpoint(projectPath: string,label='Project checkpoint') {
  const root=await fs.realpath(projectPath),entries=await walk(root,'.',2000),changes:Change[]=[];
  let bytes=0;
  for (const entry of entries.filter(e=>e.type==='file')) {
    const target=await safeProjectPath(root,entry.path,false);
    let content:string|null;
    try {content=await read(target);} catch {continue;}
    if(content===null)continue;
    bytes+=Buffer.byteLength(content);
    if(bytes>20*1024*1024)throw new Error('Project snapshot exceeds 20 MiB; snapshot selected files instead');
    changes.push({path:target,before:content,after:content});
  }
  if(entries.length>=2000)throw new Error('Project snapshot exceeds 2000 entries; select a smaller project');
  const record:Checkpoint={id:randomUUID(),root,createdAt:new Date().toISOString(),seq:monotonicSeq(),changes,snapshot:true,label};
  await fs.writeFile(path.join(await checkpointDir(root),record.id+'.json'),JSON.stringify(record),{mode:0o600});
  return {ok:true,checkpointId:record.id,fileCount:changes.length,label};
}
async function commit(root: string, changes: Change[], options: { restored?: boolean } = {}) {
  if (!changes.length) return {ok:true,changes:[]};
  const seen = new Set<string>();
  for (const c of changes) {
    c.path = await safeProjectPath(root,c.path,false);
    if (seen.has(c.path)) throw new Error('A transaction cannot edit the same path twice');
    seen.add(c.path);
    if (Buffer.byteLength(c.after || '') > MAX_BYTES) throw new Error('File exceeds the 2 MiB tool limit');
    if (c.after !== null) await assertNoSecretLiteral(root, c.path, c.after);
    const standing = await readBytes(c.path);
    if ((standing?.toString('utf8') ?? null) !== c.before) throw new Error('File changed while preparing edit; inspect it again');
    // Keep the bytes as they are on disk right now. Decoding to a string and back is only
    // lossless for valid UTF-8, and undo has to put the file back exactly, not approximately.
    if (standing && c.beforeBytes === undefined) c.beforeBytes = standing.toString('base64');
  }
  const record: Checkpoint = {id:randomUUID(),root,createdAt:new Date().toISOString(),seq:monotonicSeq(),changes,...(options.restored?{restored:true}:{})};
  const dir = await checkpointDir(root);
  await fs.writeFile(path.join(dir,record.id+'.json'),JSON.stringify(record),{mode:0o600});
  const completed: Change[] = [];
  try {
    for (const c of changes) {
      await safeProjectPath(root,c.path,false);
      if (await read(c.path) !== c.before) throw new Error('File changed before write');
      if (c.after === null) await fs.unlink(c.path);
      else await writeBack(c.path, c.after, c.afterBytes);
      completed.push(c);
    }
  } catch (error) {
    for (const c of completed.reverse()) {
      if (c.before === null) await fs.unlink(c.path); else await writeBack(c.path,c.before,c.beforeBytes);
    }
    await fs.unlink(path.join(dir,record.id+'.json'));
    throw error;
  }
  return {ok:true,checkpointId:record.id,changes:changes.map(c=>({path:path.relative(root,c.path),diffRows:fileDiff(c.before||'',c.after||'')})),diffRows:changes.length===1?fileDiff(changes[0]!.before||'',changes[0]!.after||''):undefined};
}
/**
 * Replays one checkpoint backwards. The record it writes for the restore is itself marked
 * already-restored, because a second bare "undo" must keep walking further back instead of
 * re-applying the change it has just taken away.
 */
async function restoreOne(root: string, dir: string, cp: Checkpoint, args: Record<string, any>) {
  if (cp.root !== root || cp.restored) throw new Error('Checkpoint is unavailable or already restored');
  const changes: Change[] = [];
  for (const c of cp.changes) {
    await safeProjectPath(root, c.path, false);
    const current = await read(c.path);
    if (current !== c.after && !(cp.snapshot && args['allowOverwrite'] === true)) throw new Error('Rollback would overwrite subsequent changes; inspect the diff first. Project snapshots require explicit allowOverwrite');
    changes.push({ path: c.path, before: current, after: c.before, ...(c.beforeBytes === undefined ? {} : { afterBytes: c.beforeBytes }) });
  }
  const result = await commit(root, changes, { restored: true });
  cp.restored = true;
  await fs.writeFile(path.join(dir, cp.id + '.json'), JSON.stringify(cp), { mode: 0o600 });
  return result;
}
async function walk(root: string, input = '.', limit = 2000) {
  const base = await safeProjectPath(root,input); const entries: {path:string;type:string;size?:number}[]=[];
  async function visit(dir: string,depth: number) {
    if (depth > 15 || entries.length >= limit) return;
    for (const e of await fs.readdir(dir,{withFileTypes:true})) {
      if (entries.length >= limit) return;
      if (ignored.has(e.name) || secret(e.name) || e.isSymbolicLink()) continue;
      const target = await safeProjectPath(root,path.join(dir,e.name));
      entries.push({path:path.relative(root,target),type:e.isDirectory()?'directory':'file'});
      if (e.isDirectory()) await visit(target,depth+1);
    }
  }
  await visit(base,0); return entries;
}
function replace(content: string,args: Record<string,any>) {
  const old = args['oldText'] ?? args['search'] ?? args['old_string'] ?? args['old'];
  const next = args['newText'] ?? args['replace'] ?? args['new_string'] ?? args['new'] ?? '';
  if (typeof old !== 'string' || !old) throw new Error('A nonempty search string is required');
  const count = content.split(old).length-1;
  if (!count) throw new Error('Search text was not found');
  if (count > 1 && !args['replaceAll'] && !args['all']) throw new Error('Search is ambiguous; supply more context or replaceAll');
  return args['replaceAll'] || args['all'] ? content.split(old).join(next) : content.replace(old,()=>next);
}
/** A key that ships inside source reaches the browser bundle and the repository, so the
 * literal is refused and the agent reads it from the environment instead. */
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/];
async function secretValuesInEnv(root: string) {
  const values: string[] = [];
  for (const name of ['.env.local', '.env', '.env.development', '.env.test']) {
    const text = await fs.readFile(path.join(root, name), 'utf8').catch(() => null);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      const value = (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+?)\s*$/.exec(line)?.[1] ?? '').replace(/^["']|["']$/g, '');
      if (value.length >= 12 && !value.startsWith('${')) values.push(value);
    }
  }
  return values;
}
async function assertNoSecretLiteral(root: string, target: string, content: string) {
  const rel = path.relative(root, target).replace(/\\/g, '/');
  if (!rel || rel.startsWith('.calvras/') || /\.(md|txt|log|snap|svg|lock)$/i.test(rel)) return;
  const embedded = (await secretValuesInEnv(root)).find((value) => content.includes(value)) ?? SECRET_SHAPES.find((shape) => shape.test(content));
  if (!embedded) return;
  throw new Error(`${rel} embeds a secret value. A key belongs only in .env.local via manage_environment_variables, and code must read it with process.env.VARIABLE_NAME — with no fallback literal holding the key. Replace the value in ${rel} with the environment lookup and re-run the edit.`);
}
/** Overwriting a whole existing file is how unrelated work quietly disappears, so a
 * near-total rewrite has to be asked for explicitly instead of happening by accident. */
function assertTargetedEdit(rel: string, before: string | null, after: string, overwrite?: unknown) {
  if (before === null || overwrite) return;
  const oldLines = before.split('\n');
  if (oldLines.length <= 20) return;
  const recognised = new Set(oldLines.map((line) => line.trim()).filter((line) => line.length > 3));
  const kept = after.split('\n').map((line) => line.trim()).filter((line) => line.length > 3);
  const retention = kept.length ? kept.filter((line) => recognised.has(line)).length / kept.length : 1;
  if (retention >= 0.6) return;
  throw new Error(`Replacing ${rel} wholesale would discard ${Math.round((1 - retention) * 100)}% of its ${oldLines.length} lines. Edit only the parts that need to change: search_replace for one change, multi_replace for several, insert_code/delete_lines to add or drop lines. Re-send with "overwrite": true only when the user asked for the file to be rewritten from scratch.`);
}
function applyUnified(before: string, patch: string) {
  const source=before.replace(/\r\n/g,'\n').split('\n');
  const lines=patch.replace(/\r\n/g,'\n').split('\n');
  const out:string[]=[]; let cursor=0, found=false;
  for (let i=0;i<lines.length;i++) {
    const header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
    if (!header) continue;
    found=true; const start=Math.max(0,Number(header[1])-1);
    if (start<cursor || start>source.length) throw new Error('Invalid or overlapping patch hunk');
    out.push(...source.slice(cursor,start)); cursor=start;
    let removed=0,added=0;
    while (++i<lines.length && !lines[i]!.startsWith('@@ ') && !lines[i]!.startsWith('--- ')) {
      const line=lines[i]!;
      if (line.startsWith('\\')) continue;
      if (line === '' && i===lines.length-1) break;
      const kind=line[0]!, value=line.slice(1);
      if (kind===' ' || kind==='-') {
        if (source[cursor]!==value) throw new Error('Patch context does not match file');
        cursor++; removed++;
      }
      if (kind===' ' || kind==='+') {out.push(value);added++;}
      if (![' ','-','+'].includes(kind)) throw new Error('Invalid patch line');
    }
    i--;
    if (removed!==Number(header[2]??1) || added!==Number(header[4]??1)) throw new Error('Patch hunk counts do not match');
  }
  if (!found) throw new Error('Provide a unified diff with numbered @@ hunks');
  out.push(...source.slice(cursor)); return out.join('\n');
}

export async function executeFileTool(type: string,args: Record<string,any>,projectPath: string): Promise<any> {
  const root = await fs.realpath(projectPath);
  if (!FILE_TOOLS.includes(type)) throw new Error('Unsupported file tool: '+type);
  if(type==='list_checkpoints')return {ok:true,checkpoints:await listCheckpoints(root)};
  if(type==='create_checkpoint')return createProjectCheckpoint(root,args['label']);
  if (type==='format_code') {
    const prettier = await import('prettier');
    return {ok:true,content:await prettier.format(String(args['code']??args['content']??''),{parser:args['parser']||'typescript'})};
  }
  if (type==='undo_edit' || type==='rollback_changes') {
    const dir=await checkpointDir(root);
    const load=async(name:string)=>JSON.parse(await fs.readFile(path.join(dir,name),'utf8')) as Checkpoint;
    const id=args['checkpointId'] ?? args['checkpoint_id'];
    if (id) {
      if (!/^[\da-f-]{36}$/i.test(String(id))) throw new Error('Valid checkpointId required');
      return restoreOne(root,dir,await load(`${id}.json`),args);
    }
    // "Undo" means the changes the user is looking at, which is normally several tool calls,
    // not the single most recent one. Walk back every change still standing, newest first,
    // so the files land on the state they had before this run of edits started.
    const all=(await Promise.all((await fs.readdir(dir)).filter(p=>/^[\da-f-]{36}\.json$/i.test(p)).map(load)))
      .filter((r)=>!r.restored&&!r.snapshot&&r.root===root)
      .sort((a,b)=>(b.seq ?? 0) - (a.seq ?? 0));
    if (!all.length) throw new Error('There is nothing left to undo. Every change Calvras recorded has already been restored.');
    const undone: {path:string;checkpointId:string}[]=[];
    for (const record of all) {
      const result=await restoreOne(root,dir,record,args);
      for (const change of result.changes) undone.push({path:change.path,checkpointId:String(result.checkpointId)});
    }
    return {ok:true,restored:all.length,checkpointId:all[0]!.id,changes:undone};
  }
  if (['directory_tree','list_files','list_dir','grep_search','search_files','find_files'].includes(type)) {
    const entries=await walk(root,args['path']||args['directory']||'.',Math.min(args['limit']||2000,5000));
    if (type==='grep_search' || type==='search_files') {
      const query=String(args['query']??args['pattern']??args['search']??'');
      if (!query) throw new Error('Search query required');
      const matches:any[]=[];
      for (const e of entries.filter(e=>e.type==='file')) {
        let content:string|null;
        try {content=await read(await safeProjectPath(root,e.path));} catch {continue;}
        if (!content || content.includes('\0')) continue;
        content.split('\n').forEach((line,i)=>{if(matches.length<200 && line.toLowerCase().includes(query.toLowerCase())) matches.push({path:e.path,line:i+1,text:line.slice(0,1000)});});
        if (matches.length>=200) break;
      }
      return {ok:true,matches,truncated:matches.length>=200};
    }
    const query=String(args['query']??args['pattern']??'').replace(/\*/g,'').toLowerCase();
    return {ok:true,entries:type==='find_files'?entries.filter(e=>e.type==='file'&&e.path.toLowerCase().includes(query)):entries,truncated:entries.length>=Math.min(args['limit']||2000,5000)};
  }
  if (type==='multi_file_edit') {
    const edits=args['edits'] ?? args['files'];
    if (!Array.isArray(edits) || !edits.length || edits.length>100) throw new Error('Provide 1 to 100 edits');
    const changes:Change[]=[];
    for (const edit of edits) {
      const target=await safeProjectPath(root,edit.path,false), before=await read(target);
      if (edit.content===undefined && before===null) throw new Error('Cannot replace text in a missing file');
      const next = edit.content!==undefined ? String(edit.content) : replace(before!,edit);
      if (edit.content!==undefined) assertTargetedEdit(path.relative(root,target).replace(/\\/g,'/'), before, next, edit.overwrite);
      changes.push({path:target,before,after:next});
    }
    return commit(root,changes);
  }
  const target=await safeProjectPath(root,args['path']??args['file_path']??args['from']??'.',!['write_file','create_file','delete_file','move_file','rename_file'].includes(type));
  if (type==='get_file_info') {
    const stat=await fs.stat(target); return {ok:true,path:target,type:stat.isDirectory()?'directory':'file',size:stat.size,modifiedAt:stat.mtime.toISOString()};
  }
  if (type==='read_image') {
    const stat=await fs.stat(target).catch((error:any)=>{if(error.code==='ENOENT')return null;throw error;});
    if(!stat||!stat.isFile())throw new Error('File does not exist');
    if(stat.size>8*1024*1024)throw new Error('Image exceeds the 8 MiB tool limit');
    const mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'} as Record<string,string>)[path.extname(target).toLowerCase()];
    if(!mime)throw new Error('Supported image formats: png, jpg, jpeg, gif, webp');
    const buffer=await fs.readFile(target);
    return {ok:true,path:target,mimeType:mime,size:stat.size,image:`data:${mime};base64,${buffer.toString('base64')}`};
  }
  const before=await read(target);
  if (type==='read_file') {
    if (before===null) throw new Error('File does not exist');
    const lines=before.split('\n'),start=Math.max(1,args['startLine']??args['start_line']??1),end=Math.min(lines.length,args['endLine']??args['end_line']??start+1999);
    return {ok:true,path:target,content:lines.slice(start-1,end).join('\n'),totalLines:lines.length,startLine:start,endLine:end,truncated:end<lines.length};
  }
  if (['rename_file','move_file','copy_file'].includes(type)) {
    if (before===null) throw new Error('Source file does not exist');
    const destination=await safeProjectPath(root,args['destination']??args['newPath']??args['new_path']??args['to'],false);
    const previous=await read(destination);
    if (previous!==null && !args['overwrite']) throw new Error('Destination exists; explicit overwrite required');
    return commit(root,[{path:destination,before:previous,after:before},...(type==='copy_file'?[]:[{path:target,before,after:null}])]);
  }
  if (type==='create_file' && before!==null) throw new Error('File already exists');
  if (type==='delete_file') {
    if(before===null) throw new Error('File does not exist');
    return commit(root,[{path:target,before,after:null}]);
  }
  let after:string;
  if (type==='write_file'||type==='create_file') {
    if (typeof args['content']!=='string') throw new Error('content must be a string'); after=args['content'];
    assertTargetedEdit(path.relative(root,target).replace(/\\/g,'/'), before, after, args['overwrite']);
  } else {
    if (before===null) throw new Error('File does not exist');
    if (type==='search_replace') after=replace(before,args);
    else if (type==='multi_replace') {
      if(!Array.isArray(args['replacements'])) throw new Error('replacements array required');
      after=args['replacements'].reduce((content:string,edit:any)=>replace(content,edit),before);
    } else if (type==='insert_code' || type==='delete_lines') {
      const lines=before.split('\n'),start=Number(args['line']??args['startLine']??args['start_line']);
      if (!Number.isInteger(start)||start<1||start>lines.length+(type==='insert_code'?1:0)) throw new Error('Invalid 1-based line number');
      if(type==='insert_code') lines.splice(start-1,0,String(args['code']??args['content']??''));
      else {const end=Number(args['endLine']??args['end_line']??start);if(!Number.isInteger(end)||end<start||end>lines.length)throw new Error('Invalid end line');lines.splice(start-1,end-start+1);}
      after=lines.join('\n');
    } else if(type==='apply_patch'||type==='apply_diff') after=applyUnified(before,String(args['patch']??args['diff']??''));
    else if(type==='format_file') {const prettier=await import('prettier');after=await prettier.format(before,{filepath:target,...(args['parser']?{parser:args['parser']}:{})});}
    else throw new Error('Unsupported file tool');
  }
  return commit(root,[{path:target,before,after}]);
}
