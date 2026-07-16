import { ChildProcess, spawn, SpawnOptions } from "child_process";
import * as path from "path";

export interface CoreProcessOptions {
  executablePath: string;
  pipeName: string;
  /** Diretório de trabalho do processo; padrão: diretório do executável. */
  cwd?: string;
  /** Additional variables inherited by the Core and the QEMU processes it starts. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Gerencia o ciclo de vida do processo Core nativo.
 * Separado de CoreClient para permitir testes com servidores mock sem processo real.
 */
export class CoreProcess {
  private child: ChildProcess | undefined;
  private readonly _exitListeners: Array<(code: number | null) => void> = [];
  private readonly _errorListeners: Array<(err: Error) => void> = [];

  constructor(private readonly opts: CoreProcessOptions) {}

  get isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  start(): void {
    if (this.child) {
      throw new Error("CoreProcess já iniciado");
    }
    const spawnOpts: SpawnOptions = {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: this.opts.cwd ?? path.dirname(this.opts.executablePath),
      env: { ...process.env, ...this.opts.env },
    };
    this.child = spawn(this.opts.executablePath, ["--pipe", this.opts.pipeName], spawnOpts);
    this.child.on("exit", (code) => {
      for (const l of this._exitListeners) l(code);
      this.child = undefined;
    });
    // Sem isso, ENOENT (binário não encontrado) ou EACCES virariam exceção não tratada na thread
    // do Node e derrubariam o Extension Host inteiro em vez de só este processo — 'error' é
    // assíncrono e sempre precisa de listener próprio (não basta o try/catch de quem chamou start()).
    this.child.on("error", (err) => {
      for (const l of this._errorListeners) l(err);
      this.child = undefined;
    });
    // Encaminha stderr do Core para o console do processo host
    this.child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[LasecSimul Core] ${data.toString()}`);
    });
  }

  onExit(listener: (code: number | null) => void): void {
    this._exitListeners.push(listener);
  }

  /** Falha ao iniciar o processo (ex: binário não encontrado) — ver comentário em start(). */
  onError(listener: (err: Error) => void): void {
    this._errorListeners.push(listener);
  }

  kill(): void {
    this.child?.kill();
    this.child = undefined;
  }

  /** Nome de pipe padrão para esta instância do processo host. */
  static defaultPipeName(): string {
    return `lasecsimul-core-${process.pid}`;
  }
}
