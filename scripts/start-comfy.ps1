param([Parameter(Mandatory=$true)][string]$StudioRoot)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath (Join-Path $StudioRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$comfyRoot=[System.IO.Path]::GetFullPath($config.comfyRoot)
$portableRoot=Split-Path -Parent $comfyRoot
$pythonPath=Join-Path $portableRoot 'python_embeded\python.exe'
$mainPath=Join-Path $comfyRoot 'main.py'
$dataRoot=Join-Path $StudioRoot 'data'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$recordPath=Join-Path $dataRoot 'comfy-server.json'
$stdout=Join-Path $dataRoot 'comfy.log'
$stderr=Join-Path $dataRoot 'comfy-error.log'
$mutex=[System.Threading.Mutex]::new($false,'Local\ComfyUI_NVIDIA_PortCheck')
$owns=$false

function Get-Stats([int]$Port) {
    try {
        $request=[System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/system_stats")
        $request.Proxy=$null; $request.Timeout=2000
        $response=$request.GetResponse()
        $reader=[System.IO.StreamReader]::new($response.GetResponseStream())
        try { $stats=$reader.ReadToEnd()|ConvertFrom-Json } finally { $reader.Dispose(); $response.Dispose() }
        if($stats.system.comfyui_version){return $stats}
    } catch { }
    return $null
}
function Save-Engine([int]$Port,[int]$BackendPID,[string]$Status) {
    $record=[ordered]@{CheckedAt=[DateTimeOffset]::Now.ToString('o');Status=$Status;Port=$Port;URL="http://127.0.0.1:$Port";BackendPID=$BackendPID}
    $temporary=$recordPath+'.tmp'
    [System.IO.File]::WriteAllText($temporary,($record|ConvertTo-Json),[System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $recordPath -Force
}
function Get-BackendPorts([int]$BackendPID) {
    return @(Get-NetTCPConnection -State Listen -OwningProcess $BackendPID -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::')} | Select-Object -ExpandProperty LocalPort -Unique)
}
try {
    if(-not(Test-Path -LiteralPath $pythonPath) -or -not(Test-Path -LiteralPath $mainPath)){throw '没有找到配置的 ComfyUI Python 或 main.py，请检查 config.json。'}
    try { $owns=$mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $owns=$true }
    if(-not $owns){throw '另一个 ComfyUI 启动检查正在进行，请稍候。'}
    $backends=@(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" | Where-Object {$_.ExecutablePath -eq $pythonPath -and $_.CommandLine -match '(?i)(?:[\\/]|\s|\")main\.py(?:\s|\"|$)'})
    if($backends.Count -gt 1){throw '检测到多个属于此环境的 ComfyUI 后台，请先确认要使用哪一个，避免错误连接。'}
    $child=$null
    $port=0
    if($backends.Count){
        $backendId=[int]$backends[0].ProcessId
        Write-Host '检测到 ComfyUI 后台，正在等待服务就绪…'
    } else {
        $preferred=([uri]$config.comfyUrl).Port
        $preferencePath=Join-Path $portableRoot '.launcher\preference.json'
        if(Test-Path -LiteralPath $preferencePath){$preferences=Get-Content -LiteralPath $preferencePath -Raw -Encoding UTF8|ConvertFrom-Json;if($preferences.args.port){$preferred=[int]$preferences.args.port}}
        foreach($candidate in (@($preferred)+@(18190..18209)|Select-Object -Unique)){
            if($candidate -lt 1 -or $candidate -gt 65535){continue}
            $listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$candidate)
            try {$listener.ExclusiveAddressUse=$true;$listener.Start();$port=$candidate;break} catch { } finally {$listener.Stop()}
        }
        if(-not $port){throw '未找到可用的 ComfyUI 本机端口。'}
        # Reuse the flags already verified for this installed NVIDIA environment; let the studio open the browser.
        $arguments=@('-s',('"'+$mainPath+'"'),'--listen','127.0.0.1','--port',[string]$port,'--windows-standalone-build','--preview-method','auto','--disable-xformers','--use-pytorch-cross-attention','--cuda-malloc')
        Write-Host ('正在启动 ComfyUI，端口 '+$port+'，请稍候…')
        $child=Start-Process -FilePath $pythonPath -ArgumentList $arguments -WorkingDirectory $portableRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $backendId=$child.Id
        Save-Engine $port $backendId 'Starting'
    }
    $deadline=[DateTime]::UtcNow.AddSeconds(180)
    $attempt=0
    while([DateTime]::UtcNow -lt $deadline){
        if(-not(Get-Process -Id $backendId -ErrorAction SilentlyContinue)){throw ('ComfyUI 启动进程已退出，请查看 '+$stderr)}
        $ports=if($port){@($port)}else{Get-BackendPorts $backendId}
        foreach($currentPort in $ports){
            $stats=Get-Stats $currentPort
            if($stats){Save-Engine $currentPort $backendId 'Ready';Write-Host ('ComfyUI 已就绪：http://127.0.0.1:'+$currentPort);return}
        }
        if($attempt%10 -eq 0){Write-Host 'ComfyUI 正在加载启动组件…'}
        $attempt++
        Start-Sleep -Milliseconds 500
    }
    throw ('等待 ComfyUI 就绪超时。为避免重复启动，后台进程已保留；请查看 '+$stderr+' 后再试。')
} finally {
    if($owns){$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
