import argparse
import configparser
from datetime import datetime
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
import shlex

import serial


DEFAULT_ESP_UDP_PORT = 47268
DEFAULT_BAUDRATE = 1200
CONNECT_INTERVAL = 5.0
PACTWARE_BASE_COM = 20
MIN_KIT_ID = 0
MAX_KIT_ID = 8
READ_SIZE = 256


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def read_kit_id(root: Path) -> str:
    config = configparser.ConfigParser()
    ini_path = root / "platformio.ini"
    if not config.read(ini_path, encoding="utf-8"):
        raise FileNotFoundError(f"Nao consegui ler {ini_path}")
    return config.get("data", "kitId", fallback="0").strip()


def kit_ports(kit_id: int) -> tuple[str, str]:
    if kit_id < MIN_KIT_ID or kit_id > MAX_KIT_ID:
        raise ValueError(f"kitId deve estar entre {MIN_KIT_ID} e {MAX_KIT_ID}")
    return f"CNCB{kit_id}", f"COM{PACTWARE_BASE_COM + kit_id}"


def available_serial_ports() -> set[str]:
    ports: set[str] = set()
    if sys.platform.startswith("win"):
        ps_script = (
            "Get-CimInstance Win32_SerialPort | "
            "Select-Object -ExpandProperty DeviceID | ConvertTo-Json -Compress"
        )
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_script],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            output = result.stdout.strip()
            if output:
                parsed = json.loads(output)
                if isinstance(parsed, str):
                    parsed = [parsed]
                ports.update(str(port).upper() for port in parsed)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass

    from serial.tools import list_ports

    ports.update(port.device.upper() for port in list_ports.comports())

    return ports


def validate_serial_pair(args: argparse.Namespace) -> None:
    ports = available_serial_ports()
    missing = []
    if args.serial.upper() not in ports:
        missing.append(args.serial)
    if args.pactware_port.upper() not in ports:
        missing.append(args.pactware_port)
    if missing:
        known = ", ".join(sorted(ports))
        raise serial.SerialException(
            "Porta virtual nao encontrada: "
            + ", ".join(missing)
            + f". Portas detectadas: {known}"
        )


def local_ip_for_remote(host: str, port: int) -> str:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect((host, port))
        return probe.getsockname()[0]
    finally:
        probe.close()


def hex_dump(data: bytes) -> str:
    return " ".join(f"{byte:02X}" for byte in data)


def show_received(source: str, data: bytes) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"[{timestamp}] {source} RX ({len(data)} bytes): {hex_dump(data)}", flush=True)


def open_serial(port: str, baudrate: int) -> serial.Serial:
    errors = []
    candidates = [port]
    if sys.platform.startswith("win") and not port.startswith("\\\\.\\"):
        candidates.append(f"\\\\.\\{port}")

    for candidate in candidates:
        try:
            return serial.Serial(
                port=candidate,
                baudrate=baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_ODD,
                stopbits=serial.STOPBITS_ONE,
                timeout=0.05,
                write_timeout=1,
            )
        except serial.SerialException as exc:
            errors.append(f"{candidate}: {exc}")

    raise serial.SerialException(" | ".join(errors))


def udp_to_serial(
    sock: socket.socket,
    ser: serial.Serial,
    esp_addr: tuple[str, int],
    stop: threading.Event,
    verbose: bool,
    pactware_port: str,
) -> None:
    warned_timeout = False
    while not stop.is_set():
        try:
            data, addr = sock.recvfrom(2048)
        except socket.timeout:
            continue
        except OSError:
            break

        if addr != esp_addr:
            continue

        if data.startswith(b"CONNECT:") or data.startswith(b"DISCONNECT:"):
            if verbose:
                print(data.decode(errors="replace").strip())
            continue

        if data:
            show_received("UDP", data)
            try:
                ser.write(data)
                warned_timeout = False
            except serial.SerialTimeoutException:
                if not warned_timeout:
                    print(
                        "Timeout escrevendo na serial virtual. "
                        f"Confira se o PACTware esta conectado em {pactware_port} "
                        "e se nenhum outro programa esta usando essa porta."
                    )
                    warned_timeout = True
                continue
            except serial.SerialException as exc:
                print(f"Erro escrevendo na serial virtual: {exc}")
                stop.set()
                break


