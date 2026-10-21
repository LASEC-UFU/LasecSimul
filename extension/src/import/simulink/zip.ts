/**
 * Leitor mínimo de ZIP para os pacotes OPC do Simulink (`.slx`): diretório central, entradas
 * armazenadas (método 0) ou comprimidas com deflate (método 8, `zlib.inflateRawSync`). Sem
 * dependências; ZIP64, criptografia e outros métodos são recusados com mensagem clara.
 */
import * as zlib from "zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>();

  constructor(private readonly data: Buffer) {
    const eocd = this.findEndOfCentralDirectory();
    const count = data.readUInt16LE(eocd + 10);
    const directoryOffset = data.readUInt32LE(eocd + 16);
    if (directoryOffset === 0xffffffff || count === 0xffff) throw new Error("ZIP64 nao suportado no pacote .slx");
    let offset = directoryOffset;
    for (let i = 0; i < count; i++) {
      if (data.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error("diretorio central do .slx corrompido");
      const flags = data.readUInt16LE(offset + 8);
      const method = data.readUInt16LE(offset + 10);
      const compressedSize = data.readUInt32LE(offset + 20);
      const size = data.readUInt32LE(offset + 24);
      const nameLength = data.readUInt16LE(offset + 28);
      const extraLength = data.readUInt16LE(offset + 30);
      const commentLength = data.readUInt16LE(offset + 32);
      const localHeaderOffset = data.readUInt32LE(offset + 42);
      const name = data.toString(flags & 0x0800 ? "utf8" : "latin1", offset + 46, offset + 46 + nameLength).replace(/\\/g, "/");
      if (flags & 0x0001) throw new Error(`entrada criptografada no .slx: ${name}`);
      this.entries.set(name, { name, method, compressedSize, size, localHeaderOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  private findEndOfCentralDirectory(): number {
    const minimum = Math.max(0, this.data.length - 22 - 0xffff);
    for (let offset = this.data.length - 22; offset >= minimum; offset--) {
      if (this.data.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
    }
    throw new Error("arquivo nao e um pacote ZIP/OPC (.slx)");
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`parte ausente no .slx: ${name}`);
    const offset = entry.localHeaderOffset;
    if (this.data.readUInt32LE(offset) !== LOCAL_SIGNATURE) throw new Error(`cabecalho local corrompido: ${name}`);
    const start = offset + 30 + this.data.readUInt16LE(offset + 26) + this.data.readUInt16LE(offset + 28);
    const raw = this.data.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) {
      const inflated = zlib.inflateRawSync(raw);
      if (inflated.length !== entry.size) throw new Error(`tamanho descomprimido inesperado em ${name}`);
      return inflated;
    }
    throw new Error(`metodo de compressao ${entry.method} nao suportado em ${name}`);
  }

  readText(name: string): string {
    return this.read(name).toString("utf8").replace(/^﻿/, "");
  }
}

/** ZIP mínimo (entradas armazenadas) -- usado pelos testes para montar pacotes `.slx` sintéticos. */
export function buildStoredZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
