<#
.SYNOPSIS
  Coletor de diagnostico READ-ONLY para "QEMU v0.0.30 nao inicializa" numa maquina de usuario.

.DESCRIPTION
  Roda inteiramente com o que o Windows ja' traz (PowerShell + Get-FileHash + tasklist + Event Log).
  NAO depende de MSYS2, objdump, Visual Studio ou qualquer ferramenta de desenvolvimento.
  NAO modifica nada no sistema (sem instalar, sem desativar antivirus/AppLocker, sem apagar nada).

  Produz um ZIP com:
    - identidade da maquina (Windows, arquitetura, CPUs, PATH, variaveis LASECSIMUL_*, VS Code);
    - qual extensao LasecSimul esta' realmente instalada e o SHA-256 de cada runtime_files[]
      declarado em LASECSIMUL-QEMU-RUNTIME.json, comparado ao manifesto;
    - se o Universal CRT (ucrtbase.dll / api-ms-win-crt-*.dll) existe fisicamente em System32 --
      TODO arquivo do runtime QEMU empacotado depende dele, e o empacotador atual so' testa a
      presenca dessas DLLs na maquina de BUILD (GitHub Actions), nunca na maquina de destino;
    - stdout/stderr/exit code (decimal e hex) de "qemu --version" e "-machine help" com PATH limpo;
    - Zone.Identifier (bloqueio de download) dos arquivos do runtime;
    - status do Windows Defender / AppLocker / WDAC;
    - entradas recentes do Event Log (Application/System) mencionando qemu-system-xtensa.exe ou
      lasecsimul-core.exe.

