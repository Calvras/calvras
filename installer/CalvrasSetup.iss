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
DefaultDirName={autopf}\{#MyAppName}
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
; Per-user install by default; the dialog override lets a machine-wide install happen on request.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
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
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
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

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  NeedsRestart := False;
  if FileExists(ExpandConstant('{app}\{#MyAppExeName}')) then
  begin
    Log('Upgrade detected in ' + ExpandConstant('{app}') + ': closing the running app first.');
    CloseCalvras;
  end;
end;
