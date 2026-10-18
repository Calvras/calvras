// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeFileTool, safeProjectPath, FILE_TOOLS, listCheckpoints, createProjectCheckpoint } from '../lib/runtime/file-tools';

let root: string, outside: string;
const call = (type:string,args:Record<string,any>={})=>executeFileTool(type,args,root);
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'calvras-tools-'));outside=await fs.mkdtemp(path.join(os.tmpdir(),'calvras-outside-'));});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});});

describe('project file tools',()=>{
  it('refuses a source file that embeds a key instead of reading it from the environment',async()=>{
    await fs.writeFile(path.join(root,'.env.local'),'PROVIDER_API_KEY="sk-fixture-abcdefghijklmnop"\n');
    await expect(call('create_file',{path:'server.mjs',content:'const key = process.env.PROVIDER_API_KEY || "sk-fixture-abcdefghijklmnop";'})).rejects.toThrow('manage_environment_variables');
    await expect(call('write_file',{path:'server.mjs',content:'const key = process.env.PROVIDER_API_KEY; if(!key) throw new Error("missing key");'})).resolves.toMatchObject({ok:true});
    await expect(call('create_file',{path:'notes.md',content:'# setup\n\nkey was sk-fixture-abcdefghijklmnop\n'})).resolves.toMatchObject({ok:true});
  });
  it('creates, reads, reports info and returns real diffs and a checkpoint',async()=>{
    const created=await call('create_file',{path:'src/app.ts',content:'export const value = 1;\n'});
    expect(created.checkpointId).toBeTruthy(); expect(created.diffRows[0].type).toBe('add');
    expect((await call('read_file',{path:'src/app.ts'})).content).toContain('value = 1');
    expect((await call('get_file_info',{path:'src/app.ts'})).type).toBe('file');
    await expect(call('create_file',{path:'src/app.ts',content:'overwrite'})).rejects.toThrow('already exists');
  });
  it('rejects traversal, absolute external paths, secrets, and symlink escape',async()=>{
    await expect(safeProjectPath(root,'../outside.txt')).rejects.toThrow('inside');
    await expect(call('write_file',{path:path.join(outside,'x'),content:'x'})).rejects.toThrow('inside');
    await expect(call('write_file',{path:'.env.local',content:'token'})).rejects.toThrow('protected');
    await fs.symlink(outside,path.join(root,'linked'),'junction');
    await expect(call('write_file',{path:'linked/new.txt',content:'x'})).rejects.toThrow('outside');
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('rejects symlinks into protected files',async()=>{
    await fs.writeFile(path.join(root,'.env'),'hidden');
    try { await fs.symlink(path.join(root,'.env'),path.join(root,'visible.txt'),'file'); }
    catch(error:any) { if(error.code==='EPERM') return; throw error; }
    await expect(call('read_file',{path:'visible.txt'})).rejects.toThrow('protected');
  });
  it('searches bounded project files and excludes secrets and dependencies',async()=>{
    await call('create_file',{path:'src/a.ts',content:'hello world\nhello again'});
    await fs.mkdir(path.join(root,'node_modules')); await fs.writeFile(path.join(root,'node_modules','hidden.ts'),'hello');
    await fs.writeFile(path.join(root,'.env'),'hello');
    const search=await call('grep_search',{query:'hello'});
    expect(search.matches).toHaveLength(2);expect(search.matches[1].line).toBe(2);
    expect((await call('find_files',{pattern:'a.ts'})).entries).toHaveLength(1);
    expect((await call('directory_tree')).entries.map((e:any)=>e.path)).not.toContain('.env');
  });
  it('edits with explicit context and supports line edits',async()=>{
    await call('create_file',{path:'a.txt',content:'one\ntwo\nthree'});
    await call('search_replace',{path:'a.txt',oldText:'two',newText:'second'});
    await call('insert_code',{path:'a.txt',line:2,code:'inserted'});
    await call('delete_lines',{path:'a.txt',startLine:3,endLine:3});
    expect((await call('read_file',{path:'a.txt'})).content).toBe('one\ninserted\nthree');
    await expect(call('search_replace',{path:'a.txt',search:'e',replace:'x'})).rejects.toThrow('ambiguous');
  });
  it('validates all multi-file edits before writing anything',async()=>{
    await call('create_file',{path:'a.txt',content:'original'});
    await expect(call('multi_file_edit',{edits:[{path:'a.txt',content:'changed'},{path:'../escape',content:'bad'}]})).rejects.toThrow();
    expect(await fs.readFile(path.join(root,'a.txt'),'utf8')).toBe('original');
    await expect(call('multi_file_edit',{edits:[{path:'a.txt',content:'a'},{path:'a.txt',content:'b'}]})).rejects.toThrow('same path');
    expect(await fs.readFile(path.join(root,'a.txt'),'utf8')).toBe('original');
  });
  it('rolls back multi-file edits and refuses to clobber subsequent edits',async()=>{
    await call('create_file',{path:'a.txt',content:'original'});
    const edit=await call('multi_file_edit',{edits:[{path:'a.txt',content:'changed'},{path:'b.txt',content:'new'}]});
    await call('rollback_changes',{checkpointId:edit.checkpointId});
    expect(await fs.readFile(path.join(root,'a.txt'),'utf8')).toBe('original');
    await expect(fs.stat(path.join(root,'b.txt'))).rejects.toThrow();
    const next=await call('write_file',{path:'a.txt',content:'second'});
    await fs.writeFile(path.join(root,'a.txt'),'user edit');
    await expect(call('undo_edit',{checkpointId:next.checkpointId})).rejects.toThrow('subsequent changes');
    expect(await fs.readFile(path.join(root,'a.txt'),'utf8')).toBe('user edit');
  });
  it('undoes a whole run of edits, not just the last one',async()=>{
    await fs.writeFile(path.join(root,'keep.txt'),'original\n');
    await call('search_replace',{path:'keep.txt',search:'original',replace:'first'});
    await call('create_file',{path:'added.txt',content:'made this turn\n'});
    await call('search_replace',{path:'keep.txt',search:'first',replace:'second'});
    const undone=await call('undo_edit',{});
    expect(undone.restored).toBe(3);
    expect(await fs.readFile(path.join(root,'keep.txt'),'utf8')).toBe('original\n');
    await expect(fs.stat(path.join(root,'added.txt'))).rejects.toThrow();
    // The restore records must not become undo-able themselves, or a second "undo" would
    // simply re-apply what the user just asked to take away.
    await expect(call('undo_edit',{})).rejects.toThrow('nothing left to undo');
    expect(await fs.readFile(path.join(root,'keep.txt'),'utf8')).toBe('original\n');
  });
  it('puts a file back byte for byte when its bytes are not valid UTF-8',async()=>{
    const raw=Buffer.from('name:caf\xe9\r\nnote:na\xefve\r\n','latin1');
    await fs.writeFile(path.join(root,'legacy.txt'),raw);
    await call('search_replace',{path:'legacy.txt',search:'note',replace:'remark'});
    expect(await fs.readFile(path.join(root,'legacy.txt'))).not.toEqual(raw);
    await call('undo_edit',{});
    expect((await fs.readFile(path.join(root,'legacy.txt'))).equals(raw)).toBe(true);
  });
  it('copies, moves, and restores deleted files',async()=>{
    await call('create_file',{path:'a.txt',content:'hello'});
    await call('copy_file',{path:'a.txt',destination:'b.txt'});
    await call('move_file',{from:'b.txt',to:'nested/c.txt'});
    const removed=await call('delete_file',{path:'a.txt'});
    await call('undo_edit',{checkpointId:removed.checkpointId});
    expect(await fs.readFile(path.join(root,'a.txt'),'utf8')).toBe('hello');
    expect(await fs.readFile(path.join(root,'nested/c.txt'),'utf8')).toBe('hello');
  });
  it('applies validated unified diffs and rejects stale context or counts',async()=>{
    await call('create_file',{path:'a.txt',content:'one\ntwo\nthree\n'});
    await call('apply_patch',{path:'a.txt',patch:'--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n'});
    expect(await fs.readFile(path.join(root,'a.txt'),'utf8')).toBe('one\nchanged\nthree\n');
    await expect(call('apply_diff',{path:'a.txt',diff:'@@ -1 +1 @@\n-missing\n+new'})).rejects.toThrow('context');
    await expect(call('apply_diff',{path:'a.txt',diff:'@@ -1,2 +1 @@\n-one\n+new'})).rejects.toThrow('counts');
  });
  it('formats real source using Prettier',async()=>{
    await call('create_file',{path:'a.ts',content:'const x={a:1}'});
    await call('format_file',{path:'a.ts'});
    expect(await fs.readFile(path.join(root,'a.ts'),'utf8')).toBe('const x = { a: 1 };\n');
    expect((await call('format_code',{code:'const y=2'})).content).toBe('const y = 2;\n');
  });
  it('bounds reads and rejects unknown tools',async()=>{
    await call('create_file',{path:'a.txt',content:'one\ntwo\nthree'});
    expect((await call('read_file',{path:'a.txt',startLine:2,endLine:2})).content).toBe('two');
    expect(FILE_TOOLS).toContain('multi_file_edit');
    await expect(call('made_up')).rejects.toThrow('Unsupported');
  });
  it('persists project snapshots and requires explicit overwrite to restore changed content',async()=>{
    await call('create_file',{path:'a.txt',content:'snapshot'});
    await fs.writeFile(path.join(root,'.env'),'protected');
    const checkpoint=await createProjectCheckpoint(root,'Before build');
    expect(checkpoint.fileCount).toBe(1);
    expect((await listCheckpoints(root)).find(c=>c.id===checkpoint.checkpointId)?.label).toBe('Before build');
    await fs.writeFile(path.join(root,'a.txt'),'changed by command');
    await expect(call('rollback_changes',{checkpointId:checkpoint.checkpointId})).rejects.toThrow('subsequent');
    await call('rollback_changes',{checkpointId:checkpoint.checkpointId,allowOverwrite:true});
    expect(await fs.readFile(path.join(root,'a.txt'),'utf8')).toBe('snapshot');
    expect(await fs.readFile(path.join(root,'.env'),'utf8')).toBe('protected');
  });
  it('blocks binary text edits and case variants of protected files',async()=>{
    await fs.writeFile(path.join(root,'binary.bin'),Buffer.from([0,255,128]));
    await expect(call('write_file',{path:'binary.bin',content:'bad'})).rejects.toThrow('Binary');
    await expect(call('write_file',{path:'.ENV.LOCAL',content:'bad'})).rejects.toThrow('protected');
    await expect(call('write_file',{path:'.git/config',content:'bad'})).rejects.toThrow('protected');
  });
  it('rejects hardlinks to shared external files for reads and writes',async()=>{
    const external=path.join(outside,'shared.txt');await fs.writeFile(external,'external contents');
    await fs.link(external,path.join(root,'linked.txt'));
    await expect(call('read_file',{path:'linked.txt'})).rejects.toThrow('Hardlinked');
    await expect(call('write_file',{path:'linked.txt',content:'clobber'})).rejects.toThrow('Hardlinked');
    expect(await fs.readFile(external,'utf8')).toBe('external contents');
  });
});
