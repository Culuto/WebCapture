Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
controller = fso.BuildPath(fso.BuildPath(root, "Detail"), "WebCaptureController.ps1")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & controller & """ -Action reload-background", 0, False
