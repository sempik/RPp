; Inno Setup script for RPp. Built by build.ps1, which passes AppVersion, SrcDir, OutDir, Root.
; AppId is unchanged since the "OBS Player" days so the new installer upgrades old installs.

[Setup]
AppId={{8F3A6C2E-4B1D-4E7A-9C55-0B5E2D7A1F33}
AppName=RPp
AppVersion={#AppVersion}
AppVerName=RPp {#AppVersion}
AppPublisher=RPp
DefaultDirName={localappdata}\Programs\RPp
UsePreviousAppDir=no
DefaultGroupName=RPp
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=RPp-Setup-{#AppVersion}
SetupIconFile={#Root}\app\icon.ico
UninstallDisplayIcon={app}\RPp.exe
UninstallDisplayName=RPp
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
CloseApplications=yes
ChangesAssociations=yes

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; drop files of a previous version (e.g. Electron locales) before copying the new build
Type: filesandordirs; Name: "{app}\resources\app"
Type: filesandordirs; Name: "{app}\locales"
; leftovers of the old "OBS Player" name
Type: filesandordirs; Name: "{localappdata}\Programs\OBS Player"
Type: files; Name: "{autoprograms}\OBS Player.lnk"
Type: files; Name: "{autodesktop}\OBS Player.lnk"

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\RPp"; Filename: "{app}\RPp.exe"
Name: "{autodesktop}\RPp"; Filename: "{app}\RPp.exe"; Tasks: desktopicon

[Registry]
; remove the old "OBS Player" open-with entries
Root: HKCU; Subkey: "Software\Classes\OBSPlayer.Video"; ValueType: none; Flags: deletekey
Root: HKCU; Subkey: "Software\Classes\Applications\OBS Player.exe"; ValueType: none; Flags: deletekey
Root: HKCU; Subkey: "Software\Classes\.mp4\OpenWithProgids"; ValueType: none; ValueName: "OBSPlayer.Video"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Classes\.mkv\OpenWithProgids"; ValueType: none; ValueName: "OBSPlayer.Video"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Classes\.mov\OpenWithProgids"; ValueType: none; ValueName: "OBSPlayer.Video"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Classes\.flv\OpenWithProgids"; ValueType: none; ValueName: "OBSPlayer.Video"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Classes\.ts\OpenWithProgids"; ValueType: none; ValueName: "OBSPlayer.Video"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Classes\.webm\OpenWithProgids"; ValueType: none; ValueName: "OBSPlayer.Video"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Classes\.m4v\OpenWithProgids"; ValueType: none; ValueName: "OBSPlayer.Video"; Flags: deletevalue
; "Open with" entry for video files (does not steal the default player)
Root: HKCU; Subkey: "Software\Classes\RPp.Video"; ValueType: string; ValueData: "Video (RPp)"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\RPp.Video\DefaultIcon"; ValueType: string; ValueData: """{app}\RPp.exe"",0"
Root: HKCU; Subkey: "Software\Classes\RPp.Video\shell\open\command"; ValueType: string; ValueData: """{app}\RPp.exe"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\Applications\RPp.exe\shell\open\command"; ValueType: string; ValueData: """{app}\RPp.exe"" ""%1"""; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\.mp4\OpenWithProgids"; ValueType: string; ValueName: "RPp.Video"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.mkv\OpenWithProgids"; ValueType: string; ValueName: "RPp.Video"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.mov\OpenWithProgids"; ValueType: string; ValueName: "RPp.Video"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.flv\OpenWithProgids"; ValueType: string; ValueName: "RPp.Video"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.ts\OpenWithProgids"; ValueType: string; ValueName: "RPp.Video"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.webm\OpenWithProgids"; ValueType: string; ValueName: "RPp.Video"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.m4v\OpenWithProgids"; ValueType: string; ValueName: "RPp.Video"; ValueData: ""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\RPp.exe"; Description: "{cm:LaunchProgram,RPp}"; Flags: nowait postinstall skipifsilent
