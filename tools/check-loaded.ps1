# 检查「当前运行的 DSH 有没有加载最新的插件代码」
# 判断依据：DSH 主进程启动时间 vs 插件源码最后修改时间。
# 启动时间 >= 修改时间 -> 跑的是新代码；否则 -> 需要重启。
$ErrorActionPreference = 'Stop'

$PluginDir = Split-Path -Parent $PSScriptRoot
$names = @('client.js', 'index.js', 'package.json')
$files = @()
foreach ($n in $names) {
    $p = Join-Path $PluginDir $n
    if (Test-Path $p) { $files += (Get-Item $p) }
}

Write-Host ''
Write-Host '=== DSH 插件加载检查 ===' -ForegroundColor Cyan
Write-Host ('插件目录：' + $PluginDir)

if ($files.Count -eq 0) {
    Write-Host '没找到 client.js / index.js，目录可能不对。' -ForegroundColor Red
    exit 3
}

$newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ('最新改动：' + $newest.Name + '  ' + $newest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))

$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
$start = $null
$mainId = $null
foreach ($p in $procs) {
    try {
        if ($null -eq $start -or $p.StartTime -lt $start) { $start = $p.StartTime; $mainId = $p.Id }
    } catch { }
}

if ($null -eq $start) {
    Write-Host 'DSH 进程：没找到（可能没在运行）' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '结论：先把 DSH 启动起来，再双击这个脚本。' -ForegroundColor Yellow
    exit 2
}

Write-Host ('DSH 进程：PID ' + $mainId + '，启动于 ' + $start.ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ''

if ($start -ge $newest.LastWriteTime) {
    $gap = [int](($start - $newest.LastWriteTime).TotalSeconds)
    Write-Host ('结论：跑的是新代码（启动比最新改动晚 ' + $gap + ' 秒）') -ForegroundColor Green
    exit 0
}

$late = [int](($newest.LastWriteTime - $start).TotalSeconds)
Write-Host ('结论：跑的还是旧代码 —— 代码在启动之后 ' + $late + ' 秒才改的') -ForegroundColor Red
Write-Host '要做的事：重启 DSH；只想试试的话先按 Ctrl+R 刷新页面。' -ForegroundColor Red
exit 1
