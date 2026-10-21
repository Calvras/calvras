; Calvras for Windows — Inno Setup script.
; Build it with `npm run installer:build`, which regenerates the wizard art, packs the Electron
; payload, and compiles this file with ISCC. The version comes from package.json as /DMyAppVersion.

#define MyAppName "Calvras"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppPublisher "Calvras"
#define MyAppURL "https://calvras.com"
#define MyAppExeName "Calvras.exe"
; The built Electron payload. `npm run installer:build` passes a per-run folder because Windows holds a
; delete lock on win-unpacked\resources\app.asar while an editor indexes it; hand ISCC the default path
; and it packages the standard build folder.
#ifndef AppPayload
  #define AppPayload "..\electron-dist\win-unpacked"
#endif

[Setup]
; Keep this GUID: it is how Setup recognises an existing Calvras install on upgrade.
AppId={{E68A8E65-B629-450F-A16A-D8A826D458FE}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
; One location, whatever elevation the run happens to have. {autopf} resolves to Program Files when
; Setup is elevated and to LocalAppData\Programs when it is not, so an update driven by the app — which
; cannot elevate — installed beside the copy it was meant to replace.
DefaultDirName={localappdata}\Programs\{#MyAppName}
; Never inherit the folder of an older machine-wide install: that is where the failed updates came from.
UsePreviousAppDir=no
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
OutputDir=..\dist\installer
OutputBaseFilename=Calvras-Setup-win-x64
SetupIconFile=app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Inno Setup 6 takes one file per directive and stretches it into the page, so the 164x314 and 55x55
; art is what compiles in. The 2x pair is regenerated next to it for a 4K/200% build.
WizardImageFile=wizard_sidebar.bmp
WizardSmallImageFile=wizard_small.bmp
; The sidebar art is near-black, so anything the stretched image does not cover stays dark too.
WizardImageBackColor=$111111
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Per-user, and only per-user: the elevation override used to offer a machine-wide install, which is
; how two Calvras folders ended up on one machine with an icon that launches the older one.
PrivilegesRequired=lowest
CloseApplications=yes
RestartApplications=no
DisableWelcomePage=no
; To sign the installer and the uninstaller, put a code-signing certificate in the store,
; install the Windows SDK signtool, then uncomment both lines and set the thumbprint.
; SignTool=signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <thumbprint> $f
; SignedUninstaller=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
english.WelcomeLabel2=This will install {#MyAppName} version {#MyAppVersion} on your computer.%n%nIt is recommended that you close any other Calvras windows before continuing, so Setup can replace the running files without a restart.
english.FinishedLabelNoIcons={#MyAppName} has been installed on your computer.%n%nLaunch it from the desktop or the Start menu.

[Tasks]
; Checked by default: an app-driven update runs silently and cannot ask, and it may have just removed
; the machine-wide desktop icon this copy replaces, so the person would be left with only a Start menu
; entry for an app they reach from the desktop.
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "Start {#MyAppName} when I sign in to Windows"; Flags: unchecked

[Files]
Source: "{#AppPayload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "app.ico"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: startup

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\app.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"; IconFilename: "{app}\app.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
/// An upgrade replaces the files of a running Electron app, which only works once that process is
/// gone. Setup's own file-in-use detection is not enough here because the app keeps a server child
/// alive, so close both by image name and wait for the OS to release the locks.
procedure CloseCalvras;
var
  ResultCode: Integer;
  Attempt: Integer;
begin
  for Attempt := 1 to 3 do
  begin
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM "{#MyAppExeName}"', '', SW_HIDE,
      ewWaitUntilTerminated, ResultCode);
    Sleep(400);
  end;
end;

/// The first Calvras installs went in machine-wide through Program Files. Every installer since
/// writes a per-user copy elsewhere, so that old copy stayed behind with its own desktop icon and
/// that icon kept opening the older build however many times the app updated: an update that
/// appeared to be thrown away. Take the leftover out so this machine ends up with one Calvras.
procedure RemoveLegacyMachineCopy;
var
  Names: TArrayOfString;
  Index: Integer;
  Key, Name, Quiet, Uninstaller, Args: String;
  I, First, Last, ResultCode: Integer;
begin
  // The build's own silent install/uninstall check must not be able to reach a real machine's
  // Program Files, so it sets this and the leftover stays until an actual update runs.
  if GetEnv('CALVRAS_KEEP_LEGACY') <> '' then Exit;
  if not RegGetSubkeyNames(HKLM64, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', Names) then Exit;
  for Index := 0 to GetArrayLength(Names) - 1 do
  begin
    Key := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + Names[Index];
    if not RegQueryStringValue(HKLM64, Key, 'DisplayName', Name) then Continue;
    if Copy(Name, 1, Length('{#MyAppName}')) <> '{#MyAppName}' then Continue;
    if not RegQueryStringValue(HKLM64, Key, 'QuietUninstallString', Quiet) then Continue;
    // Out of the quoted command, the uninstaller path is what sits between the first pair of quotes.
    First := Pos('"', Quiet);
    if First = 0 then Continue;
    Last := 0;
    for I := First + 1 to Length(Quiet) do
      if Copy(Quiet, I, 1) = '"' then Last := I;
    if Last <= First then Continue;
    Uninstaller := Copy(Quiet, First + 1, Last - First - 1);
    // Never touch the per-user copy this Setup owns.
    if Pos(ExpandConstant('{localappdata}'), Lowercase(Uninstaller)) > 0 then Continue;
    if not FileExists(Uninstaller) then Continue;
    Args := Trim(Copy(Quiet, Last + 1, Length(Quiet) - Last));
    if Args = '' then Args := '/S';
    Log('Old machine-wide copy at ' + Uninstaller + ': removing it so updates land in one place.');
    ShellExec('runas', Uninstaller, Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('Legacy removal exited with code ' + IntToStr(ResultCode) + ' (a cancelled prompt is not fatal).');
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  NeedsRestart := False;
  if FileExists(ExpandConstant('{app}\{#MyAppExeName}')) then
  begin
    Log('Upgrade detected in ' + ExpandConstant('{app}') + ': closing the running app first.');
    CloseCalvras;
  end;
  RemoveLegacyMachineCopy;
end;
