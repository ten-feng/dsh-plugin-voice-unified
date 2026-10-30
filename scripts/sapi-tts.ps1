param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Voice = '',
  [int]$Rate = 0,
  [int]$Volume = 100,
  [int]$Pitch = 0,
  [int]$PauseMs = 180
)

# Windows SAPI TTS adapter.
# Contract: on success print exactly one stdout line `OK|<voice>|<bytes>|<path>`,
# on failure exit non-zero and write a readable reason to stderr.
# Pitch is intentionally NOT applied here; the Python DSP engine handles
# pitch/formant so the timbre pipeline stays predictable.  The parameter is
# kept for CLI compatibility.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Fail([string]$message) {
  [Console]::Error.WriteLine($message)
  exit 1
}

try {
  Add-Type -AssemblyName System.Speech
}
catch {
  Fail ("TTS_ENGINE_UNAVAILABLE: System.Speech 加载失败: " + $_.Exception.Message)
}

if (-not (Test-Path -LiteralPath $TextFile)) { Fail "TTS_FAILED: 文本文件不存在: $TextFile" }

try {
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
}
catch {
  Fail ("TTS_FAILED: 读取文本失败: " + $_.Exception.Message)
}
if ([string]::IsNullOrWhiteSpace($text)) { Fail 'TTS_FAILED: TTS text is empty' }

$Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
$PauseMs = [Math]::Max(0, [Math]::Min(5000, $PauseMs))

$synth = $null
try {
  $synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
  if ($voices.Count -eq 0) { Fail 'TTS_ENGINE_UNAVAILABLE: 没有可用的 SAPI 语音' }
  $installed = @($voices | ForEach-Object { $_.VoiceInfo.Name })

  if ([string]::IsNullOrWhiteSpace($Voice) -or $installed -notcontains $Voice) {
    $requested = $Voice
    $zh = @($voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1)
    if ($zh.Count -gt 0) { $Voice = $zh[0].VoiceInfo.Name }
    else { $Voice = $installed[0] }
    if (-not [string]::IsNullOrWhiteSpace($requested)) {
      [Console]::Error.WriteLine("TTS_WARN: 音色不可用 '$requested'，回退到 '$Voice'")
    }
  }

  $synth.SelectVoice($Voice)
  $synth.Rate = $Rate
  $synth.Volume = $Volume

  # Escape XML and insert a short pause after sentence punctuation.  The
  # prosody element only carries the already-applied rate/volume for SSML
  # parsers that ignore synth.Rate; it must not double the rate offset.
  $escaped = [System.Security.SecurityElement]::Escape($text)
  if ($PauseMs -gt 0) {
    $breakTag = '<break time="' + $PauseMs + 'ms"/>'
    $escaped = [regex]::Replace($escaped, '([。！？!?；;])', ('$1' + $breakTag))
  }
  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">' +
          '<voice name="' + [System.Security.SecurityElement]::Escape($Voice) + '">' +
          $escaped + '</voice></speak>'

  $OutFile = [System.IO.Path]::GetFullPath($OutFile)
  $dir = [System.IO.Path]::GetDirectoryName($OutFile)
  if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
  if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }

  $synth.SetOutputToWaveFile($OutFile)
  $synth.SpeakSsml($ssml)
  $synth.SetOutputToNull()

  if (-not (Test-Path -LiteralPath $OutFile)) { Fail "TTS_FAILED: SAPI 未写出文件 $OutFile" }
  $info = Get-Item -LiteralPath $OutFile
  if ($info.Length -le 44) { Fail 'TTS_FAILED: SAPI 生成了空 WAV 文件' }

  Write-Output ("OK|{0}|{1}|{2}" -f $Voice, $info.Length, $OutFile)
  exit 0
}
catch {
  Fail ("TTS_FAILED: " + $_.Exception.Message)
}
finally {
  if ($null -ne $synth) {
    try { $synth.SetOutputToNull() } catch { }
    try { $synth.Dispose() } catch { }
  }
}
