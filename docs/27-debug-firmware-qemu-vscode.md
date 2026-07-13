# Debug de firmware QEMU no VS Code

O comando `LasecSimul: Debug Firmware` inicia o QEMU com um gdbserver exclusivo por MCU e abre uma
sessão `cppdbg` do VS Code. Requisitos:

- extensão Microsoft C/C++ (`ms-vscode.cpptools`);
- GDB compatível com a CPU, para ESP32: `xtensa-esp32-elf-gdb`;
- arquivo ELF com símbolos (`-g`, preferencialmente `-Og`);
- imagem de firmware configurada no componente MCU e QEMU compatível com `-gdb`/`-S`.

Se o GDB não estiver no `PATH`, configure `lasecsimul.debug.gdbPath`.

## Sincronização

- breakpoint/pausa DAP pausa o Scheduler elétrico;
- continue retoma Scheduler e CPU quando nenhuma outra sessão MCU estiver parada;
- single-step mantém o Scheduler pausado e assenta MMIO/GPIO no tempo atual após a instrução;
- terminar a sessão encerra o QEMU daquela instância;
- múltiplas MCUs usam portas e sessões separadas; uma MCU parada impede avanço elétrico global.

O Core acrescenta `-S -gdb tcp:127.0.0.1:<porta>` depois dos argumentos do adapter, preservando a
chave da arena compartilhada como primeiro argumento do fork qemu-simulide.

## Recursos

Breakpoints de linha/endereço, condicionais, call stack, watches, registradores, memória e
disassembly são fornecidos pelo GDB/cppdbg conforme o suporte da CPU/QEMU. O ELF usado para símbolos
pode ser selecionado separadamente da imagem flash `.bin`.
