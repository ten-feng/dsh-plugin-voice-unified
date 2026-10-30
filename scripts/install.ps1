param(
  [string]$Profile = 'desktop',
  [string]$PluginPath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $PluginPath 'package.json'))) {
  throw "插件目录无效：$PluginPath"
}
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:PROGRAMFILES 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  )
  $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($found) { $dsh = Get-Item $found } else { throw '找不到 dsh 命令。请把 DSH 的 runtime\cli\bin 加入 PATH。' }
}
Write-Host "安装 dsh-voice-unified 到 profile: $Profile"
& $dsh.Source plugin --profile $Profile add "link:$PluginPath"
& $dsh.Source --profile $Profile --dump-config | Select-String 'voice-unified'
Write-Host ''
Write-Host '安装完成。请完全退出并重启 DeepSeek Harness，然后点击左下角「声音」。' -ForegroundColor Green
Write-Host '健康检查：http://127.0.0.1:<端口>/plugins/dsh-voice-unified/api/health'
