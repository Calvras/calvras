import { _electron as electron } from "playwright";
import path from "node:path";
import assert from "node:assert/strict";
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve("node_modules/electron/dist/electron.exe"),args:["."],env,timeout:30000});
try{
 const page=await app.firstWindow();await page.waitForLoadState("domcontentloaded");
 await page.getByRole("textbox",{name:"Prompt"}).waitFor();
 await page.getByRole("button",{name:"Open workspace tools",exact:true}).click();
 const close=page.getByRole("button",{name:"Close workspace",exact:true});
 const bounds=await close.boundingBox();assert.ok(bounds.y>=28,"Workspace close button must stay below the native title bar");
 await page.screenshot({path:".agents/artifacts/runtime/electron-workspace.png",animations:"disabled"});
 await close.click();assert.equal(await page.getByLabel("Workspace tools",{exact:true}).count(),0);
 await page.getByRole("button",{name:"Settings",exact:true}).click();
 await page.getByRole("combobox",{name:"Default permissions"}).waitFor();
 await page.screenshot({path:".agents/artifacts/runtime/electron-settings.png",animations:"disabled"});
 await page.keyboard.press("Escape");
 await page.screenshot({path:".agents/artifacts/runtime/electron-home.png",animations:"disabled"});
 console.log(JSON.stringify({ok:true,checks:["real Electron window","visible close below title bar","workspace close","settings open and escape","home layout"]}));
}finally{await app.close();}
