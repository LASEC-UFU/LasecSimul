using System.Diagnostics;
using Microsoft.Win32;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LasecSimul.Setup;

internal static class Program
{
    private const string TapName = "LasecSimul TAP";
    private const int GatewayPort = 9011;
    private const string GatewayTaskName = "LasecSimul Network Gateway";
    private const string ExtensionId = "josuemoraisgh.lasecsimul";
    private const string MachineProductName = "LasecSimul — Componentes da Máquina";
    private const string UninstallRegistryPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LasecSimulMachine";

    public static int Main(string[] args)
    {
        try
        {
            if (args.Contains("--verify-payload", StringComparer.OrdinalIgnoreCase))
                return VerifyPayload();
            if (args.Contains("--machine-status", StringComparer.OrdinalIgnoreCase))
                return PrintMachineStatus();
            if (args.Contains("--uninstall-machine", StringComparer.OrdinalIgnoreCase))
                return IsAdministrator() ? UninstallMachine(args) : RunElevated(args, "--uninstall-machine");
            if (args.Contains("--provision-network", StringComparer.OrdinalIgnoreCase))
                return ProvisionNetwork(args);

            Console.WriteLine("LasecSimul Setup");
            var payloadDir = PreparePayloadDirectory();
            var vsixPath = ExtractResource("PayloadVsix", Path.Combine(payloadDir, "lasecsimul.vsix"));
            var codeCli = ResolveCodeCli();
            if (codeCli is null)
            {
                Console.Error.WriteLine("Nao encontrei a CLI do VS Code/VS Codium.");
                Console.Error.WriteLine("Defina LASECSIMUL_CODE_CLI ou instale o comando 'code' no PATH.");
                Console.Error.WriteLine($"VSIX extraido em: {vsixPath}");
                return 1;
            }

            var installedVersion = GetInstalledExtensionVersion(codeCli);
            var extensionReady = string.Equals(installedVersion, CurrentVersion(), StringComparison.OrdinalIgnoreCase);
            if (extensionReady)
            {
                Console.WriteLine($"Extensão {ExtensionId} {installedVersion} já instalada; reinstalação ignorada.");
            }
            else
            {
                var installExitCode = RunInstall(codeCli, vsixPath);
                extensionReady = installExitCode == 0;
                if (!extensionReady)
                {
                    Console.Error.WriteLine($"Aviso: não foi possível instalar/atualizar a extensão (código {installExitCode}).");
                    Console.Error.WriteLine("Feche todas as janelas do VS Code e execute este instalador novamente.");
                    Console.Error.WriteLine("A instalação/reparação da infraestrutura global continuará agora.");
                }
            }

            var machineStatus = CheckMachineInstallation();
            if (machineStatus.Healthy)
            {
                Console.WriteLine("Infraestrutura global já instalada e saudável; etapa TAP/bridge/gateway ignorada.");
                Console.WriteLine("A remoção da extensão deste usuário não altera os componentes globais.");
                return extensionReady ? 0 : 1;
            }

            Console.WriteLine($"Infraestrutura global ausente ou incompleta: {machineStatus.Details}");
            if (!ShouldProvisionTapInfrastructure(args))
            {
                Console.WriteLine("Instalação do driver TAP, da bridge de rede e do gateway recusada pelo usuário; etapa de rede ignorada.");
                Console.WriteLine("A extensão continua funcionando no modo de rede 'isolated' (sem TAP nem administrador); veja \"lasecsimul.network.mode\".");
                return extensionReady ? 0 : 1;
            }

            Console.WriteLine("A instalação/reparação da máquina requer elevação administrativa.");
            var exitCode = IsAdministrator() ? ProvisionNetwork(args) : RunElevated(args, "--provision-network");
            if (exitCode != 0) return exitCode;
            Console.WriteLine("LasecSimul, TAP, bridge e gateway instalados com sucesso para todos os usuários.");
            return extensionReady ? 0 : 1;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Falha no instalador: {ex.Message}");
            return 1;
        }
    }

