; Calvras Desktop Inno Setup Script
#define MyAppName "Calvras"
#define MyAppVersion "1.0.9"
#define MyAppPublisher "Calvras"
#define MyAppURL "https://calvras.com"
#define MyAppExeName "Calvras.App.exe"

[Setup]
AppId={{E68A8E65-B629-450F-A16A-D8A826D458FE}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=..\dist\installer
OutputBaseFilename=Calvras-Setup-win-x64
SetupIconFile=calvras-logo.ico
WizardImageFile=wizard_sidebar.bmp
WizardSmallImageFile=wizard_small.bmp
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardResizable=no
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
english.WelcomeLabel1=Welcome to Calvras Setup
english.WelcomeLabel2=This will install Calvras, the autonomous AI coding agent, on your computer.%n%nCalvras runs natively on your machine with full filesystem and terminal control.
english.FinishedHeadingLabel=Completing the Calvras Setup Wizard
english.FinishedLabelNoIcons=Calvras has been installed on your computer.%n%nClick Finish to exit Setup.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "..\publish\win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "calvras-logo.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\calvras-logo.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"; IconFilename: "{app}\calvras-logo.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\calvras-logo.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
