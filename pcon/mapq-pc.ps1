# mapq PC - Hilfsprogramm fuer mapq.at/pcon
#
# Meldet alle paar Sekunden "PC ist an" an mapq.at und fuehrt die Befehle von mapq.at/pcon aus:
# Ausschalten, Neustart, Energiesparen, Sperren. Sonst macht es nichts - es liest keine Dateien
# und oeffnet keine Verbindung von aussen. Es laeuft unsichtbar, solange du angemeldet bist.
# Entfernen: auf mapq.at/pcon unter "Einrichten" den Befehl zum Entfernen kopieren.
#
# Diese Datei ist eine Vorlage: mapq.at/pcon setzt Adresse und Schluessel ein.

$Adresse = '__URL__/rest/v1/rpc/mapq_pc_melden'
$ApiKey = '__KEY__'
$PcSchluessel = '__TOKEN__'
$Version = 1
$Trocken = $env:MAPQ_PC_TROCKEN -eq '1'   # nur zum Testen: Befehle anzeigen statt ausfuehren

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

# Nur einmal laufen lassen
$Sperre = New-Object System.Threading.Mutex($false, 'Local\mapq-pc')
if (-not $Sperre.WaitOne(0)) { exit }

function Infos {
  $i = [ordered]@{ computer = $env:COMPUTERNAME; benutzer = $env:USERNAME; version = $Version }
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $i.system = $os.Caption
    $i.seit = $os.LastBootUpTime.ToUniversalTime().ToString('o')
  } catch {}
  try {
    # Netzwerkkarte fuer Wake-on-LAN: am liebsten die mit Kabel
    $n = Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Sort-Object { $_.MediaType -ne '802.3' } | Select-Object -First 1
    if ($n) {
      $i.netz = $n.Name
      $i.mac = ($n.MacAddress -replace '-', ':')
      $i.kabel = ($n.MediaType -eq '802.3')
      $ip = Get-NetIPAddress -InterfaceIndex $n.ifIndex -AddressFamily IPv4 | Select-Object -First 1
      if ($ip) { $i.ip = $ip.IPAddress; $i.praefix = [int]$ip.PrefixLength }
    }
  } catch {}
  return $i
}

function Ausfuehren([string]$Befehl) {
  if ($Trocken) { Write-Output "BEFEHL $Befehl"; return }
  switch ($Befehl) {
    'aus'      { shutdown.exe /s /t 10 /c "mapq.at: Der PC wird ausgeschaltet." }
    'neustart' { shutdown.exe /r /t 10 /c "mapq.at: Der PC startet neu." }
    'schlafen' { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) }
    'sperren'  { rundll32.exe user32.dll,LockWorkStation }
  }
}

$InfoZeit = [datetime]::MinValue
$Fehler = 0
while ($true) {
  $Warten = 5
  $Daten = @{ p_token = $PcSchluessel }
  if (((Get-Date) - $InfoZeit).TotalMinutes -ge 10) { $Daten.p_info = Infos }
  try {
    $Json = ConvertTo-Json $Daten -Depth 4 -Compress
    $Antwort = Invoke-RestMethod -Method Post -Uri $Adresse -Headers @{ apikey = $ApiKey } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Json)) -TimeoutSec 20
    $Fehler = 0
    if ($Daten.p_info) { $InfoZeit = Get-Date }
    if ($Antwort.ok -eq $false) { $Warten = 60 }   # Schluessel gilt nicht mehr (auf der Seite neu erstellt)
    elseif ($Antwort.befehl) { Ausfuehren $Antwort.befehl }
  } catch {
    $Fehler++
    $Warten = [Math]::Min(5 + 5 * $Fehler, 30)    # kein Internet: seltener versuchen
  }
  Start-Sleep -Seconds $Warten
}