    private static bool ShouldProvisionTapInfrastructure(string[] args)
    {
        if (args.Contains("--no-tap", StringComparer.OrdinalIgnoreCase) ||
            args.Contains("--skip-tap", StringComparer.OrdinalIgnoreCase))
            return false;
        if (args.Contains("--install-tap", StringComparer.OrdinalIgnoreCase) ||
            args.Contains("--quiet", StringComparer.OrdinalIgnoreCase))
            return true;

        Console.WriteLine();
        Console.WriteLine("O LasecSimul pode instalar o driver TAP-Windows6, criar uma Windows Network Bridge e");
        Console.WriteLine("registrar um gateway de rede para o modo 'lab-bridge' (a ESP32 simulada aparece na LAN");
        Console.WriteLine("física com IP próprio, via DHCP real). Isso requer elevação administrativa.");
        Console.WriteLine("Sem esses componentes, a extensão continua funcionando normalmente no modo 'isolated'");
        Console.WriteLine("(NAT local por processo, sem TAP nem administrador).");
        Console.Write("Deseja instalar o driver TAP e a infraestrutura de rede agora? (s/N): ");
        var response = Console.ReadLine()?.Trim() ?? string.Empty;
        return response.Equals("s", StringComparison.OrdinalIgnoreCase) ||
               response.Equals("sim", StringComparison.OrdinalIgnoreCase) ||
               response.Equals("y", StringComparison.OrdinalIgnoreCase) ||
               response.Equals("yes", StringComparison.OrdinalIgnoreCase);
    }

    private static int VerifyPayload()
    {
        var required = new[] {
            "PayloadVsix", "NetworkGateway", "TapWindows.OemVista.inf", "TapWindows.devcon.exe", "TapWindows.tap0901.cat",
            "TapWindows.tap0901.sys", "TapWindows.COPYING", "TapWindows.COPYRIGHT.GPL",
            "TapWindows.VERSION.txt", "TapWindows.SourceZip"
        };
        var assembly = Assembly.GetExecutingAssembly();
        foreach (var name in required)
        {
            using var stream = assembly.GetManifestResourceStream(name);
            if (stream is null || stream.Length == 0) throw new InvalidOperationException($"Payload ausente: {name}");
        }
        Console.WriteLine("PAYLOAD OK: VSIX, gateway, driver assinado, licença e fonte TAP-Windows6");
        return 0;
    }

    private static int PrintMachineStatus()
    {
        var status = CheckMachineInstallation();
        Console.WriteLine(status.Healthy ? $"MACHINE STATUS OK: {status.Details}" : $"MACHINE STATUS INCOMPLETE: {status.Details}");
        return status.Healthy ? 0 : 2;
    }

    private static MachineStatus CheckMachineInstallation()
    {
        try
        {
            var programData = MachineProgramDataDirectory();
            var configPath = Path.Combine(programData, "network.json");
            var gatewayPath = Path.Combine(MachineInstallDirectory(), "LasecSimul.NetworkGateway.exe");
            var uninstallerPath = Path.Combine(MachineInstallDirectory(), "LasecSimul.MachineSetup.exe");
            var failures = new List<string>();

            if (!File.Exists(configPath)) failures.Add("network.json ausente");
            else
            {
                try
                {
                    using var config = JsonDocument.Parse(File.ReadAllText(configPath));
                    var root = config.RootElement;
                    if (!root.TryGetProperty("schemaVersion", out var schema) || schema.GetInt32() != 1)
                        failures.Add("network.json incompatível");
                    if (!root.TryGetProperty("gatewayPort", out var port) || port.GetInt32() != GatewayPort)
                        failures.Add("porta global incompatível");
                    if (!root.TryGetProperty("tapInterface", out var tap) || tap.GetString() != TapName)
                        failures.Add("TAP global incompatível");
                }
                catch { failures.Add("network.json inválido"); }
            }
            if (!File.Exists(gatewayPath)) failures.Add("gateway ausente");
            if (!File.Exists(uninstallerPath)) failures.Add("desinstalador global ausente");
            if (!TryGetAdapterIfIndex(TapName, out _)) failures.Add("LasecSimul TAP ausente");

            var task = Run("schtasks.exe", new[] { "/Query", "/TN", GatewayTaskName }, capture: true, acceptFailure: true);
            if (task.ExitCode != 0) failures.Add("tarefa do gateway ausente");
            var bridge = Run("netsh.exe", new[] { "bridge", "show", "adapter" }, capture: true, acceptFailure: true);
            if (bridge.ExitCode != 0 || !bridge.Output.Contains(TapName, StringComparison.OrdinalIgnoreCase))
                failures.Add("TAP não pertence à bridge");
            using (var key = Registry.LocalMachine.OpenSubKey(UninstallRegistryPath))
            {
                if (key is null) failures.Add("registro de desinstalação global ausente");
                else
                {
                    var installedVersion = key.GetValue("DisplayVersion") as string;
                    if (!string.Equals(installedVersion, CurrentVersion(), StringComparison.OrdinalIgnoreCase))
                        failures.Add($"versão global {installedVersion ?? "desconhecida"} difere do instalador {CurrentVersion()}");
                }
            }

            if (failures.Count == 0 && !CanConnectToGateway())
                failures.Add("gateway não responde em 127.0.0.1:9011");
            return failures.Count == 0
                ? new MachineStatus(true, "TAP, bridge, gateway e desinstalador global encontrados")
                : new MachineStatus(false, string.Join("; ", failures));
        }
        catch (Exception ex)
        {
            return new MachineStatus(false, ex.Message);
        }
    }