def serial_to_udp(
    sock: socket.socket,
    ser: serial.Serial,
    esp_addr: tuple[str, int],
    stop: threading.Event,
) -> None:
    while not stop.is_set():
        try:
            data = ser.read(READ_SIZE)
        except serial.SerialException as exc:
            print(f"Erro na serial: {exc}")
            stop.set()
            break

        if data:
            show_received("SERIAL", data)
            try:
                sock.sendto(data, esp_addr)
            except OSError as exc:
                print(f"Erro enviando UDP para o ESP32: {exc}")
                stop.set()
                break


def parse_args() -> argparse.Namespace:
    root = project_root()
    ini_kit_id = int(read_kit_id(root))
    try:
        default_serial, default_pactware_port = kit_ports(ini_kit_id)
    except ValueError as exc:
        raise SystemExit(str(exc))
    default_host = f"iikit{ini_kit_id}.local"

    parser = argparse.ArgumentParser(
        description="Ponte HART entre a porta serial virtual do PACTware e o UDP do ESP32."
    )
    parser.add_argument(
        "--kit-id",
        type=int,
        default=ini_kit_id,
        help=f"ID do kit. Padrao: {ini_kit_id} lido do platformio.ini",
    )
    parser.add_argument("--serial", default=default_serial, help=f"Porta serial virtual. Padrao: {default_serial}")
    parser.add_argument("--host", default=default_host, help=f"Host/IP do ESP32. Padrao: {default_host}")
    parser.add_argument("--udp-port", type=int, default=DEFAULT_ESP_UDP_PORT, help="Porta UDP do ESP32.")
    parser.add_argument("--baudrate", type=int, default=DEFAULT_BAUDRATE, help="Baudrate serial.")
    parser.add_argument("--listen-port", type=int, default=0, help="Porta UDP local. 0 escolhe automaticamente.")
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="Nao encerra outras instancias do pactware_udp_bridge.py antes de iniciar.",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Mostra tambem mensagens de controle UDP.")
    args = parser.parse_args()

    if args.kit_id != ini_kit_id:
        try:
            serial_from_kit, default_pactware_port = kit_ports(args.kit_id)
        except ValueError as exc:
            parser.error(str(exc))
        if "--serial" not in sys.argv:
            args.serial = serial_from_kit
        if "--host" not in sys.argv:
            args.host = f"iikit{args.kit_id}.local"

    args.pactware_port = default_pactware_port
    return args


def command_targets_same_bridge(command_line: str, args: argparse.Namespace, ini_kit_id: int) -> bool:
    try:
        parts = shlex.split(command_line, posix=False)
    except ValueError:
        parts = command_line.split()

    requested_serial = args.serial.upper()
    requested_kit = str(args.kit_id)

    for index, part in enumerate(parts):
        cleaned = part.strip("\"'").upper()
        if cleaned == requested_serial:
            return True
        if cleaned == "--SERIAL" and index + 1 < len(parts):
            if parts[index + 1].strip("\"'").upper() == requested_serial:
                return True
        if cleaned.startswith("--SERIAL="):
            if cleaned.split("=", 1)[1].strip("\"'").upper() == requested_serial:
                return True
        if cleaned == "--KIT-ID" and index + 1 < len(parts):
            if parts[index + 1].strip("\"'") == requested_kit:
                return True
        if cleaned.startswith("--KIT-ID="):
            if cleaned.split("=", 1)[1].strip("\"'") == requested_kit:
                return True

    has_explicit_serial = any(part.strip("\"'").upper().startswith("--SERIAL") for part in parts)
    has_explicit_kit = any(part.strip("\"'").upper().startswith("--KIT-ID") for part in parts)
    return not has_explicit_serial and not has_explicit_kit and args.kit_id == ini_kit_id


