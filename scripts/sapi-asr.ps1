param(
  [Parameter(Mandatory = $true)][string]$WavFile,
  [string]$Culture = 'zh-CN'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

if (-not (Test-Path -LiteralPath $WavFile)) { throw "WAV file not found: $WavFile" }

$cultureInfo = [System.Globalization.CultureInfo]::GetCultureInfo($Culture)
$recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if (-not ($recognizers | Where-Object { $_.Culture.Name -eq $cultureInfo.Name })) {
  throw "No SAPI speech recognizer installed for $Culture"
}

$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($cultureInfo)
try {
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToWaveFile($WavFile)
  $result = $engine.Recognize()
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  if ($result -and $result.Text) {
    Write-Output ('OK|' + $result.Text)
  } else {
    Write-Output 'OK|'
  }
}
finally {
  $engine.Dispose()
}