    private static bool CanConnectToGateway()
    {
        try
        {
            using var client = new TcpClient();
            client.ConnectAsync("127.0.0.1", GatewayPort).Wait(TimeSpan.FromMilliseconds(750));
            return client.Connected;
        }
        catch { return false; }
    }

    private static int ProvisionNetwork(string[] args)
    {
        if (!IsAdministrator())
        {
            Console.Error.WriteLine("O provisionamento de rede precisa ser executado como administrador.");
            return 5;
        }

        // Repair/update is idempotent: release the TAP before replacing the driver or gateway.
        Run("schtasks.exe", new[] { "/End", "/TN", GatewayTaskName },
            capture: true, acceptFailure: true);
        Thread.Sleep(500);

        var programData = MachineProgramDataDirectory();
        var driverDir = Path.Combine(programData, "Drivers", "tap-windows6-9.27.0", "amd64");
        var licenseDir = Path.Combine(programData, "Licenses", "tap-windows6-9.27.0");
        Directory.CreateDirectory(driverDir);
        Directory.CreateDirectory(licenseDir);
        var infPath = ExtractResource("TapWindows.OemVista.inf", Path.Combine(driverDir, "OemVista.inf"));
        var devconPath = ExtractResource("TapWindows.devcon.exe", Path.Combine(driverDir, "devcon.exe"));
        ExtractResource("TapWindows.tap0901.cat", Path.Combine(driverDir, "tap0901.cat"));
        ExtractResource("TapWindows.tap0901.sys", Path.Combine(driverDir, "tap0901.sys"));
        ExtractResource("TapWindows.COPYING", Path.Combine(licenseDir, "COPYING"));
        ExtractResource("TapWindows.COPYRIGHT.GPL", Path.Combine(licenseDir, "COPYRIGHT.GPL"));
        ExtractResource("TapWindows.VERSION.txt", Path.Combine(licenseDir, "VERSION.txt"));
        ExtractResource("TapWindows.SourceZip", Path.Combine(licenseDir, "tap-windows6-9.27.0-source.zip"));

        Console.WriteLine("Instalando o driver TAP-Windows6 9.27.0 assinado...");
        var driverInstall = Run("pnputil.exe", new[] { "/add-driver", infPath, "/install" }, capture: true);
        // pnputil may return ERROR_NO_MORE_ITEMS (259) when the matching package
        // and device are already present/up to date. This is a successful,
        // idempotent outcome for a repair installation.
        if (driverInstall.ExitCode is not (0 or 259 or 3010))
            throw new InvalidOperationException($"pnputil falhou ({driverInstall.ExitCode}): {driverInstall.Output}");
        if (driverInstall.ExitCode == 259)
            Console.WriteLine("O driver TAP já estava instalado e atualizado; continuando a reparação.");

        var tapDeviceInstanceId = EnsureTapAdapter(infPath, devconPath, TapName);
        var requestedPhysical = ValueAfter(args, "--bridge-interface") ?? Environment.GetEnvironmentVariable("LASECSIMUL_BRIDGE_INTERFACE");
        var physical = SelectPhysicalAdapter(requestedPhysical);
        var bridge = ConfigureBridge(physical, TapName);

        var installDir = MachineInstallDirectory();
        Directory.CreateDirectory(installDir);
        var gatewayPath = ExtractResource("NetworkGateway", Path.Combine(installDir, "LasecSimul.NetworkGateway.exe"));
        var uninstallerPath = InstallMachineUninstaller(installDir);
        InstallGatewayTask(gatewayPath);

        var config = new
        {
            schemaVersion = 1,
            mode = "lab-bridge",
            tapInterface = TapName,
            physicalInterface = physical.Name,
            physicalIfIndex = physical.IfIndex,
            tapDeviceInstanceId,
            bridgeGuid = bridge.Guid,
            bridgeCreatedByLasecSimul = bridge.CreatedByLasecSimul,
            gatewayAddress = "127.0.0.1",
            gatewayPort = GatewayPort,
            driver = "TAP-Windows6 9.27.0",
        };
        File.WriteAllText(Path.Combine(programData, "network.json"), JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true }));
        RegisterMachineUninstaller(uninstallerPath, installDir);
        return 0;
    }

    private static string EnsureTapAdapter(string infPath, string devconPath, string desiredName)
    {
        var existingId = GetAdapterPnpDeviceId(desiredName);
        if (!string.IsNullOrWhiteSpace(existingId)) return existingId;

        var previousIds = GetTapAdapterPnpDeviceIds();
        Console.WriteLine("Criando o adaptador LasecSimul TAP com o DevCon assinado pela Microsoft...");
        var install = Run(devconPath, new[] { "install", infPath, @"root\tap0901" },
                          capture: true, acceptFailure: true);
        if (install.ExitCode is not (0 or 1))
            throw new InvalidOperationException($"DevCon falhou ({install.ExitCode}): {install.Output.Trim()}");

        string? createdId = null;
        for (var attempt = 0; attempt < 60; ++attempt)
        {
            createdId = GetTapAdapterPnpDeviceIds().FirstOrDefault(id => !previousIds.Contains(id));
            if (!string.IsNullOrWhiteSpace(createdId)) break;
            Thread.Sleep(500);
        }
        if (string.IsNullOrWhiteSpace(createdId))
            throw new InvalidOperationException(
                $"O DevCon concluiu, mas o novo adaptador TAP não apareceu. Saída: {install.Output.Trim()}");

        try
        {
            var id = PsLiteral(createdId);
            var name = PsLiteral(desiredName);
            RunPowerShell($"$a=Get-NetAdapter -IncludeHidden | Where-Object {{ $_.PnPDeviceID -eq '{id}' }} | Select-Object -First 1; if(-not $a){{exit 2}}; $a | Rename-NetAdapter -NewName '{name}'", false);
        }
        catch
        {
            Run(devconPath, new[] { "remove", $"@{createdId}" }, capture: true, acceptFailure: true);
            throw;
        }

        for (var attempt = 0; attempt < 30; ++attempt)
        {
            if (TryGetAdapterIfIndex(desiredName, out _)) return createdId;
            Thread.Sleep(500);
        }
        throw new InvalidOperationException($"A interface '{desiredName}' foi criada, mas não apareceu no sistema.");
    }

    private static HashSet<string> GetTapAdapterPnpDeviceIds()
    {
        var result = RunPowerShell(
            "$items=Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | " +
            "Where-Object {$_.InterfaceDescription -like 'TAP-Windows Adapter V9*'} | " +
            "ForEach-Object {$_.PnPDeviceID}; $items", true);
        return result.Output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    private static PhysicalAdapter SelectPhysicalAdapter(string? requestedName)
    {
        var command =
            "$default=@{}; " +
            "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | " +
            "Where-Object {$_.State -ne 'Unreachable'} | Sort-Object RouteMetric | ForEach-Object {" +
            "if(-not $default.ContainsKey([int]$_.ifIndex)){$default[[int]$_.ifIndex]=[int]$_.RouteMetric}}; " +
            "$items=Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object {$_.Status -eq 'Up'} | " +
            "ForEach-Object {$metric=if($default.ContainsKey([int]$_.ifIndex)){$default[[int]$_.ifIndex]}else{2147483647}; " +
            "\"$($_.ifIndex)`t$($_.Name)`t$($_.InterfaceDescription)`t$metric\"}; $items";
        var result = RunPowerShell(command, true);
        var adapters = result.Output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split('\t'))
            .Where(parts => parts.Length >= 4 && int.TryParse(parts[0], out _) && int.TryParse(parts[3], out _))
            .Select(parts => new PhysicalAdapter(int.Parse(parts[0]), parts[1], parts[2], int.Parse(parts[3])))
            .Where(item => !item.Name.Equals(TapName, StringComparison.OrdinalIgnoreCase) &&
                           !Regex.IsMatch(item.Name + " " + item.Description,
                               "TAP-Windows|Network Bridge|Ponte de Rede|Loopback|Wi-Fi Direct|Bluetooth|Kernel Debug",
                               RegexOptions.IgnoreCase))
            .OrderBy(item => item.RouteMetric)
            .ThenBy(item => item.IfIndex)
            .ToList();
        if (!string.IsNullOrWhiteSpace(requestedName))
        {
            foreach (var adapter in adapters)
                if (adapter.Name.Equals(requestedName, StringComparison.OrdinalIgnoreCase)) return adapter;
            throw new InvalidOperationException($"Interface física ativa '{requestedName}' não encontrada.");
        }

        var routed = adapters.Where(item => item.RouteMetric != int.MaxValue).ToList();
        if (routed.Count == 1)
        {
            Console.WriteLine($"Interface da rota padrão detectada: {routed[0].Name} ({routed[0].Description})");
            return routed[0];
        }
        var wired = adapters.Where(item => !Regex.IsMatch(item.Name + " " + item.Description, "wi-?fi|wireless|802\\.11", RegexOptions.IgnoreCase)).ToList();
        if (wired.Count == 1) return wired[0];
        var candidates = wired.Count > 0 ? wired : adapters;
        if (candidates.Count == 0) throw new InvalidOperationException("Nenhuma interface física ativa foi encontrada para a bridge.");
        Console.WriteLine("Selecione a interface física que conecta este thin client à LAN:");
        for (var i = 0; i < candidates.Count; ++i) Console.WriteLine($"  {i + 1}. {candidates[i].Name} ({candidates[i].Description})");
        while (true)
        {
            Console.Write("Número: ");
            if (int.TryParse(Console.ReadLine(), out var selection) && selection >= 1 && selection <= candidates.Count)
                return candidates[selection - 1];
        }
    }

    private static BridgeInfo ConfigureBridge(PhysicalAdapter physical, string tapName)
    {
        if (!TryGetAdapterIfIndex(tapName, out var tapIndex))
            throw new InvalidOperationException($"Não foi possível obter o ifIndex de '{tapName}'.");
        var bridgeGuid = FindBridgeGuid();
        var created = bridgeGuid is null;
        if (bridgeGuid is not null && PreviouslyOwnedBridgeGuid() is string ownedGuid &&
            ownedGuid.Equals(bridgeGuid, StringComparison.OrdinalIgnoreCase)) created = true;
        if (bridgeGuid is null)
        {
            var create = Run("netsh.exe", new[] { "bridge", "create", physical.IfIndex.ToString(), tapIndex.ToString() }, capture: true);
            if (create.ExitCode != 0 || LooksLikeNetshHelp(create.Output))
                throw new InvalidOperationException($"Falha ao criar a Windows Network Bridge: {create.Output}");
            Console.WriteLine("Aguardando o Windows concluir a criação da bridge...");
            bridgeGuid = WaitForBridgeGuid(TimeSpan.FromSeconds(45));
            if (bridgeGuid is null)
                throw new InvalidOperationException(
                    "A bridge foi solicitada, mas o adaptador BridgeMP não apareceu em 45 segundos. " +
                    "Verifique 'netsh bridge list' e o Visualizador de Eventos do Windows.");
        }
        else
        {
            AddAdapterToBridge(physical.IfIndex, bridgeGuid);
            AddAdapterToBridge(tapIndex, bridgeGuid);
        }

        string statusOutput = string.Empty;
        var membersVisible = false;
        for (var attempt = 0; attempt < 60; ++attempt)
        {
            var status = Run("netsh.exe", new[] { "bridge", "show", "adapter" }, capture: true, acceptFailure: true);
            statusOutput = status.Output;
            membersVisible = status.ExitCode == 0 &&
                status.Output.Contains(physical.Name, StringComparison.OrdinalIgnoreCase) &&
                status.Output.Contains(tapName, StringComparison.OrdinalIgnoreCase);
            if (membersVisible) break;
            Thread.Sleep(500);
        }
        if (!membersVisible)
            throw new InvalidOperationException($"A bridge foi criada, mas suas interfaces não ficaram visíveis: {statusOutput}");
        Console.WriteLine($"Bridge configurada: {physical.Name} <-> {tapName}");
        return new BridgeInfo(bridgeGuid, created);
    }

    private static string? WaitForBridgeGuid(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var guid = FindBridgeGuid();
            if (guid is not null) return guid;
            Thread.Sleep(500);
        }
        return null;
    }

    private static void AddAdapterToBridge(int adapterIndex, string bridgeGuid)
    {
        var result = Run("netsh.exe", new[] { "bridge", "add", adapterIndex.ToString(), "to", bridgeGuid },
                         capture: true, acceptFailure: true);
        if (result.ExitCode != 0 || LooksLikeNetshHelp(result.Output))
            throw new InvalidOperationException(
                $"Falha ao adicionar a interface {adapterIndex} à bridge {bridgeGuid}: {result.Output}");
    }

    private static bool LooksLikeNetshHelp(string output) =>
        Regex.IsMatch(output, @"(^|\r?\n)\s*(Usage|Utiliza[cç][aã]o)\s*:", RegexOptions.IgnoreCase);

    private static string? FindBridgeGuid()
    {
        var list = Run("netsh.exe", new[] { "bridge", "list" }, capture: true, acceptFailure: true);
        var guid = ExtractGuid(list.Output);
        if (guid is not null) return guid;

        var cim = RunPowerShell(
            "$b=Get-CimInstance Win32_NetworkAdapter -ErrorAction SilentlyContinue | " +
            "Where-Object {$_.ServiceName -eq 'BridgeMP'} | Select-Object -First 1; " +
            "if($b -and $b.GUID){$b.GUID}", true);
        return ExtractGuid(cim.Output);
    }

    private static string? ExtractGuid(string value)
    {
        var match = Regex.Match(value, @"\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?");
        if (!match.Success) return null;
        return $"{{{match.Value.Trim('{', '}').ToUpperInvariant()}}}";
    }

    private static string? PreviouslyOwnedBridgeGuid()
    {
        var configPath = Path.Combine(MachineProgramDataDirectory(), "network.json");
        if (!File.Exists(configPath)) return null;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(configPath));
            var root = document.RootElement;
            return root.TryGetProperty("bridgeCreatedByLasecSimul", out var created) && created.GetBoolean() &&
                   root.TryGetProperty("bridgeGuid", out var guid)
                ? guid.GetString() : null;
        }
        catch { return null; }
    }

    private static void InstallGatewayTask(string gatewayPath)
    {
        var taskCommand = $"\"{gatewayPath}\" --tap-name \"{TapName}\" --port {GatewayPort}";
        var create = Run("schtasks.exe", new[] { "/Create", "/TN", GatewayTaskName, "/TR", taskCommand, "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F" }, capture: true);
        if (create.ExitCode != 0) throw new InvalidOperationException($"Falha ao instalar a tarefa do gateway: {create.Output}");
        Run("schtasks.exe", new[] { "/Run", "/TN", GatewayTaskName }, capture: true);
    }

    private static string InstallMachineUninstaller(string installDir)
    {
        var source = Environment.ProcessPath ?? throw new InvalidOperationException("Caminho do instalador indisponível.");
        var destination = Path.Combine(installDir, "LasecSimul.MachineSetup.exe");
        if (!Path.GetFullPath(source).Equals(Path.GetFullPath(destination), StringComparison.OrdinalIgnoreCase))
            File.Copy(source, destination, overwrite: true);
        return destination;
    }

    private static void RegisterMachineUninstaller(string uninstallerPath, string installDir)
    {
        using var key = Registry.LocalMachine.CreateSubKey(UninstallRegistryPath, writable: true)
            ?? throw new InvalidOperationException("Não foi possível registrar o desinstalador global.");
        var version = CurrentVersion();
        key.SetValue("DisplayName", MachineProductName);
        key.SetValue("DisplayVersion", version);
        key.SetValue("Publisher", "LasecSimul");
        key.SetValue("InstallLocation", installDir);
        key.SetValue("DisplayIcon", $"\"{uninstallerPath}\"");
        key.SetValue("UninstallString", $"\"{uninstallerPath}\" --uninstall-machine");
        key.SetValue("QuietUninstallString", $"\"{uninstallerPath}\" --uninstall-machine --quiet");
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue("EstimatedSize", 180000, RegistryValueKind.DWord);
    }

    private static int UninstallMachine(string[] args)
    {
        var quiet = args.Contains("--quiet", StringComparer.OrdinalIgnoreCase);
        if (!quiet)
        {
            Console.WriteLine("Esta operação remove o gateway, a TAP e a bridge globais de todos os usuários.");
            Console.Write("Digite REMOVER para continuar: ");
            if (!string.Equals(Console.ReadLine(), "REMOVER", StringComparison.Ordinal)) return 1602;
        }

        Run("schtasks.exe", new[] { "/End", "/TN", GatewayTaskName }, capture: true, acceptFailure: true);
        Run("schtasks.exe", new[] { "/Delete", "/TN", GatewayTaskName, "/F" }, capture: true, acceptFailure: true);
        Thread.Sleep(750);

        var configPath = Path.Combine(MachineProgramDataDirectory(), "network.json");
        string? bridgeGuid = null;
        string? tapDeviceInstanceId = null;
        var bridgeCreated = false;
        if (File.Exists(configPath))
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(configPath));
                var root = document.RootElement;
                if (root.TryGetProperty("bridgeGuid", out var guidValue)) bridgeGuid = guidValue.GetString();
                if (root.TryGetProperty("tapDeviceInstanceId", out var idValue)) tapDeviceInstanceId = idValue.GetString();
                if (root.TryGetProperty("bridgeCreatedByLasecSimul", out var createdValue)) bridgeCreated = createdValue.GetBoolean();
            }
            catch (Exception ex) { Console.Error.WriteLine($"Aviso: network.json inválido: {ex.Message}"); }
        }
        tapDeviceInstanceId ??= GetAdapterPnpDeviceId(TapName);

        if (!string.IsNullOrWhiteSpace(bridgeGuid))
        {
            if (bridgeCreated)
                Run("netsh.exe", new[] { "bridge", "destroy", bridgeGuid }, capture: true, acceptFailure: true);
            else if (TryGetAdapterIfIndex(TapName, out var tapIndex))
                Run("netsh.exe", new[] { "bridge", "remove", tapIndex.ToString(), "from", bridgeGuid }, capture: true, acceptFailure: true);
        }

        if (!string.IsNullOrWhiteSpace(tapDeviceInstanceId))
            Run("pnputil.exe", new[] { "/remove-device", tapDeviceInstanceId }, capture: true, acceptFailure: true);

        try { Registry.LocalMachine.DeleteSubKeyTree(UninstallRegistryPath, throwOnMissingSubKey: false); } catch { }
        TryDeleteDirectory(MachineProgramDataDirectory());

        var installDir = MachineInstallDirectory();
        var ownPath = Environment.ProcessPath;
        foreach (var file in Directory.Exists(installDir) ? Directory.EnumerateFiles(installDir) : Array.Empty<string>())
        {
            if (ownPath is not null && Path.GetFullPath(file).Equals(Path.GetFullPath(ownPath), StringComparison.OrdinalIgnoreCase)) continue;
            try { File.Delete(file); } catch { }
        }
        if (!string.IsNullOrWhiteSpace(ownPath)) MoveFileEx(ownPath, null, 0x4);
        MoveFileEx(installDir, null, 0x4);

        Console.WriteLine("Componentes globais removidos. O pacote TAP-Windows6 foi mantido no Driver Store para não afetar OpenVPN ou outro software; o adaptador LasecSimul foi removido.");
        Console.WriteLine("As extensões instaladas nos perfis dos usuários não foram removidas e podem ser desinstaladas pelo próprio VS Code.");
        return 0;
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); } catch { }
    }

    private static string? GetAdapterPnpDeviceId(string name)
    {
        var result = RunPowerShell($"$a=Get-NetAdapter -IncludeHidden -Name '{PsLiteral(name)}' -ErrorAction SilentlyContinue | Select-Object -First 1; if($a){{$a.PnPDeviceID}}", true);
        var value = result.Output.Trim();
        return value.Length == 0 ? null : value;
    }

    private static string MachineInstallDirectory() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "LasecSimul");

    private static string MachineProgramDataDirectory() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "LasecSimul");

    private static string CurrentVersion() =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    private static bool TryGetAdapterIfIndex(string name, out int ifIndex)
    {
        var result = RunPowerShell($"$a=Get-NetAdapter -IncludeHidden -Name '{PsLiteral(name)}' -ErrorAction SilentlyContinue; if($a){{$a.ifIndex}}", true);
        return int.TryParse(result.Output.Trim(), out ifIndex);
    }

    private static int RunElevated(string[] originalArgs, string operation)
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Caminho do instalador indisponível.");
        var info = new ProcessStartInfo { FileName = executable, UseShellExecute = true, Verb = "runas" };
        info.ArgumentList.Add(operation);
        if (originalArgs.Contains("--quiet", StringComparer.OrdinalIgnoreCase))
            info.ArgumentList.Add("--quiet");
        var physical = ValueAfter(originalArgs, "--bridge-interface");
        if (physical is not null) { info.ArgumentList.Add("--bridge-interface"); info.ArgumentList.Add(physical); }
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Não foi possível iniciar o provisionamento elevado.");
        process.WaitForExit();
        return process.ExitCode;
    }

    private static bool IsAdministrator() => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
    private static string? ValueAfter(string[] args, string name) { var i = Array.FindIndex(args, item => item.Equals(name, StringComparison.OrdinalIgnoreCase)); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
    private static string PsLiteral(string value) => value.Replace("'", "''");
    private static CommandResult RunPowerShell(string command, bool capture) => Run("powershell.exe", new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command }, capture);

    private static CommandResult Run(string executable, IEnumerable<string> arguments, bool capture, bool acceptFailure = false)
    {
        var info = new ProcessStartInfo { FileName = executable, UseShellExecute = false, RedirectStandardOutput = capture, RedirectStandardError = capture, CreateNoWindow = capture };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException($"Não foi possível iniciar {executable}.");
        var output = capture ? process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd() : string.Empty;
        process.WaitForExit();
        if (!acceptFailure && process.ExitCode != 0 && !capture) throw new InvalidOperationException($"{executable} falhou com código {process.ExitCode}.");
        return new CommandResult(process.ExitCode, output);
    }

    private static string PreparePayloadDirectory() { var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LasecSimul", "InstallerPayload"); Directory.CreateDirectory(root); return root; }
    private static string ExtractResource(string resourceName, string destination) { Directory.CreateDirectory(Path.GetDirectoryName(destination)!); using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName) ?? throw new InvalidOperationException($"Recurso '{resourceName}' não foi embutido."); using var output = File.Create(destination); stream.CopyTo(output); return destination; }

    private static string? ResolveCodeCli()
    {
        var candidates = new List<string>();
        AddIfPresent(candidates, Environment.GetEnvironmentVariable("LASECSIMUL_CODE_CLI"));
        foreach (var name in new[] { "code.cmd", "code.exe", "code-insiders.cmd", "code-insiders.exe", "codium.cmd", "codium.exe" }) AddIfPresent(candidates, ResolveFromPath(name));
        AddIfPresent(candidates, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Microsoft VS Code", "bin", "code.cmd"));
        AddIfPresent(candidates, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft VS Code", "bin", "code.cmd"));
        return candidates.FirstOrDefault();
    }
    private static void AddIfPresent(ICollection<string> values, string? path) { if (!string.IsNullOrWhiteSpace(path) && File.Exists(path) && !values.Contains(path, StringComparer.OrdinalIgnoreCase)) values.Add(path); }
    private static string? ResolveFromPath(string fileName) { foreach (var part in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) { try { var candidate = Path.Combine(part, fileName); if (File.Exists(candidate)) return candidate; } catch { } } return null; }
    private static string? GetInstalledExtensionVersion(string cli)
    {
        var result = RunCodeCli(cli, new[] { "--list-extensions", "--show-versions" }, capture: true);
        if (result.ExitCode != 0) return null;
        foreach (var rawLine in result.Output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var line = rawLine.Trim();
            var separator = line.LastIndexOf('@');
            if (separator <= 0) continue;
            if (line[..separator].Equals(ExtensionId, StringComparison.OrdinalIgnoreCase))
                return line[(separator + 1)..];
        }
        return null;
    }

    private static int RunInstall(string cli, string vsix) =>
        RunCodeCli(cli, new[] { "--install-extension", vsix, "--force" }, capture: false).ExitCode;

    private static CommandResult RunCodeCli(string cli, IEnumerable<string> arguments, bool capture)
    {
        var info = new ProcessStartInfo
        {
            UseShellExecute = false,
            RedirectStandardOutput = capture,
            RedirectStandardError = capture,
            CreateNoWindow = capture,
        };
        if (cli.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
        {
            info.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            info.ArgumentList.Add("/d");
            info.ArgumentList.Add("/c");
            info.ArgumentList.Add(cli);
        }
        else info.FileName = cli;
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Não foi possível iniciar a CLI do VS Code.");
        var output = capture ? process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd() : string.Empty;
        process.WaitForExit();
        return new CommandResult(process.ExitCode, output);
    }

    private readonly record struct CommandResult(int ExitCode, string Output);
    private readonly record struct PhysicalAdapter(int IfIndex, string Name, string Description, int RouteMetric);
    private readonly record struct BridgeInfo(string Guid, bool CreatedByLasecSimul);
    private readonly record struct MachineStatus(bool Healthy, string Details);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileEx(string existingFileName, string? newFileName, uint flags);
}
