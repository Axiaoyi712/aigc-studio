param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$studioRoot = $PSScriptRoot
$startupMutex = [System.Threading.Mutex]::new($false, 'Local\MyAIGC_Studio_Startup')
$ownsStartup = $false
try {
try { $ownsStartup = $startupMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsStartup = $true }
if (-not $ownsStartup) { Write-Host '创作台正在启动，请等待已有启动窗口完成。'; return }
Write-Host '正在检查 ComfyUI 与创作台…'
& (Join-Path $studioRoot 'scripts\start-comfy.ps1') -StudioRoot $studioRoot
$statePath = Join-Path $studioRoot 'data\server.json'
$studioUrl = $null

if (Test-Path -LiteralPath $statePath) {
    try {
        $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $status = Invoke-RestMethod -Uri ($previous.url + '/api/status') -TimeoutSec 3
        if ($status.PSObject.Properties.Name -contains 'engineUrl') { $studioUrl = $previous.url }
    } catch { }
}

if (-not $studioUrl) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw '未找到 Node.js。此创作台需要 Node.js 22 或以上。' }
    $nodeVersion = & $nodeCommand.Source --version
    if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 版本过低，需要 22 或以上。' }
    $dataDirectory = Join-Path $studioRoot 'data'
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    $serverScript = Join-Path $studioRoot 'server.mjs'
    $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList @('"' + $serverScript + '"') -WorkingDirectory $studioRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDirectory 'server.log') -RedirectStandardError (Join-Path $dataDirectory 'server-error.log')
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 400
        if ($process.HasExited) { throw ('创作台未能启动，请查看 ' + (Join-Path $dataDirectory 'server-error.log')) }
        try {
            $current = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            if ($current.pid -ne $process.Id) { continue }
            $status = Invoke-RestMethod -Uri ($current.url + '/api/status') -TimeoutSec 3
            $studioUrl = $current.url
            break
        } catch { }
    }
    if (-not $studioUrl) { throw '启动等待超时，请查看 data 目录中的运行日志。' }
}
Write-Host ('我的 AIGC：' + $studioUrl)
if (-not $NoBrowser) { Start-Process $studioUrl }
} finally {
    if ($ownsStartup) { $startupMutex.ReleaseMutex() }
    $startupMutex.Dispose()
}