.USAGE
  powershell -ExecutionPolicy Bypass -File diagnose-vnext-b-user-machine.ps1
  (gera um .zip na area de trabalho do usuario atual; o caminho final e' impresso no fim)
#>

[CmdletBinding()]
param(
  [string]$OutputDirectory = "$env:USERPROFILE\Desktop"
)

$ErrorActionPreference = "Continue"
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$workDir = Join-Path $env:TEMP "LasecSimul-VNEXTB-Diag-$stamp"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$logPath = Join-Path $workDir "00-summary.txt"

function Write-Section {
    param([string]$Title, [scriptblock]$Body)
    "`n===== $Title =====" | Tee-Object -FilePath $logPath -Append | Out-Null
    try {
        & $Body 2>&1 | Tee-Object -FilePath $logPath -Append | Out-Null
    } catch {
        "ERRO ao coletar '$Title': $($_.Exception.Message)" | Tee-Object -FilePath $logPath -Append | Out-Null
    }
}

Write-Section "IDENTIDADE DA MAQUINA" {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    "WindowsCaption: $($os.Caption)"
    "WindowsVersion: $($os.Version) Build $($os.BuildNumber)"
    "Arch: $env:PROCESSOR_ARCHITECTURE"
    "CPUs (logical): $($cs.NumberOfLogicalProcessors)"
    "Hostname: $env:COMPUTERNAME"
    "User: $env:USERNAME"
    "PATH:"
    $env:PATH -split ";" | ForEach-Object { "  $_" }
    "LASECSIMUL_* env vars:"
    Get-ChildItem Env: | Where-Object { $_.Name -like "LASECSIMUL*" } | ForEach-Object { "  $($_.Name)=$($_.Value)" }
}

Write-Section "VS CODE" {
    $codeCmd = Get-Command code -ErrorAction SilentlyContinue
    if ($codeCmd) {
        "code CLI: $($codeCmd.Source)"
        & code --version 2>&1
    } else {
        "code CLI nao encontrado no PATH"
    }
}

# Localiza TODAS as instalacoes da extensao (podem existir varias versoes lado a lado).
$extensionRoots = @()
foreach ($base in @("$env:USERPROFILE\.vscode\extensions", "$env:USERPROFILE\.vscode-insiders\extensions")) {
    if (Test-Path $base) {
        $extensionRoots += Get-ChildItem -Path $base -Directory -Filter "*lasecsimul*" -ErrorAction SilentlyContinue
    }
}

Write-Section "INSTALACOES DA EXTENSAO ENCONTRADAS" {
    if ($extensionRoots.Count -eq 0) {
        "NENHUMA extensao lasecsimul* encontrada em .vscode/extensions ou .vscode-insiders/extensions"
    } else {
        $extensionRoots | ForEach-Object { "  $($_.FullName)  (LastWriteTime=$($_.LastWriteTime))" }
    }
}

$reportIndex = 0
foreach ($extRoot in $extensionRoots) {
    $reportIndex++
    $prefix = "install-$reportIndex"
    $pkgJsonPath = Join-Path $extRoot.FullName "package.json"
    $qemuBinDir = Join-Path $extRoot.FullName "bundled\devices\qemu-esp32\bin"
    $manifestPath = Join-Path $qemuBinDir "LASECSIMUL-QEMU-RUNTIME.json"
    $qemuExe = Join-Path $qemuBinDir "qemu-system-xtensa.exe"
    $coreExe = Join-Path $extRoot.FullName "bundled\core\build\Release\lasecsimul-core.exe"

    Write-Section "[$prefix] IDENTIDADE DA INSTALACAO: $($extRoot.FullName)" {
        if (Test-Path $pkgJsonPath) {
            $pkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
            "extension name=$($pkg.name) version=$($pkg.version)"
        } else {
            "package.json NAO encontrado em $($extRoot.FullName)"
        }
        "qemuBinDir: $qemuBinDir (existe=$(Test-Path $qemuBinDir))"
        "qemuExe: $qemuExe (existe=$(Test-Path $qemuExe))"
        "coreExe: $coreExe (existe=$(Test-Path $coreExe))"
    }

    Write-Section "[$prefix] MANIFESTO LASECSIMUL-QEMU-RUNTIME.json E HASHES" {
        if (-not (Test-Path $manifestPath)) {
            "MANIFESTO AUSENTE: $manifestPath -- pacote incompleto/corrompido ou instalacao antiga (pre-v0.0.30)"
        } else {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
            "sha256 declarado (qemu-system-xtensa.exe): $($manifest.sha256)"
            "certified_release_session_limit: $($manifest.certified_release_session_limit)"
            "runtime_files count: $($manifest.runtime_files.Count)"
            foreach ($f in $manifest.runtime_files) {
                $p = Join-Path $qemuBinDir $f.name
                if (-not (Test-Path $p)) {
                    "  AUSENTE: $($f.name)"
                    continue
                }
                $actual = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
                $status = if ($actual -ieq $f.sha256) { "OK" } else { "HASH_MISMATCH (esperado=$($f.sha256) atual=$actual)" }
                "  $($f.name): $status"
            }
        }
    }

    Write-Section "[$prefix] ARQUIVOS PRESENTES EM bin/ MAS NAO NO MANIFESTO (possivel dependencia dinamica nao capturada)" {
        if ((Test-Path $qemuBinDir) -and (Test-Path $manifestPath)) {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
            $known = @($manifest.runtime_files.name | ForEach-Object { $_.ToLower() })
            Get-ChildItem $qemuBinDir -File | Where-Object {
                $_.Name.ToLower() -notin $known -and $_.Name -ne "LASECSIMUL-QEMU-RUNTIME.json" -and $_.Name -notlike "BUILD-PROVENANCE*"
            } | ForEach-Object { "  $($_.Name)" }
        }
    }

    # ---- Hipotese principal a confirmar/descartar nesta maquina: Universal CRT ausente. ----
    # Todo arquivo do runtime QEMU importa api-ms-win-crt-*.dll/ucrtbase.dll (confirmado via
    # objdump -p no VSIX oficial). O empacotador trata essas DLLs como "sempre presentes no
    # sistema" SE elas existirem fisicamente em System32 da maquina de BUILD (GitHub Actions
    # windows-latest, que tem UCRT nativo) -- nunca testa a maquina de DESTINO. Em qualquer
    # Windows sem o Universal CRT instalado (Windows 7/8/8.1 sem KB2999226/VC++ 2015-2022, ou
    # imagens minimas), TODOS os 44 arquivos do runtime falhariam a carregar com
    # STATUS_DLL_NOT_FOUND (0xC0000135) -- a mesma classe de erro documentada na v0.0.28, so'
    # que agora escondida atras de "system DLL" em vez de aparecer na lista manual incompleta.
    Write-Section "[$prefix] UNIVERSAL CRT NO SYSTEM32 (hipotese principal -- API set nao fisica em Win7/8/8.1)" {
        $sys32 = Join-Path $env:SystemRoot "System32"
        $ucrtCandidates = @(
            "ucrtbase.dll",
            "api-ms-win-crt-runtime-l1-1-0.dll",
            "api-ms-win-crt-heap-l1-1-0.dll",
            "api-ms-win-crt-stdio-l1-1-0.dll"
        )
        foreach ($name in $ucrtCandidates) {
            $p = Join-Path $sys32 $name
            "  $name : presente_fisicamente=$(Test-Path $p) (Windows 10/Server2016+ resolve via API Set mesmo sem arquivo fisico; Windows 7/8/8.1 PRECISA do arquivo fisico ou falha)"
        }
        "OBS: em Windows 10/11/Server2016+ este teste pode dar 'presente_fisicamente=False' e AINDA ASSIM funcionar (API Set Schema resolve em runtime sem arquivo). O teste decisivo e' a secao 'EXECUCAO QEMU COM PATH LIMPO' abaixo -- se ela falhar com exit=0xC0000135 e este SO' for Windows 7/8/8.1, esta e' a causa provavel."
        "VerCaption: $((Get-CimInstance Win32_OperatingSystem).Caption)"
    }

    Write-Section "[$prefix] ZONE.IDENTIFIER (bloqueio de download) NOS ARQUIVOS DO RUNTIME" {
        if (Test-Path $qemuBinDir) {
            Get-ChildItem $qemuBinDir -File | ForEach-Object {
                $zone = Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue
                if ($zone) { "  BLOQUEADO (Zone.Identifier presente): $($_.Name)" }
            }
            "(nenhuma linha acima = nenhum arquivo bloqueado pelo Windows)"
        }
    }

    Write-Section "[$prefix] EXECUCAO QEMU COM PATH LIMPO (--version)" {
        if (Test-Path $qemuExe) {
            $savedPath = $env:PATH
            try {
                $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
                $outFile = Join-Path $workDir "$prefix-qemu-version-stdout.txt"
                $errFile = Join-Path $workDir "$prefix-qemu-version-stderr.txt"
                $p = Start-Process -FilePath $qemuExe -ArgumentList "--version" -WorkingDirectory $qemuBinDir `
                    -NoNewWindow -PassThru -Wait -RedirectStandardOutput $outFile -RedirectStandardError $errFile
                "exit_decimal=$($p.ExitCode)"
                "exit_hex=0x$('{0:X}' -f ([uint32]$p.ExitCode))"
                if ($p.ExitCode -eq -1073741515) { "CLASSIFICACAO: STATUS_DLL_NOT_FOUND (0xC0000135) -- dependencia ausente/loader, ANTES do READY vNext-B" }
                elseif ($p.ExitCode -eq 5) { "CLASSIFICACAO: acesso negado -- possivel Defender/AppLocker/WDAC" }
                elseif ($p.ExitCode -ne 0) { "CLASSIFICACAO: outro codigo -- nao reinterpretar, registrar como esta" }
            } finally { $env:PATH = $savedPath }
        } else {
            "qemu-system-xtensa.exe nao encontrado, pulando execucao"
        }
    }

    Write-Section "[$prefix] EXECUCAO QEMU COM PATH LIMPO (-machine help)" {
        if (Test-Path $qemuExe) {
            $savedPath = $env:PATH
            try {
                $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
                $outFile = Join-Path $workDir "$prefix-qemu-machinehelp-stdout.txt"
                $errFile = Join-Path $workDir "$prefix-qemu-machinehelp-stderr.txt"
                $p = Start-Process -FilePath $qemuExe -ArgumentList "-machine","help" -WorkingDirectory $qemuBinDir `
                    -NoNewWindow -PassThru -Wait -RedirectStandardOutput $outFile -RedirectStandardError $errFile
                "exit_decimal=$($p.ExitCode) exit_hex=0x$('{0:X}' -f ([uint32]$p.ExitCode))"
                if (Test-Path $outFile) {
                    $hasEsp32Simul = Select-String -Path $outFile -Pattern "^esp32-simul" -Quiet
                    "esp32-simul listado: $hasEsp32Simul"
                }
            } finally { $env:PATH = $savedPath }
        }
    }

    Write-Section "[$prefix] EXECUCAO CORE EMPACOTADO COM PATH LIMPO (checagem de loader, 2s)" {
        if (Test-Path $coreExe) {
            $savedPath = $env:PATH
            try {
                $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
                $pipeName = "lasecsimul-diag-$stamp"
                $proc = Start-Process -FilePath $coreExe -ArgumentList "--pipe",$pipeName -WorkingDirectory (Split-Path $coreExe) -NoNewWindow -PassThru
                Start-Sleep -Milliseconds 2000
                if ($proc.HasExited) {
                    "Core terminou sozinho em <2s: exit_decimal=$($proc.ExitCode) exit_hex=0x$('{0:X}' -f ([uint32]$proc.ExitCode)) -- provavel DLL/loader ausente"
                } else {
                    "Core permaneceu vivo apos 2s (loader OK) -- encerrando de forma limpa"
                    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                }
            } finally { $env:PATH = $savedPath }
        } else {
            "lasecsimul-core.exe nao encontrado, pulando execucao"
        }
    }

    Write-Section "[$prefix] TENTATIVA DE BOOT MINIMO esp32-simul (bounded, 5s, sem vNext-B)" {
        if ((Test-Path $qemuExe) -and (Test-Path (Join-Path $qemuBinDir "esp32\rom\bin"))) {
            $savedPath = $env:PATH
            try {
                $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
                $romDir = Join-Path $qemuBinDir "esp32\rom\bin"
                $outFile = Join-Path $workDir "$prefix-qemu-minimal-boot-stdout.txt"
                $errFile = Join-Path $workDir "$prefix-qemu-minimal-boot-stderr.txt"
                $args = @("-M","esp32-simul","-display","none","-L",$romDir,"-accel","tcg,thread=multi")
                $proc = Start-Process -FilePath $qemuExe -ArgumentList $args -WorkingDirectory $qemuBinDir `
                    -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
                Start-Sleep -Milliseconds 5000
                if ($proc.HasExited) {
                    "QEMU terminou sozinho em <=5s: exit_decimal=$($proc.ExitCode) exit_hex=0x$('{0:X}' -f ([uint32]$proc.ExitCode))"
                } else {
                    "QEMU permaneceu vivo apos 5s sem crash imediato (esperado: sem vNext-B/mapping ele fica preso aguardando arena; isto so' prova que passou do loader e chegou em qemu_init) -- encerrando"
                    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                }
                "--- stderr (primeiras linhas) ---"
                if (Test-Path $errFile) { Get-Content $errFile -TotalCount 40 }
            } finally { $env:PATH = $savedPath }
        }
    }
}

Write-Section "WINDOWS DEFENDER" {
    try {
        $mp = Get-MpComputerStatus -ErrorAction Stop
        "RealTimeProtectionEnabled: $($mp.RealTimeProtectionEnabled)"
        "AntivirusEnabled: $($mp.AntivirusEnabled)"
        "IsTamperProtected: $($mp.IsTamperProtected)"
    } catch { "Get-MpComputerStatus indisponivel ou negado: $($_.Exception.Message)" }
}

Write-Section "APPLOCKER / WDAC" {
    try {
        $polAppLocker = Get-AppLockerPolicy -Effective -ErrorAction Stop
        "AppLocker RuleCollections: $($polAppLocker.RuleCollections.Count)"
    } catch { "Get-AppLockerPolicy indisponivel/negado (normal se AppLocker nao estiver configurado): $($_.Exception.Message)" }
    try {
        $ci = Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction Stop
        "CodeIntegrityPolicyEnforcementStatus: $($ci.CodeIntegrityPolicyEnforcementStatus)"
    } catch { "WDAC CIM class indisponivel: $($_.Exception.Message)" }
}

Write-Section "EVENT LOG (Application/System, ultimas 24h, filtrando qemu/lasecsimul)" {
    $since = (Get-Date).AddHours(-24)
    foreach ($logName in @("Application", "System")) {
        try {
            Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $since } -ErrorAction Stop |
                Where-Object { $_.Message -match "qemu-system-xtensa|lasecsimul-core" } |
                Select-Object TimeCreated, Id, ProviderName, LevelDisplayName, @{n="Message";e={$_.Message.Substring(0, [Math]::Min(500, $_.Message.Length))}} |
                Format-List | Out-String -Width 300
        } catch { "Sem entradas em '$logName' ou acesso negado: $($_.Exception.Message)" }
    }
}

Write-Section "PROCESSOS QEMU/CORE ORFAOS NO MOMENTO DA COLETA" {
    Get-Process -Name "qemu-system-xtensa","lasecsimul-core" -ErrorAction SilentlyContinue |
        Select-Object Id, ProcessName, StartTime, @{n="RunningSeconds";e={((Get-Date) - $_.StartTime).TotalSeconds}}
}

if (-not (Test-Path $OutputDirectory)) { New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null }
$zipPath = Join-Path $OutputDirectory "LasecSimul-VNEXTB-Diag-$stamp.zip"
Compress-Archive -Path (Join-Path $workDir "*") -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Diagnostico concluido. Envie este arquivo para analise:"
Write-Host "  $zipPath"
