using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace LasecSimul.NetworkGateway;

internal static class Program
{
    private const int TapSetMediaStatus = 0x00220018;
    private const int MaximumFrameSize = 65536;
    private static readonly ConcurrentDictionary<int, QemuClient> Clients = new();
    private static readonly ConcurrentDictionary<ulong, QemuClient> MacTable = new();
    private static readonly SemaphoreSlim TapWriteLock = new(1, 1);
    private static FileStream? _tap;
    private static int _nextClientId;

    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
            return await SelfTest();
        var tapName = Argument(args, "--tap-name") ?? "LasecSimul TAP";
        var port = int.TryParse(Argument(args, "--port"), out var parsed) ? parsed : 9011;
        while (true)
        {
            try
            {
                await RunGateway(tapName, port);
            }
            catch (Exception ex)
            {
                Log($"gateway reiniciará em 5 segundos: {ex}");
                await Task.Delay(TimeSpan.FromSeconds(5));
            }
        }
    }

    private static async Task RunGateway(string tapName, int port)
    {
        _tap = OpenTap(tapName);
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start(512);
        Log($"gateway ativo: TAP='{tapName}', TCP=127.0.0.1:{port}");
        try
        {
            var completed = await Task.WhenAny(ReadTapLoop(), AcceptLoop(listener));
            await completed;
            throw new IOException("um loop principal do gateway terminou inesperadamente");
        }
        finally
        {
            listener.Stop();
            foreach (var client in Clients.Values) client.Dispose();
            Clients.Clear();
            MacTable.Clear();
            _tap.Dispose();
            _tap = null;
        }
    }

    private static async Task AcceptLoop(TcpListener listener)
    {
        while (true)
        {
            var tcp = await listener.AcceptTcpClientAsync();
            tcp.NoDelay = true;
            var client = new QemuClient(Interlocked.Increment(ref _nextClientId), tcp);
            Clients[client.Id] = client;
            _ = Task.Run(() => ReadClientLoop(client));
        }
    }

    private static async Task<int> SelfTest()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var endpoint = (IPEndPoint)listener.LocalEndpoint;
        var a = new TcpClient();
        var b = new TcpClient();
        await a.ConnectAsync(endpoint.Address, endpoint.Port);
        var acceptA = await listener.AcceptTcpClientAsync();
        await b.ConnectAsync(endpoint.Address, endpoint.Port);
        var acceptB = await listener.AcceptTcpClientAsync();
        var serverA = new QemuClient(1, acceptA);
        var serverB = new QemuClient(2, acceptB);
        Clients[1] = serverA;
        Clients[2] = serverB;
        _ = Task.Run(() => ReadClientLoop(serverA));
        _ = Task.Run(() => ReadClientLoop(serverB));

        var frame = new byte[64];
        Array.Fill<byte>(frame, 0xff, 0, 6);
        new byte[] { 0x02, 0x4c, 0x53, 0x01, 0x01, 0x01 }.CopyTo(frame, 6);
        frame[12] = 0x08; frame[13] = 0x00;
        await WriteQemuFrame(a.GetStream(), frame);
        var received = await ReadQemuFrame(b.GetStream()).WaitAsync(TimeSpan.FromSeconds(3));
        var passed = frame.SequenceEqual(received);
        a.Dispose(); b.Dispose(); listener.Stop();
        Console.WriteLine(passed ? "SELF-TEST OK: framing QEMU e switch multi-cliente" : "SELF-TEST FALHOU");
        return passed ? 0 : 1;
    }

    private static async Task WriteQemuFrame(Stream stream, byte[] frame)
    {
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)frame.Length);
        await stream.WriteAsync(header);
        await stream.WriteAsync(frame);
    }

    private static async Task<byte[]> ReadQemuFrame(Stream stream)
    {
        var header = new byte[4];
        await ReadExactly(stream, header);
        var frame = new byte[BinaryPrimitives.ReadUInt32BigEndian(header)];
        await ReadExactly(stream, frame);
        return frame;
    }

    private static string? Argument(string[] args, string name)
    {
        var index = Array.FindIndex(args, value => value.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static FileStream OpenTap(string interfaceName)
    {
        const string networkClass = "{4D36E972-E325-11CE-BFC1-08002BE10318}";
        using var network = Registry.LocalMachine.OpenSubKey(
            $@"SYSTEM\CurrentControlSet\Control\Network\{networkClass}")
            ?? throw new InvalidOperationException("registro de interfaces de rede não encontrado");
        string? adapterGuid = null;
        foreach (var candidate in network.GetSubKeyNames())
        {
            using var connection = network.OpenSubKey($@"{candidate}\Connection");
            if (string.Equals(connection?.GetValue("Name") as string, interfaceName,
                              StringComparison.OrdinalIgnoreCase))
            {
                adapterGuid = candidate;
                break;
            }
        }
        if (adapterGuid is null) throw new InvalidOperationException($"interface TAP '{interfaceName}' não encontrada");

        var handle = CreateFile($@"\\.\Global\{adapterGuid}.tap", 0xC0000000, 0,
                                IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
        if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "não foi possível abrir a TAP");
        var connected = 1;
        if (!DeviceIoControl(handle, TapSetMediaStatus, ref connected, sizeof(int),
                             IntPtr.Zero, 0, out _, IntPtr.Zero))
        {
            handle.Dispose();
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "não foi possível ativar a TAP");
        }
        return new FileStream(handle, FileAccess.ReadWrite, MaximumFrameSize, isAsync: true);
    }

    private static async Task ReadClientLoop(QemuClient client)
    {
        try
        {
            var stream = client.Tcp.GetStream();
            var header = new byte[4];
            while (true)
            {
                await ReadExactly(stream, header);
                var length = BinaryPrimitives.ReadUInt32BigEndian(header);
                if (length < 14 || length > MaximumFrameSize) throw new IOException($"quadro QEMU inválido: {length}");
                var frame = new byte[length];
                await ReadExactly(stream, frame);
                await FromClient(client, frame);
            }
        }
        catch (Exception ex) when (ex is IOException or SocketException or ObjectDisposedException)
        {
            Log($"QEMU {client.Id} desconectado: {ex.Message}");
        }
        finally
        {
            Clients.TryRemove(client.Id, out _);
            foreach (var entry in MacTable.Where(entry => ReferenceEquals(entry.Value, client)).ToArray())
                MacTable.TryRemove(entry.Key, out _);
            client.Dispose();
        }
    }

    private static async Task FromClient(QemuClient source, byte[] frame)
    {
        var sourceMac = Mac(frame, 6);
        var destinationMac = Mac(frame, 0);
        MacTable[sourceMac] = source;

        QemuClient? target = null;
        var localDestination = !IsGroup(frame[0]) && MacTable.TryGetValue(destinationMac, out target);
        if (localDestination && target is not null && !ReferenceEquals(target, source))
            await target.Send(frame);
        else if (!localDestination)
            await Broadcast(frame, source);

        if (!localDestination && _tap is not null)
        {
            await TapWriteLock.WaitAsync();
            try { await _tap.WriteAsync(frame); }
            finally { TapWriteLock.Release(); }
        }
    }

    private static async Task ReadTapLoop()
    {
        var buffer = new byte[MaximumFrameSize];
        while (_tap is not null)
        {
            var length = await _tap.ReadAsync(buffer);
            if (length < 14) continue;
            var frame = buffer.AsSpan(0, length).ToArray();
            if (MacTable.ContainsKey(Mac(frame, 6))) continue; // eco de um quadro local
            var destination = Mac(frame, 0);
            if (!IsGroup(frame[0]) && MacTable.TryGetValue(destination, out var target))
                await target.Send(frame);
            else
                await Broadcast(frame, null);
        }
    }

    private static async Task Broadcast(byte[] frame, QemuClient? except)
    {
        var sends = Clients.Values.Where(client => !ReferenceEquals(client, except))
                          .Select(client => client.Send(frame));
        await Task.WhenAll(sends);
    }

    private static ulong Mac(byte[] frame, int offset)
    {
        ulong value = 0;
        for (var i = 0; i < 6; ++i) value = (value << 8) | frame[offset + i];
        return value;
    }

    private static bool IsGroup(byte firstOctet) => (firstOctet & 1) != 0;

    private static async Task ReadExactly(Stream stream, byte[] buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset));
            if (read == 0) throw new IOException("fim da conexão");
            offset += read;
        }
    }

    private static void Log(string message)
    {
        try
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "LasecSimul");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "network-gateway.log"), $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch { }
        Console.WriteLine(message);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(SafeFileHandle device, int code, ref int input,
        int inputSize, IntPtr output, int outputSize, out int bytesReturned, IntPtr overlapped);

    private sealed class QemuClient : IDisposable
    {
        private readonly SemaphoreSlim _writeLock = new(1, 1);
        public int Id { get; }
        public TcpClient Tcp { get; }
        public QemuClient(int id, TcpClient tcp) { Id = id; Tcp = tcp; }

        public async Task Send(byte[] frame)
        {
            var header = new byte[4];
            BinaryPrimitives.WriteUInt32BigEndian(header, (uint)frame.Length);
            await _writeLock.WaitAsync();
            try
            {
                var stream = Tcp.GetStream();
                await stream.WriteAsync(header);
                await stream.WriteAsync(frame);
            }
            catch (Exception ex) when (ex is IOException or SocketException or ObjectDisposedException) { }
            finally { _writeLock.Release(); }
        }

        public void Dispose() { Tcp.Dispose(); _writeLock.Dispose(); }
    }
}
