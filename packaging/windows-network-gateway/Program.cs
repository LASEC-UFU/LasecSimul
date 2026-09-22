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
        var dhcpDiscover = BuildDhcpDiscoverForSelfTest();
        var dhcpReply = TryBuildDhcpReply(dhcpDiscover, out var dhcpResponse);
        var dhcpPassed = dhcpReply &&
                         dhcpResponse.Length >= 14 + 20 + 8 + 240 &&
                         dhcpResponse[14 + 20 + 8 + 16] == 10 &&
                         dhcpResponse[14 + 20 + 8 + 17] == 42 &&
                         dhcpResponse[14 + 20 + 8 + 18] == 7 &&
                         dhcpResponse[14 + 20 + 8 + 19] == 15;
        a.Dispose(); b.Dispose(); listener.Stop();
        Console.WriteLine(passed && dhcpPassed
            ? "SELF-TEST OK: framing QEMU, switch multi-cliente e DHCP lab-router"
            : "SELF-TEST FALHOU");
        return passed && dhcpPassed ? 0 : 1;
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

        // DHCP crosses the QEMU socket/TAP boundary at layer 3. Intercepting it
        // here avoids binding UDP/67 on the Windows host and lets every client
        // receive the deterministic address encoded by its OpenETH MAC.
        if (TryBuildDhcpReply(frame, out var dhcpReply))
        {
            await source.Send(dhcpReply);
            return;
        }

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

    private static bool TryBuildDhcpReply(byte[] frame, out byte[] reply)
    {
        reply = Array.Empty<byte>();
        if (frame.Length < 14 + 20 + 8 + 240 ||
            frame[12] != 0x08 || frame[13] != 0x00 ||
            frame[6] != 0x02 || frame[7] != 0x4c)
            return false;

        var ip = 14;
        var versionAndIhl = frame[ip];
        var ipHeaderLength = (versionAndIhl & 0x0f) * 4;
        if ((versionAndIhl >> 4) != 4 || ipHeaderLength < 20 || frame.Length < ip + ipHeaderLength + 8)
            return false;
        if (frame[ip + 9] != 17) return false; // UDP

        var udp = ip + ipHeaderLength;
        if (ReadUInt16(frame, udp) != 68 || ReadUInt16(frame, udp + 2) != 67)
            return false;
        var udpLength = ReadUInt16(frame, udp + 4);
        if (udpLength < 8 + 240 || udp + udpLength > frame.Length)
            return false;

        var bootp = udp + 8;
        if (frame[bootp] != 1 || frame[bootp + 1] != 1 || frame[bootp + 2] != 6)
            return false;
        if (frame[bootp + 236] != 0x63 || frame[bootp + 237] != 0x82 ||
            frame[bootp + 238] != 0x53 || frame[bootp + 239] != 0x63)
            return false;
        if (Mac(frame, 6) != ReadMac(frame, bootp + 28)) return false;

        var messageType = ReadDhcpMessageType(frame, bootp + 240, udp + udpLength);
        if (messageType is not (1 or 3)) return false; // DISCOVER or REQUEST

        var networkNamespace = frame[8];
        var slot = frame[9];
        var yiaddr = new byte[] { 10, networkNamespace, slot, 15 };
        var gateway = new byte[] { 10, networkNamespace, 0, 1 };
        var broadcast = (ReadUInt16(frame, bootp + 10) & 0x8000) != 0 || messageType == 1;
        var destinationMac = broadcast ? new byte[] { 0xff, 0xff, 0xff, 0xff, 0xff, 0xff } : frame[6..12];
        var gatewayMac = new byte[] { 0x02, 0x4c, networkNamespace, 0xff, 0xff, 0x01 };

        var options = new List<byte>();
        AddDhcpOption(options, 53, new[] { (byte)(messageType == 1 ? 2 : 5) });
        AddDhcpOption(options, 54, gateway);
        AddDhcpOption(options, 51, new byte[] { 0, 1, 0, 0 }); // 65536 seconds
        AddDhcpOption(options, 1, new byte[] { 255, 255, 0, 0 });
        AddDhcpOption(options, 3, gateway);
        AddDhcpOption(options, 6, gateway);
        options.Add(255);

        var payloadLength = 240 + options.Count;
        var ipLength = 20;
        var udpLengthOut = 8 + payloadLength;
        reply = new byte[14 + ipLength + udpLengthOut];
        destinationMac.CopyTo(reply, 0);
        gatewayMac.CopyTo(reply, 6);
        reply[12] = 0x08; reply[13] = 0x00;

        var outputIp = 14;
        reply[outputIp] = 0x45;
        reply[outputIp + 8] = 64;
        reply[outputIp + 9] = 17;
        WriteUInt16(reply, outputIp + 2, (ushort)(ipLength + udpLengthOut));
        gateway.CopyTo(reply, outputIp + 12);
        (broadcast ? new byte[] { 255, 255, 255, 255 } : yiaddr).CopyTo(reply, outputIp + 16);
        WriteUInt16(reply, outputIp + 10, InternetChecksum(reply, outputIp, ipLength));

        var outputUdp = outputIp + ipLength;
        WriteUInt16(reply, outputUdp, 67);
        WriteUInt16(reply, outputUdp + 2, 68);
        WriteUInt16(reply, outputUdp + 4, (ushort)udpLengthOut);

        var outputBootp = outputUdp + 8;
        reply[outputBootp] = 2;
        reply[outputBootp + 1] = 1;
        reply[outputBootp + 2] = 6;
        Array.Copy(frame, bootp + 4, reply, outputBootp + 4, 8); // xid, secs, flags
        yiaddr.CopyTo(reply, outputBootp + 16);
        Array.Copy(frame, bootp + 28, reply, outputBootp + 28, 16); // chaddr + padding
        reply[outputBootp + 236] = 0x63;
        reply[outputBootp + 237] = 0x82;
        reply[outputBootp + 238] = 0x53;
        reply[outputBootp + 239] = 0x63;
        options.CopyTo(reply, outputBootp + 240);
        WriteUInt16(reply, outputUdp + 6, UdpChecksum(reply, outputIp, outputUdp, udpLengthOut));
        return true;
    }

    private static byte[] BuildDhcpDiscoverForSelfTest()
    {
        var clientMac = new byte[] { 0x02, 0x4c, 42, 7, 0xaa, 0x55 };
        var payload = new byte[240 + 3 + 1];
        payload[0] = 1; payload[1] = 1; payload[2] = 6;
        payload[4] = 0x12; payload[5] = 0x34; payload[6] = 0x56; payload[7] = 0x78;
        clientMac.CopyTo(payload, 28);
        payload[236] = 0x63; payload[237] = 0x82; payload[238] = 0x53; payload[239] = 0x63;
        payload[240] = 53; payload[241] = 1; payload[242] = 1; payload[243] = 255;
        var frame = new byte[14 + 20 + 8 + payload.Length];
        Array.Fill<byte>(frame, 0xff, 0, 6);
        clientMac.CopyTo(frame, 6);
        frame[12] = 0x08; frame[13] = 0x00;
        var ip = 14; frame[ip] = 0x45; frame[ip + 8] = 64; frame[ip + 9] = 17;
        WriteUInt16(frame, ip + 2, (ushort)(20 + 8 + payload.Length));
        WriteUInt16(frame, ip + 10, InternetChecksum(frame, ip, 20));
        var udp = ip + 20; WriteUInt16(frame, udp, 68); WriteUInt16(frame, udp + 2, 67);
        WriteUInt16(frame, udp + 4, (ushort)(8 + payload.Length));
        payload.CopyTo(frame, udp + 8);
        return frame;
    }

    private static int ReadDhcpMessageType(byte[] frame, int offset, int end)
    {
        while (offset < end)
        {
            var tag = frame[offset++];
            if (tag == 255) break;
            if (tag == 0) continue;
            if (offset >= end) return 0;
            var length = frame[offset++];
            if (offset + length > end) return 0;
            if (tag == 53 && length == 1) return frame[offset];
            offset += length;
        }
        return 0;
    }

    private static void AddDhcpOption(List<byte> options, byte tag, byte[] value)
    {
        options.Add(tag); options.Add((byte)value.Length); options.AddRange(value);
    }

    private static ulong ReadMac(byte[] bytes, int offset) =>
        ((ulong)bytes[offset] << 40) | ((ulong)bytes[offset + 1] << 32) |
        ((ulong)bytes[offset + 2] << 24) | ((ulong)bytes[offset + 3] << 16) |
        ((ulong)bytes[offset + 4] << 8) | bytes[offset + 5];

    private static ushort ReadUInt16(byte[] bytes, int offset) =>
        (ushort)((bytes[offset] << 8) | bytes[offset + 1]);

    private static void WriteUInt16(byte[] bytes, int offset, ushort value)
    {
        bytes[offset] = (byte)(value >> 8); bytes[offset + 1] = (byte)value;
    }

    private static ushort InternetChecksum(byte[] bytes, int offset, int length)
    {
        uint sum = 0;
        for (var index = 0; index < length - 1; index += 2) sum += ReadUInt16(bytes, offset + index);
        if ((length & 1) != 0) sum += (uint)(bytes[offset + length - 1] << 8);
        while ((sum >> 16) != 0) sum = (sum & 0xffff) + (sum >> 16);
        return (ushort)~sum;
    }

    private static ushort UdpChecksum(byte[] bytes, int ipOffset, int udpOffset, int udpLength)
    {
        uint sum = 0;
        for (var index = 12; index < 20; index += 2) sum += ReadUInt16(bytes, ipOffset + index);
        sum += 17;
        sum += (uint)udpLength;
        for (var index = 0; index < udpLength - 1; index += 2) sum += ReadUInt16(bytes, udpOffset + index);
        if ((udpLength & 1) != 0) sum += (uint)(bytes[udpOffset + udpLength - 1] << 8);
        while ((sum >> 16) != 0) sum = (sum & 0xffff) + (sum >> 16);
        var checksum = (ushort)~sum;
        return checksum == 0 ? (ushort)0xffff : checksum;
    }

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
