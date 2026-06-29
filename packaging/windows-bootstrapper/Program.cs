using System.Diagnostics;
using System.Reflection;

namespace LasecSimul.Setup;

internal static class Program
{
    private const string PayloadResourceName = "PayloadVsix";

    public static int Main(string[] args)
    {
        try
        {
            Console.WriteLine("LasecSimul Setup");
            var payloadDir = PreparePayloadDirectory();
            var vsixPath = ExtractVsixPayload(payloadDir);
            var codeCli = ResolveCodeCli();

            if (codeCli is null)
            {
                Console.Error.WriteLine("Nao encontrei a CLI do VS Code/VS Codium.");
                Console.Error.WriteLine("Defina LASECSIMUL_CODE_CLI ou instale o comando 'code' no PATH.");
                Console.Error.WriteLine($"VSIX extraido em: {vsixPath}");
                return 1;
            }

            var exitCode = RunInstall(codeCli, vsixPath);
            if (exitCode != 0)
            {
                Console.Error.WriteLine($"Falha ao instalar a extensao. Codigo de saida: {exitCode}");
                Console.Error.WriteLine($"VSIX extraido em: {vsixPath}");
                return exitCode;
            }

            Console.WriteLine($"LasecSimul instalado com sucesso via {codeCli}.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Falha no instalador: {ex.Message}");
            return 1;
        }
    }

    private static string PreparePayloadDirectory()
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LasecSimul",
            "InstallerPayload");
        Directory.CreateDirectory(root);
        return root;
    }

    private static string ExtractVsixPayload(string payloadDir)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream(PayloadResourceName)
            ?? throw new InvalidOperationException("Payload VSIX nao foi embutido no instalador.");

        var vsixPath = Path.Combine(payloadDir, "lasecsimul.vsix");
        using var output = File.Create(vsixPath);
        stream.CopyTo(output);
        output.Flush();
        return vsixPath;
    }

    private static string? ResolveCodeCli()
    {
        var candidates = new List<string>();

        AddIfPresent(candidates, Environment.GetEnvironmentVariable("LASECSIMUL_CODE_CLI"));

        foreach (var cliName in new[] { "code.cmd", "code.exe", "code-insiders.cmd", "code-insiders.exe", "codium.cmd", "codium.exe", "code-oss.cmd", "code-oss.exe" })
        {
            AddIfPresent(candidates, ResolveFromPath(cliName));
        }

        AddIfPresent(candidates, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Microsoft VS Code", "bin", "code.cmd"));
        AddIfPresent(candidates, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"));
        AddIfPresent(candidates, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "VSCodium", "bin", "codium.cmd"));

        AddIfPresent(candidates, CombineIfPresent(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft VS Code", "bin", "code.cmd"));
        AddIfPresent(candidates, CombineIfPresent(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"));
        AddIfPresent(candidates, CombineIfPresent(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "VSCodium", "bin", "codium.cmd"));

        AddIfPresent(candidates, CombineIfPresent(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft VS Code", "bin", "code.cmd"));
        AddIfPresent(candidates, CombineIfPresent(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"));

        return candidates.FirstOrDefault();
    }

    private static string? CombineIfPresent(string root, params string[] segments)
    {
        if (string.IsNullOrWhiteSpace(root)) return null;
        var path = root;
        foreach (var segment in segments) path = Path.Combine(path, segment);
        return File.Exists(path) ? path : null;
    }

    private static void AddIfPresent(ICollection<string> candidates, string? path)
    {
        if (!string.IsNullOrWhiteSpace(path) && File.Exists(path) && !candidates.Contains(path, StringComparer.OrdinalIgnoreCase))
        {
            candidates.Add(path);
        }
    }

    private static string? ResolveFromPath(string fileName)
    {
        var pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(pathEnv)) return null;

        foreach (var part in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(part, fileName);
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
            }
        }

        return null;
    }

    private static int RunInstall(string codeCliPath, string vsixPath)
    {
        var isCmdScript = codeCliPath.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || codeCliPath.EndsWith(".bat", StringComparison.OrdinalIgnoreCase);
        var startInfo = isCmdScript
            ? new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
                Arguments = $"/c \"\"{codeCliPath}\" --install-extension \"{vsixPath}\" --force\"",
                UseShellExecute = false,
            }
            : new ProcessStartInfo
            {
                FileName = codeCliPath,
                Arguments = $"--install-extension \"{vsixPath}\" --force",
                UseShellExecute = false,
            };

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Nao foi possivel iniciar a CLI do editor.");
        process.WaitForExit();
        return process.ExitCode;
    }
}
