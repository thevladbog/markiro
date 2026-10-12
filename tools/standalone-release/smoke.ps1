#requires -Version 7
<#
  The installer of «Markiro Автоном» on a disposable Windows machine (plan
  УСТ): the roles, the MarkiroHost service with its account and restart
  policy, the firewall rule, the data directory's access list and owner, a
  verified copy of the database in backups with that access list, a restart
  after a crash, a reinstall that keeps the host, a reinstall over an
  unfinished restore (the host's exit code 4), a refused role change, and
  uninstalls that keep the data, one of them with the host running. The
  standalone-windows-build job runs it on GitHub's runner, which has
  administrator rights. Never run it on a site's PC: it installs and removes
  the service and leaves the test host's data in %ProgramData%\Markiro\Host.

  It reads no credential and sends nothing anywhere but to the host on this
  machine. The service's state is read as ServiceControllerStatus numbers
  (the words are localized on a Russian Windows); sc.exe's text is matched
  as well, because the runner's Windows is English, and the failure policy is
  also read from the service's registry values.
#>
param([Parameter(Mandatory)][string]$BundleDir)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest

$found = @(Get-ChildItem -Path $BundleDir -Filter '*-setup.exe')
if ($found.Count -ne 1) { throw "expected one installer in $BundleDir, found $($found.Count)" }
$installer = $found[0].FullName
$installDir = Join-Path $env:ProgramFiles 'Markiro Standalone'
$markiroDir = Join-Path $env:ProgramData 'Markiro'
$dataDir = Join-Path $markiroDir 'Host'
$backups = Join-Path $dataDir 'backups'
$hostExe = Join-Path $installDir 'markiro-host.exe'
$roleFile = Join-Path $installDir 'installation.json'
$runKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$roleKey = 'HKLM:\Software\Markiro\Standalone'
$serviceKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\MarkiroHost'
# System.ServiceProcess.ServiceControllerStatus; 0 stands for "no such service".
$Stopped = 1
$Running = 4

function Step([string]$text) { Write-Host "== $text" }
function Check([bool]$condition, [string]$text) {
  if (-not $condition) { throw "FAILED: $text" }
  Write-Host "ok  $text"
}
function Processes {
  Get-CimInstance Win32_Process | ForEach-Object {
    Write-Host ('{0,6} <- {1,6} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine)
  }
}
# Waits for this one process, not for its descendants (the -Wait switch of the
# starting cmdlet waits for those too, and an installer that starts the app
# would never end), and for a bounded time: past it the process list says what is still running.
function Run([string]$file, [string[]]$arguments, [int]$seconds) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  if (-not $process.WaitForExit($seconds * 1000)) {
    Write-Host "== $file $($arguments -join ' ') did not exit within $seconds s; the processes:"
    Processes
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "FAILED: $file did not exit within $seconds s"
  }
  $process.WaitForExit()
  Write-Host "   exit code $($process.ExitCode)"
  $process.ExitCode
}
function Install([string[]]$arguments) { Run $installer $arguments 600 }
function Uninstall {
  # `_?=` runs the uninstaller in place, so it waits for the work itself.
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  Run $uninstaller @('/S', "_?=$installDir") 300
}
function WaitFor([scriptblock]$condition, [int]$seconds, [string]$what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { Write-Host "ok  $what"; return }
    Start-Sleep -Milliseconds 500
  }
  throw "FAILED: $what within $seconds s"
}
function Service { Get-CimInstance Win32_Service -Filter "Name='MarkiroHost'" }
function ServiceState {
  # StrictMode forbids .Status on the $null an absent service gives.
  $found = Get-Service -Name MarkiroHost -ErrorAction SilentlyContinue
  if ($null -eq $found) { return 0 }
  [int]$found.Status
}
function HostAnswers {
  try {
    $hello = Invoke-RestMethod -Uri 'https://127.0.0.1:45710/v1/hello' -SkipCertificateCheck -TimeoutSec 5
    $hello.product -eq 'markiro-host'
  } catch { $false }
}
function RegValue([string]$path, [string]$name) {
  $item = Get-ItemProperty -Path $path -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  $property = $item.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  $property.Value
}
function RunValue { RegValue $runKey 'MarkiroStandalone' }
# The app reads this file with no tolerance for another key or another
# spelling: exactly one lower-case role, no byte order mark.
function RoleFileIs([string]$expected) {
  $bytes = [System.IO.File]::ReadAllBytes($roleFile)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = [System.Text.Encoding]::UTF8.GetString($bytes).Trim()
  (-not $hasBom) -and ($text -ceq "{`"role`":`"$expected`"}")
}
function OwnerSid([string]$path) {
  (Get-Acl $path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
}
# A copy counts once its manifest is beside it: a .db alone is what a broken
# copy left.
function VerifiedCopies {
  @(Get-ChildItem -Path $backups -Filter 'markiro-host-*.db' -ErrorAction SilentlyContinue |
      Where-Object { Test-Path ([System.IO.Path]::ChangeExtension($_.FullName, '.json')) })
}
function Sids([string]$path) {
  @((Get-Acl $path).Access | ForEach-Object {
      $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } | Sort-Object -Unique)
}

Step 'a silent install without a role installs nothing'
Check ((Install @('/S')) -ne 0) 'the installer refuses /S without /ROLE'
Check ((ServiceState) -eq 0) 'no service was registered'
Check (-not (Test-Path $roleFile)) 'no role was written'

Step 'role host: the service, its account, its restart policy, the port'
Check ((Install @('/S', '/ROLE=host')) -eq 0) 'the installer succeeds'
Check (RoleFileIs 'host') 'installation.json says exactly host'
Check ((RegValue $roleKey 'Role') -ceq 'host') 'the registry keeps the role for the next installer'
$service = Service
Check ($null -ne $service) 'MarkiroHost is registered'
Check ($service.StartMode -eq 'Auto') 'it starts with Windows'
Check ($service.StartName -eq 'NT AUTHORITY\LocalService') 'it runs as LocalService'
Check ($service.PathName -eq "`"$hostExe`" service") 'it runs markiro-host service'
WaitFor { (ServiceState) -eq $Running } 60 'the service runs'
WaitFor { HostAnswers } 60 'the host answers on https://127.0.0.1:45710'
$failure = (& sc.exe qfailure MarkiroHost | Out-String)
Check ($failure -match 'RESTART -- Delay = 5000') 'the first failure restarts it after 5 s'
Check ($failure -match 'RESET_PERIOD \(in seconds\)\s*: 86400') 'the failure count resets after a day'
Check ((& sc.exe qfailureflag MarkiroHost | Out-String) -match 'TRUE') 'an exit with an error counts as a failure'
Check ((RegValue $serviceKey 'FailureActionsOnNonCrashFailures') -eq 1) 'the registry says so too'
$rule = Get-NetFirewallRule -Name 'MarkiroHost'
Check ($rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow') 'an inbound allow rule'
Check (($rule.Profile.ToString() -split ', ' | Sort-Object) -join ',' -eq 'Domain,Private') 'on private and domain networks only'
Check ((Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule).LocalPort -eq '45710') 'for TCP 45710'
Check ((Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule).RemoteAddress -eq 'LocalSubnet') 'from the local subnet'
Check ((Get-Acl $dataDir).AreAccessRulesProtected) 'the data directory inherits nothing from ProgramData'
Check (((Sids $dataDir) -join ',') -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544') 'SYSTEM, LocalService and Administrators only'
$key = Join-Path $dataDir 'tls\key.der'
WaitFor { Test-Path $key } 30 'the host made its TLS key'
Check (((Sids $key) -join ',') -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544') 'the TLS key is not readable by users'
Check ((OwnerSid $dataDir) -eq 'S-1-5-32-544') 'Administrators own the data directory'
Check ((OwnerSid $markiroDir) -eq 'S-1-5-32-544') 'and its Markiro folder'
# The host copies its database at every start; the copy is flushed before it
# is renamed, which on Windows needs a handle opened for writing.
WaitFor { @(VerifiedCopies).Count -ge 1 } 120 'the host made a verified copy in backups'
$copy = @(VerifiedCopies)[0]
Check (((Sids $backups) -join ',') -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544') 'the backups folder is not readable by users'
Check (((Sids $copy.FullName) -join ',') -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544') 'the copy is not readable by users'
Check ($null -ne (RunValue)) 'the station opens at sign-in'

Step 'a crash: Windows starts the service again'
$before = (Service).ProcessId
Stop-Process -Id $before -Force
WaitFor { (ServiceState) -eq $Running -and (Service).ProcessId -ne $before } 45 'the service runs again in a new process'
WaitFor { HostAnswers } 60 'the host answers again'

Step 'a reinstall keeps the role and the host'
$hostJson = Get-Content -Raw (Join-Path $dataDir 'host.json')
$fingerprint = & $hostExe print-fingerprint --data-dir $dataDir | Select-Object -First 1
Check ((Install @('/S')) -eq 0) 'the installer succeeds with the role it kept'
Check (RoleFileIs 'host') 'the role stays host'
Check ((Get-Content -Raw (Join-Path $dataDir 'host.json')) -eq $hostJson) 'the host identity is the same'
Check ((& $hostExe print-fingerprint --data-dir $dataDir | Select-Object -First 1) -eq $fingerprint) 'the certificate is the same'
WaitFor { HostAnswers } 60 'the host answers after the reinstall'
Check (@(Get-NetFirewallRule -Name 'MarkiroHost').Count -eq 1) 'still one firewall rule'
Check ((Install @('/S', '/ROLE=HOST')) -eq 0) 'the same role in capitals is the same role'
Check (RoleFileIs 'host') 'and is written in lower case'
WaitFor { HostAnswers } 60 'the host answers after that reinstall too'

Step 'a reinstall over an unfinished restore ends with exit 4: a warning, not a failure'
# `start` refuses while this file exists (host/src/restore.rs): the service
# stays installed and does not stay up, and the installer warns and goes on.
$marker = Join-Path $dataDir 'host.restore-intent'
Stop-Service -Name MarkiroHost
WaitFor { (ServiceState) -eq $Stopped } 30 'the service is stopped'
Set-Content -LiteralPath $marker -Value 'smoke test: a restore that was not finished' -Encoding ascii
try {
  Check ((Install @('/S')) -eq 0) 'the installer still succeeds: exit 4 of the host is a warning'
  Check ((ServiceState) -ne 0) 'MarkiroHost stays registered'
  Check ((ServiceState) -ne $Running) 'and did not stay up'
  Check (RoleFileIs 'host') 'the role is still host'
  Check (@(Get-NetFirewallRule -Name 'MarkiroHost').Count -eq 1) 'with its one firewall rule'
  Check (Test-Path (Join-Path $dataDir 'host.db')) 'the data is untouched'
}
finally {
  Remove-Item -LiteralPath $marker -Force
}
& sc.exe start MarkiroHost | Out-Null
WaitFor { (ServiceState) -eq $Running } 120 'the service runs once the marker is gone'
WaitFor { HostAnswers } 120 'the host answers again after the restore marker'

Step 'another role on a reinstall is refused'
Check ((Install @('/S', '/ROLE=office')) -ne 0) 'the installer refuses /ROLE=office over host'
Check ((ServiceState) -eq $Running) 'the service keeps running'
Check (RoleFileIs 'host') 'the role file is untouched'

Step 'uninstall with the host running removes the service and the rule and keeps the data'
Check ((ServiceState) -eq $Running) 'the host is running when the uninstall starts'
Check (HostAnswers) 'and answers'
Check ((Uninstall) -eq 0) 'the uninstaller succeeds'
WaitFor { (ServiceState) -eq 0 } 30 'MarkiroHost is gone'
Check ($null -eq (Get-Process -Name markiro-host -ErrorAction SilentlyContinue)) 'no markiro-host process is left'
Check (-not (HostAnswers)) 'nothing answers on the port any more'
Check (-not (Test-Path $hostExe)) 'markiro-host.exe could be removed'
Check ($null -eq (Get-NetFirewallRule -Name 'MarkiroHost' -ErrorAction SilentlyContinue)) 'the firewall rule is gone'
foreach ($kept in @('host.db', 'host.json', 'tls\cert.der', 'tls\key.der')) {
  Check (Test-Path (Join-Path $dataDir $kept)) "the data stays: $kept"
}
Check ((Get-Content -Raw (Join-Path $dataDir 'host.json')) -eq $hostJson) 'host.json is what it was'
Check ($null -eq (RunValue)) 'nothing opens at sign-in any more'
Check ($null -eq (RegValue $roleKey 'Role')) 'the registry keeps no role'
Check (-not (Test-Path $roleFile)) 'installation.json is gone'

Step 'role office: no host, no service, no autostart'
Check ((Install @('/S', '/ROLE=office')) -eq 0) 'the installer succeeds'
Check (RoleFileIs 'office') 'installation.json says exactly office'
Check (-not (Test-Path $hostExe)) 'no markiro-host.exe'
Check ((ServiceState) -eq 0) 'no service'
Check ($null -eq (RunValue)) 'the office PC does not open the app at sign-in'
Check ((Uninstall) -eq 0) 'the uninstaller succeeds'

Step 'role station: no host, opens at sign-in'
Check ((Install @('/S', '/ROLE=station')) -eq 0) 'the installer succeeds'
Check (RoleFileIs 'station') 'installation.json says exactly station'
Check (-not (Test-Path $hostExe)) 'no markiro-host.exe'
Check ((ServiceState) -eq 0) 'no service'
Check ($null -ne (RunValue)) 'the station opens at sign-in'
Check ((Uninstall) -eq 0) 'the uninstaller succeeds'
Check (Test-Path (Join-Path $dataDir 'host.db')) 'the host data from the first install is still there'

Write-Host 'standalone installer smoke test passed'
