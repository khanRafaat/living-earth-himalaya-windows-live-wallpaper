@echo off
rem Builds LivingEarthHost.exe with the C# compiler that ships with Windows. Nothing to download.
rem The page goes inside the exe (pack.ps1), so the one file is a complete download.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File pack.ps1
if errorlevel 1 exit /b 1
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize+ /target:winexe /platform:x64 /out:LivingEarthHost.exe ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Device.dll /r:System.Web.Extensions.dll ^
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /resource:page.zip,page.zip LivingEarthHost.cs
set result=%errorlevel%
del page.zip
exit /b %result%
