import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const text = (file: string) => readFileSync(path.resolve(root, file), "utf8");
const bytes = (file: string) => readFileSync(path.resolve(root, file));

function bmp(file: string) {
  const buf = bytes(file);
  return {
    signature: buf.toString("latin1", 0, 2),
    offset: buf.readUInt32LE(10),
    width: buf.readInt32LE(18),
    height: buf.readInt32LE(22),
    bitCount: buf.readUInt16LE(28),
  };
}

function ico(file: string) {
  const buf = bytes(file);
  const count = buf.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) sizes.push(buf[6 + i * 16] || 256);
  return { type: buf.readUInt16LE(2), count, sizes };
}

describe("Windows installer", () => {
  it("ships 24-bit wizard art at both 1x and 2x for every DPI", () => {
    for (const [file, width, height] of [
      ["installer/wizard_sidebar.bmp", 164, 314],
      ["installer/wizard_sidebar_2x.bmp", 328, 628],
      ["installer/wizard_small.bmp", 55, 55],
      ["installer/wizard_small_2x.bmp", 110, 110],
    ] as const) {
      expect(bmp(file), file).toEqual({ signature: "BM", offset: 54, width, height, bitCount: 24 });
    }
  });

  it("keeps the sidebar canvas at the flat near-black the wizard blends into", () => {
    const buf = bytes("installer/wizard_sidebar.bmp");
    const { offset, width, height } = bmp("installer/wizard_sidebar.bmp");
    const stride = Math.ceil((width * 3) / 4) * 4;
    // The top and bottom rows are the parts the logo never reaches.
    for (const y of [0, 1, height - 2, height - 1]) {
      for (let x = 0; x < width; x++) {
        const o = offset + y * stride + x * 3;
        expect([buf[o + 2], buf[o + 1], buf[o]]).toEqual([0x11, 0x11, 0x11]);
      }
    }
  });

  it("draws the mark inside the sidebar instead of leaving it empty", () => {
    const buf = bytes("installer/wizard_sidebar.bmp");
    const { offset, width, height } = bmp("installer/wizard_sidebar.bmp");
    const stride = Math.ceil((width * 3) / 4) * 4;
    let lit = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = offset + y * stride + x * 3;
        if (((buf[o] ?? 0) + (buf[o + 1] ?? 0) + (buf[o + 2] ?? 0)) / 3 > 60) lit++;
      }
    }
    expect(lit).toBeGreaterThan(600);
    // Bottom-up storage: the mark sits at 40% of the height, so it must not touch the lower edge.
    const lowest = [...Array(height).keys()].filter((y) => {
      for (let x = 0; x < width; x++) {
        const o = offset + y * stride + x * 3;
        if (((buf[o] ?? 0) + (buf[o + 1] ?? 0) + (buf[o + 2] ?? 0)) / 3 > 60) return true;
      }
      return false;
    });
    const topEdgeInImageSpace = height - 1 - Math.max(...lowest);
    const bottomEdgeInImageSpace = height - 1 - Math.min(...lowest);
    expect(topEdgeInImageSpace).toBeLessThan(height * 0.4);
    expect(bottomEdgeInImageSpace).toBeGreaterThan(height * 0.4);
  });

  it("builds one multi-size application icon covering every shell size", () => {
    expect(ico("installer/app.ico")).toEqual({ type: 1, count: 7, sizes: [16, 24, 32, 48, 64, 128, 256] });
  });

  it("takes its identity from the app and never from a version typed into the script", () => {
    const iss = text("installer/CalvrasSetup.iss");
    expect(iss).toContain('#define MyAppName "Calvras"');
    expect(iss).toContain('#define MyAppPublisher "Calvras"');
    expect(iss).toContain('#define MyAppURL "https://calvras.com"');
    expect(iss).toContain("AppVersion={#MyAppVersion}");
    expect(iss).toMatch(/#define MyAppVersion "0\.0\.0"/);
    expect(iss).not.toMatch(/#define MyAppVersion "(?!0\.0\.0)\d+\.\d+\.\d+"/);
    expect(text("scripts/build-installer.mjs")).toContain("/DMyAppVersion=${version}");
  });

  it("declares the wizard, the per-user install and the payload the spec asks for", () => {
    const iss = text("installer/CalvrasSetup.iss");
    for (const line of [
      "WizardStyle=modern",
      "WizardImageFile=wizard_sidebar.bmp",
      "WizardSmallImageFile=wizard_small.bmp",
      "SetupIconFile=app.ico",
      "UninstallDisplayIcon={app}\\{#MyAppExeName}",
      "DefaultDirName={localappdata}\\Programs\\{#MyAppName}",
      "UsePreviousAppDir=no",
      "OutputDir=..\\dist\\installer",
      "OutputBaseFilename=Calvras-Setup-win-x64",
      "Compression=lzma2",
      "SolidCompression=yes",
      "ArchitecturesInstallIn64BitMode=x64compatible",
      "PrivilegesRequired=lowest",
      "CloseApplications=yes",
      "RestartApplications=no",
      "DisableProgramGroupPage=yes",
      'Source: "{#AppPayload}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs',
      'Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"',
      'Filename: "{app}\\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent',
    ]) {
      expect(iss, line).toContain(line);
    }
    // One folder, one elevation level. {autopf} moves between Program Files and LocalAppData
    // depending on whether Setup happened to be elevated, and the dialog override let a person
    // choose a machine-wide install, so updates kept landing beside the copy they were replacing
    // and the desktop icon kept opening the older one.
    expect(iss).not.toContain("PrivilegesRequiredOverridesAllowed");
    expect(iss).not.toContain("DefaultDirName={autopf}");
    expect(iss).toContain("procedure RemoveLegacyMachineCopy");
    expect(iss).toContain("RemoveLegacyMachineCopy;");
    expect(iss).toContain("; SignTool=");
    expect(iss).toContain('#define AppPayload "..\\electron-dist\\win-unpacked"');
    expect(text("scripts/build-installer.mjs")).toContain("/DAppPayload=${relative}");
    expect(iss).toContain("This will install {#MyAppName} version {#MyAppVersion} on your computer.");
    expect(iss).toContain("procedure CloseCalvras");
    // The app drives Setup itself, so it must never leave a wizard to click through — and the build's
    // own silent install check must not be able to remove the machine's real leftover copy.
    expect(iss).toContain("if GetEnv('CALVRAS_KEEP_LEGACY') <> '' then Exit;");
    expect(text("scripts/build-installer.mjs")).toContain('CALVRAS_KEEP_LEGACY: "1"');
    expect(text("electron/main.js")).toContain("'/SILENT','/NORESTART','/SUPPRESSMSGBOXES'");
  });

  it("wires the build through npm and points the exe icon at the same generated art", () => {
    const pkg = JSON.parse(text("package.json")) as { scripts: Record<string, string>; build: { win: { icon: string } } };
    expect(pkg.scripts["installer:build"]).toBe("node scripts/build-installer.mjs");
    expect(pkg.scripts["installer:assets"]).toBe("node installer/make-assets/make.mjs");
    expect(pkg.build.win.icon).toBe("installer/app.ico");
  });
});
