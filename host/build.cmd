@echo off
rem Builds LivingEarthHost.exe with the C# compiler that ships with Windows. Nothing to download.
setlocal
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize+ /target:winexe /platform:x64 /out:LivingEarthHost.exe ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Device.dll /r:System.Web.Extensions.dll LivingEarthHost.cs
if errorlevel 1 exit /b 1