def kill_existing_bridges(args: argparse.Namespace) -> None:
    if not sys.platform.startswith("win"):
        return

    ps_script = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -like 'python*.exe' -and $_.CommandLine -like '*pactware_udp_bridge.py*' } | "
        "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return

    output = result.stdout.strip()
    if not output:
        return

    try:
        processes = json.loads(output)
    except json.JSONDecodeError:
        return
    if isinstance(processes, dict):
        processes = [processes]

    current_pid = os.getpid()
    ini_kit_id = int(read_kit_id(project_root()))
    killed = []
    for proc in processes:
        pid = int(proc.get("ProcessId", 0) or 0)
        if pid <= 0 or pid == current_pid:
            continue
        command_line = str(proc.get("CommandLine", ""))
        if not command_targets_same_bridge(command_line, args, ini_kit_id):
            continue
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/F"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            killed.append(pid)
        except (OSError, subprocess.SubprocessError):
            continue

    if killed:
        print("Bridge anterior encerrada: " + ", ".join(str(pid) for pid in killed))
        time.sleep(0.5)


def main() -> int:
    args = parse_args()
    try:
        esp_addr = (socket.gethostbyname(args.host), args.udp_port)
    except OSError as exc:
        print(f"Nao consegui resolver o endereco do ESP32 ({args.host}): {exc}")
        print("Conecte o computador ao Wi-Fi do ESP32 ou informe o IP com --host.")
        return 1

    if not args.keep_existing:
        kill_existing_bridges(args)

    try:
        validate_serial_pair(args)
    except serial.SerialException as exc:
        print(exc)
        return 1

    try:
        ser = open_serial(args.serial, args.baudrate)
    except serial.SerialException as exc:
        print(f"Nao consegui abrir {args.serial} em {args.baudrate} SERIAL_8O1: {exc}")
        if "Access is denied" in str(exc) or "PermissionError" in str(exc):
            print("Essa porta provavelmente ja esta aberta por outra bridge ou outro programa.")
        return 1

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(0.1)
    sock.bind(("", args.listen_port))

    local_ip = local_ip_for_remote(args.host, args.udp_port)
    local_port = sock.getsockname()[1]
    connect_msg = f"CONNECT:{local_ip}:{local_port}".encode("ascii")
    disconnect_msg = f"DISCONNECT:{local_ip}:{local_port}".encode("ascii")

    print(f"UDP local: {local_ip}:{local_port}")
    print(f"ESP32: {args.host}:{args.udp_port}")
    sock.sendto(connect_msg, esp_addr)
    print("CONNECT enviado para a ESP32.")

    stop = threading.Event()
    rx_thread = threading.Thread(
        target=udp_to_serial,
        args=(sock, ser, esp_addr, stop, args.verbose, args.pactware_port),
        daemon=True,
    )
    tx_thread = threading.Thread(target=serial_to_udp, args=(sock, ser, esp_addr, stop), daemon=True)

    print(f"Serial aberta: {args.serial} @ {args.baudrate} SERIAL_8O1")
    print(f"Configure o PACTware na porta: {args.pactware_port}")
    print("Ponte serial/UDP ativa. Pressione Ctrl+C para sair.")
    rx_thread.start()
    tx_thread.start()

    try:
        while not stop.is_set():
            if stop.wait(CONNECT_INTERVAL):
                break
            sock.sendto(connect_msg, esp_addr)
    except KeyboardInterrupt:
        print("\nEncerrando...")
    finally:
        stop.set()
        try:
            sock.sendto(disconnect_msg, esp_addr)
        except OSError:
            pass
        ser.close()
        sock.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
