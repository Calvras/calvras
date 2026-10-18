import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const origin=process.argv[2] || "http://127.0.0.1:3355";
const root=await fs.mkdtemp(path.join(os.tmpdir(),"calvras-fullstack-smoke-"));
await fs.writeFile(path.join(root,"package.json"),JSON.stringify({name:"fullstack-smoke",type:"module",scripts:{test:"node --test",dev:"node server.mjs"}}));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1280,height:900}});
await context.addInitScript(({root})=>{
 localStorage.setItem("calvras_projects",JSON.stringify([{name:"Fullstack check",path:root}]));
 localStorage.setItem("calvras_active_project",JSON.stringify({name:"Fullstack check",path:root}));
 localStorage.setItem("calvras_access_mode","full");localStorage.removeItem("calvras_chat_messages");
},{root});
const sessions=new Set();const errors=[];const page=await context.newPage();
page.on("request",request=>{if(request.url().endsWith("/api/v1/chat/completions")){const body=request.postDataJSON();const prompt=body.messages.find(message=>message.role==="user")?.content;console.log(JSON.stringify({profile:body.profile,promptLength:typeof prompt==="string"?prompt.length:0}));}});
page.on("pageerror",e=>errors.push(e.message));
page.on("response",async response=>{if(response.url().endsWith("/api/agent/session")&&response.request().method()==="POST"){try{sessions.add((await response.json()).id);}catch{}}});
try {
 await page.goto(origin+"/app");
 const prompt="In this empty Node project implement a tiny fullstack health page. Create server.mjs using node:http, serve index.html at / and JSON {ok:true} at /api/health. index.html must fetch /api/health and display Service healthy after success. Export the server without listening when imported by node:test. Add server.test.mjs with a real HTTP test for /api/health. Keep package scripts test=node --test and dev=node server.mjs. Run the tests, start the dev server, and verify the page with browser tools. Use only Node built-ins and plain HTML; no dependencies. Work through all steps automatically and stop when verified.";
 await page.getByRole("textbox",{name:"Prompt"}).fill(prompt);await page.getByRole("button",{name:"Send prompt",exact:true}).click();
 await page.getByRole("button",{name:"Stop task",exact:true}).waitFor({timeout:10000});
 await page.getByRole("button",{name:"Stop task",exact:true}).waitFor({state:"detached",timeout:180000});
 const conversation=await page.getByLabel("Conversation",{exact:true}).innerText();
 console.log(JSON.stringify({conversation:conversation.slice(-6000),root}));
 await fs.mkdir(".agents/artifacts/runtime",{recursive:true});
 await page.screenshot({path:".agents/artifacts/runtime/fullstack-result.png",animations:"disabled"});
 assert.deepEqual(errors,[]);
 assert.ok((await fs.readFile(path.join(root,"index.html"),"utf8")).includes("/api/health"));
 assert.ok((await fs.readFile(path.join(root,"server.test.mjs"),"utf8")).includes("/api/health"));
 const logs=await Promise.all([...sessions].map(async id=>(await(await fetch(origin+"/api/agent/session?id="+id)).json()).logs));
 assert.ok(logs.flat().some(log=>log.ok&&(/run_tests|run_single_test/.test(log.tool)||(log.tool==="run_command"&&/tests|pass|passed/.test(String(log.detail))))),"Expected successful test execution");
 const sessionId=[...sessions].at(-1);
 const check=await fetch(origin+"/api/agent/tools",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,action:{type:"check_server"}})});
 const checkEvents=(await check.text()).split("\n\n").filter(Boolean).map(event=>JSON.parse(event.slice(6)));
 const server=checkEvents.at(-1).result;
 assert.equal(server.ready,true); assert.notEqual(new URL(server.url).port,new URL(origin).port,"Project must not inherit the app port");
 const preview=await context.newPage();await preview.goto(server.url);await preview.getByText("Service healthy",{exact:true}).waitFor();
 await preview.screenshot({path:".agents/artifacts/runtime/fullstack-preview.png",animations:"disabled"});await preview.close();
 assert.equal(await page.getByRole("button",{name:/Worked for/}).count(),1);
 console.log(JSON.stringify({ok:true,checks:["live code generation","backend route","frontend fetch","generated tests","actual test run","single reply header"],errors}));
} finally {
 for(const id of sessions){try{await fetch(origin+"/api/agent/tools",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:id,action:{type:"stop_dev_server"}})});}catch{}await fetch(origin+"/api/agent/session?id="+id,{method:"DELETE"});}
 await browser.close();
 if(path.resolve(root).startsWith(path.join(os.tmpdir(),"calvras-fullstack-smoke-")))await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
