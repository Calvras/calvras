import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const COMPUTER_TOOLS = ["take_screen_screenshot", "move_mouse", "click_mouse", "type_text", "press_keys", "open_app", "wait_for_window", "focus_window", "list_windows"] as const;

const run = promisify(execFile);
const ps = async (script: string, timeout = 30000) => {
  if (process.platform !== "win32") throw new Error("Computer control is available on Windows.");
  const { stdout, stderr } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
  if (stderr && !stdout.trim()) throw new Error(stderr.trim().slice(0, 500));
  return stdout.trim();
};
// Values cross into PowerShell as base64 so model text can never become script syntax.
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const num = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 100_000) throw new Error(`${label} must be a screen coordinate.`);
  return Math.round(parsed);
};

const APP_ALIASES: Record<string, string> = {
  chrome: "chrome.exe", googlechrome: "chrome.exe", edge: "msedge.exe", msedge: "msedge.exe", firefox: "firefox.exe",
  explorer: "explorer.exe", files: "explorer.exe", notepad: "notepad.exe", calc: "calc.exe", calculator: "calc.exe",
  paint: "mspaint.exe", mspaint: "mspaint.exe", cmd: "cmd.exe", powershell: "powershell.exe", terminal: "wt.exe",
  code: "code", vscode: "code", word: "winword.exe", excel: "excel.exe", settings: "ms-settings:",
};
const KEY_TOKENS: Record<string, string> = {
  ctrl: "^", control: "^", alt: "%", shift: "+", enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}",
  esc: "{ESC}", escape: "{ESC}", space: " ", backspace: "{BACKSPACE}", delete: "{DELETE}", del: "{DELETE}",
  up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}", home: "{HOME}", end: "{END}",
  pageup: "{PGUP}", pagedown: "{PGDN}", insert: "{INSERT}", win: "^{ESC}",
};
for (let index = 1; index <= 12; index++) KEY_TOKENS[`f${index}`] = `{F${index}}`;
const NATIVE_KEYS = new Set(["n", "t", "w", "l", "c", "v", "x", "a", "s", "f", "r", "p", "d", "z", "y", "q", "e", "g", "h", "j", "k", "m", "b", "u", "i", "o", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
function sendKeysSyntax(keys: string) {
  const parts = keys.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 6) throw new Error("Provide 1-6 keys joined with + , for example ctrl+l.");
  return parts.map((part) => KEY_TOKENS[part] ?? part).map((part) => {
    if (part.length === 1 && !"^%+ (){}[]".includes(part) && !NATIVE_KEYS.has(part) && !/[a-z0-9]/.test(part)) throw new Error(`Unsupported key: ${part}`);
    return part;
  }).join("");
}

async function moveCursor(x: number, y: number) {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$start = [System.Windows.Forms.Cursor]::Position
$steps = 14
1..$steps | ForEach-Object {
  $i = $_
  $nx = [int]($start.X + (${x} - $start.X) * $i / $steps)
  $ny = [int]($start.Y + (${y} - $start.Y) * $i / $steps)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($nx, $ny)
  Start-Sleep -Milliseconds 12
}
"smooth"`;
  return ps(script, 15000);
}

async function click(button: "left" | "right", double: boolean) {
  const down = button === "right" ? "RIGHTDOWN" : "LEFTDOWN";
  const up = button === "right" ? "RIGHTUP" : "LEFTUP";
  const repeat = double ? `[M]::mouse_event([M]::${down},0,0,0,[IntPtr]::Zero); [M]::mouse_event([M]::${up},0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 90;` : "";
  return ps(`Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
}
"@
${repeat}[M]::mouse_event([M]::${down},0,0,0,[IntPtr]::Zero); [M]::mouse_event([M]::${up},0,0,0,[IntPtr]::Zero); "clicked"`, 15000);
}

export async function executeComputerTool(type: string, args: Record<string, unknown>): Promise<any> {
  if (!(COMPUTER_TOOLS as readonly string[]).includes(type)) throw new Error(`Unknown computer tool: ${type}`);
  switch (type) {
    case "take_screen_screenshot": {
      // Plain ImageFormat::Jpeg only. The GetImageEncoders + EncoderParameter(Quality)
      // combination is flagged as malicious by AV heuristics when mixed with
      // CopyFromScreen, so keep this shape simple.
      const output = await ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $full.Size)
$ms = New-Object System.IO.MemoryStream
$full.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
"$($b.Width)x$($b.Height);" + [Convert]::ToBase64String($ms.ToArray())`, 45000);
      const [size, data] = output.split(";");
      if (!data) throw new Error("Screen capture failed.");
      return { ok: true, image: `data:image/jpeg;base64,${data}`, screen: size, note: "Coordinates are full-screen pixels measured from the virtual screen origin." };
    }
    case "move_mouse": {
      await moveCursor(num(args["x"], "x"), num(args["y"], "y"));
      return { ok: true, position: { x: num(args["x"], "x"), y: num(args["y"], "y") } };
    }
    case "click_mouse": {
      if (args["x"] !== undefined || args["y"] !== undefined) await moveCursor(num(args["x"], "x"), num(args["y"], "y"));
      const button = args["button"] === "right" ? "right" : "left";
      await click(button, args["double"] === true);
      return { ok: true, clicked: button, ...(args["double"] === true ? { double: true } : {}) };
    }
    case "type_text": {
      if (typeof args["text"] !== "string" || !args["text"]) throw new Error("Provide text to type.");
      await ps(`Add-Type -AssemblyName System.Windows.Forms
$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args["text"].slice(0, 20000))}'))
Set-Clipboard -Value $value
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait('^v')
"typed"`, 20000);
      return { ok: true, typed: String(args["text"]).slice(0, 120) };
    }
    case "press_keys": {
      if (typeof args["keys"] !== "string") throw new Error("Provide keys like ctrl+l.");
      await ps(`Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sendKeysSyntax(args["keys"]).replace(/'/g, "''")}')
"sent"`, 15000);
      return { ok: true, keys: args["keys"] };
    }
    case "open_app": {
      const app = typeof args["app"] === "string" ? args["app"].trim().toLowerCase() : "";
      const url = typeof args["url"] === "string" ? args["url"].trim() : "";
      const extra = typeof args["args"] === "string" ? args["args"].trim() : "";
      if (!app && !url) throw new Error("Provide an app name or a URL.");
      if (app && !/^[a-z0-9.:_-]+$/.test(app)) throw new Error("App name contains unsupported characters.");
      const target = app ? APP_ALIASES[app] ?? app : "";
      if (url && !/^https?:\/\//i.test(url) && !/^c:\\/i.test(url)) throw new Error("Provide an http(s) or file URL.");
      const script = app
        ? `Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(target)}')))${url ? ` -ArgumentList ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(url)}')))` : extra ? ` -ArgumentList ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(extra)}')))` : ""}
"launched"`
        : `Start-Process ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(url)}')))
"launched"`;
      await ps(script, 20000);
      return { ok: true, launched: app || url, note: "Give the window a moment, then take_screen_screenshot to see it." };
    }
    case "wait_for_window": {
      if (typeof args["title"] !== "string" || !args["title"].trim()) throw new Error("Provide part of the window title.");
      const wait = Math.min(Math.max(Number(args["timeoutMs"]) || 15000, 1000), 60000);
      const output = await ps(`$needle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args["title"].slice(0, 200))}'))
$deadline = (Get-Date).AddMilliseconds(${wait})
$match = $null
while (-not $match -and (Get-Date) -lt $deadline) {
  $match = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
  if (-not $match) { Start-Sleep -Milliseconds 350 }
}
if ($match) { $match | Select-Object ProcessName,Id,MainWindowTitle | ConvertTo-Json -Compress } else { "" }`, wait + 10000);
      if (!output) throw new Error(`No window matching "${args["title"]}" appeared within ${wait}ms. Use list_windows to see what is open.`);
      const window = JSON.parse(output);
      return { ok: true, window, title: window.MainWindowTitle, note: "The window exists. Call focus_window before typing." };
    }
    case "focus_window": {
      if (typeof args["title"] !== "string" || !args["title"].trim()) throw new Error("Provide part of the window title.");
      const focused = await ps(`$wshell = New-Object -ComObject wscript.shell
$wshell.AppActivate([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args["title"].slice(0, 200))}')))`, 15000);
      const ok = /true/i.test(focused);
      if (!ok) throw new Error(`No visible window title matched "${args["title"]}". Use list_windows first.`);
      return { ok: true, focused: args["title"] };
    }
    case "list_windows": {
      const output = await ps(`Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 40 ProcessName,Id,MainWindowTitle | ConvertTo-Json -Compress`, 15000);
      return { ok: true, windows: JSON.parse(output || "[]") };
    }
    default: throw new Error(`Unknown computer tool: ${type}`);
  }
}
