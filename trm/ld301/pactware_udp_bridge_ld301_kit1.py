#!/usr/bin/env python3
"""Ponte UDP/HART dedicada ao LD301 ligado a ESP32 kit ID=1.

O par com0com do kit 1 e CNCB1 (lado ESP32) <-> COM21 (lado PACTware).
Todos os bytes HART recebidos/enviados sao registrados em arquivo e console.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import socket
import sys
import threading
import time

import serial


def stamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="iikit1.local", help="IP ou hostname da ESP32 (ID=1)")
    parser.add_argument("--udp-port", type=int, default=47268)
    parser.add_argument("--serial", default="CNCB1", help="Extremidade serial da ponte para a ESP32")
    parser.add_argument("--pactware-port", default="COM21", help="Porta pareada para o PACTware")
    parser.add_argument("--baudrate", type=int, default=1200)
    parser.add_argument("--listen-port", type=int, default=0)
    parser.add_argument("--log", default="", help="Arquivo de captura; padrao trm/ld301/captura-kit1-<data>.log")
    args = parser.parse_args()

    from pathlib import Path
    log_path = Path(args.log) if args.log else Path(__file__).with_name(
        "captura-kit1-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".log"
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("a", encoding="utf-8", buffering=1)

    def record(direction: str, data: bytes) -> None:
        line = f"[{stamp()}] {direction} ({len(data)} bytes): " + data.hex(" ").upper()
        print(line, flush=True)
        log_file.write(line + "\n")

    try:
        esp_addr = (socket.gethostbyname(args.host), args.udp_port)
    except OSError as exc:
        print(f"Nao resolvi {args.host}: {exc}; use --host com o IP da ESP32.")
        log_file.close()
        return 1

    ser = None
    errors = []
    serial_names = [args.serial]
    if sys.platform.startswith("win") and not args.serial.startswith("\\\\.\\"):
        serial_names.append("\\\\.\\" + args.serial)
    for serial_name in serial_names:
        try:
            ser = serial.Serial(serial_name, args.baudrate, bytesize=serial.EIGHTBITS,
                                parity=serial.PARITY_ODD, stopbits=serial.STOPBITS_ONE,
                                timeout=0.05, write_timeout=1)
            break
        except serial.SerialException as exc:
            errors.append(f"{serial_name}: {exc}")
    if ser is None:
        print(f"Falha ao abrir {args.serial} ({args.baudrate}, 8O1): {' | '.join(errors)}")
        log_file.close()
        return 1

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(0.1)
    sock.bind(("", args.listen_port))
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(esp_addr)
        local_ip = probe.getsockname()[0]
    finally:
        probe.close()
    local_port = sock.getsockname()[1]
    connect = f"CONNECT:{local_ip}:{local_port}".encode("ascii")
    disconnect = f"DISCONNECT:{local_ip}:{local_port}".encode("ascii")
    stop = threading.Event()
    sock.sendto(connect, esp_addr)
    print(f"Kit ID=1 | ESP32 {esp_addr[0]}:{esp_addr[1]} | serial {args.serial} | PACTware {args.pactware_port}")
    print(f"Captura HART: {log_path}")
    print("Ponte ativa. Inicie a comunicacao no PACTware; Ctrl+C encerra.")

    def udp_rx() -> None:
        while not stop.is_set():
            try:
                data, addr = sock.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                return
            if addr != esp_addr or not data or data.startswith((b"CONNECT:", b"DISCONNECT:")):
                continue
            record("ESP32 -> HART serial/PACTware", data)
            try:
                ser.write(data)
            except serial.SerialException as exc:
                print(f"Erro escrevendo na serial: {exc}")
                stop.set()

    def serial_rx() -> None:
        while not stop.is_set():
            try:
                data = ser.read(256)
            except serial.SerialException as exc:
                print(f"Erro lendo serial: {exc}")
                stop.set()
                return
            if data:
                record("PACTware/HART serial -> ESP32", data)
                try:
                    sock.sendto(data, esp_addr)
                except OSError as exc:
                    print(f"Erro enviando UDP: {exc}")
                    stop.set()

    threads = [threading.Thread(target=udp_rx, daemon=True), threading.Thread(target=serial_rx, daemon=True)]
    for thread in threads:
        thread.start()
    try:
        while not stop.wait(5):
            sock.sendto(connect, esp_addr)
    except KeyboardInterrupt:
        print("\nEncerrando ponte...")
    finally:
        stop.set()
        try:
            sock.sendto(disconnect, esp_addr)
        except OSError:
            pass
        sock.close()
        ser.close()
        log_file.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
