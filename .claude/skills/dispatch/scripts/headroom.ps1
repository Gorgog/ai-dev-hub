# Memory headroom before granting a heavy resource, plus dev-server port check.
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and breaks Cyrillic.
# usage: powershell -NoProfile -File headroom.ps1 [-Ports 3005,3001] [-MinGB 4]
# exit: 0 - OK to grant; 2 - COMMIT headroom below MinGB; 3 - a port is busy or could not be checked.
# -Ports is a string: under -File PowerShell passes "3005,3001" as one token, an [int[]] param would glue it.
param([string]$Ports = '', [double]$MinGB = 4)
$PortList = @($Ports -split '[,; ]+' | Where-Object { $_ -ne '' })
$os = Get-CimInstance Win32_OperatingSystem
$limit = $os.TotalVirtualMemorySize / 1MB
$free = $os.FreeVirtualMemory / 1MB
$used = $limit - $free
$phys = $os.FreePhysicalMemory / 1MB
"COMMIT {0:N1} of {1:N1} GB, headroom {2:N1} GB; free physical {3:N1} GB" -f $used, $limit, $free, $phys
$rc = 0
if ($free -lt $MinGB) { "DO NOT GRANT: headroom below $MinGB GB"; $rc = 2 }
foreach ($p in $PortList) {
  if ($p -notmatch '^\d{1,5}$' -or [int]$p -gt 65535) { "port '$p' INVALID - not checked"; if ($rc -eq 0) { $rc = 3 }; continue }
  $c = Get-NetTCPConnection -LocalPort ([uint16]$p) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) {
    $name = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    "port $p BUSY: PID $($c.OwningProcess) $name"
    if ($rc -eq 0) { $rc = 3 }
  } else { "port $p free" }
}
if ($rc -eq 0) { 'OK' }
exit $rc
