"""Transparent serial proxy for recording PACTware traffic through com0com.

Topology: PACTware -> one endpoint of a virtual pair <-> relay -> modem COM17.
Usage:
    python scripts/hart_serial_relay_capture.py COM27 COM17 output.txt
Both directions are recorded as raw hex chunks. Stop with Ctrl+C.
"""
import datetime as dt
import pathlib
import sys
import threading

import serial


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: hart_serial_relay_capture.py VIRTUAL_COM PHYSICAL_COM LOG.txt")
    virtual_name, physical_name, log_name = sys.argv[1:]
    stop = threading.Event()
    log_lock = threading.Lock()
    log_path = pathlib.Path(log_name)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    stream = log_path.open("w", encoding="utf-8", buffering=1)
    stream.write(f"HART transparent serial relay; {dt.datetime.now().astimezone().isoformat()}\n")
    stream.write(f"Topology: PACTware's paired virtual endpoint <-> {virtual_name} <-> relay <-> {physical_name} modem\n")
    stream.write("Format: direction timestamp length hex-bytes\n")
    virtual = serial.Serial(virtual_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                            stopbits=1, timeout=0.02, write_timeout=1,
                            rtscts=False, dsrdtr=False)
    physical = serial.Serial(physical_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                             stopbits=1, timeout=0.02, write_timeout=1,
                             rtscts=False, dsrdtr=False)

    def forward(source, target, label):
        try:
            while not stop.is_set():
                chunk = source.read(512)
                if not chunk:
                    continue
                target.write(chunk)
                target.flush()
                stamp = dt.datetime.now().astimezone().isoformat(timespec="milliseconds")
                with log_lock:
                    stream.write(f"{label} {stamp} {len(chunk)} {chunk.hex(' ').upper()}\n")
        except Exception as exc:
            with log_lock:
                stream.write(f"ERROR {label} {type(exc).__name__}: {exc}\n")
            stop.set()

    workers = [threading.Thread(target=forward, args=(virtual, physical, "PACTWARE_TO_MODEM"), daemon=True),
               threading.Thread(target=forward, args=(physical, virtual, "MODEM_TO_PACTWARE"), daemon=True)]
    print(f"Relay active: paired virtual endpoint <-> {virtual_name} <-> {physical_name}; logging to {log_path.resolve()}")
    print("No HART payloads are changed. Press Ctrl+C to stop.")
    for worker in workers:
        worker.start()
    try:
        while not stop.wait(0.25):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        for worker in workers:
            worker.join(timeout=1)
        virtual.close()
        physical.close()
        stream.close()
    print(f"Relay stopped. Capture: {log_path.resolve()}")


if __name__ == "__main__":
    main()
