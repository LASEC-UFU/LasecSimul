# Agente 12 - ESP32 Adapter

## Objetivo

Implementar adapter inicial da ESP32 para QEMU e mapear GPIO básico.

## Escopo

Adapter ESP32, launch args, regiões MMIO e mapa de pinos.

## Contexto

A ESP32 roda via QEMU modificado. O adapter descreve launch, MMIO e pinos, não emula CPU. **Sempre
via plugin DLL/SO (`mcu_abi.h`) — não existe, e não deve ser criado, caminho built-in compilado no
Core.** Decisão tomada em 2026-06-28 ao migrar o adapter do caminho built-in que existia em
`core/src/mcu/esp32/` (removido) para `mcu-adapters/espressif-esp32/` — mesmo desempenho dos dois
(chamada de função C indireta, mesmo processo, sem IPC), sem precisar recompilar o Core por chip.

## Arquivos que pode criar

- `mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp` (módulo(s) `LsdnQemuModuleVTable` novos, se
  necessário).
- `core/test/core/mcu/Esp32AdapterTest.cpp`.

## Arquivos que pode modificar

- `mcu-adapters/espressif-esp32/mcu.json`.
- `mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp`.
- `core/include/lasecsimul/mcu_abi.h` em acordo com agente 11 (mudança de ABI pública, bump de
  versão).
- `core/src/registry/McuRegistry.hpp`.

## Arquivos que não pode modificar

- `extension/**`.
- `core/src/simulation/MnaSolver.*`.
- `devices/**`.

## Dependências

- Agente 11 para QEMU bridge.
- Agente 13 para o proxy de plugin de MCU (`NativeMcuAdapterProxy`/`QemuModuleProxy`).

## Interfaces obrigatórias

- `chipId`: `espressif.esp32` ou id definido no manifesto (`mcu.json`, não na vtable).
- `build_launch_args`.
- `get_memory_regions`.
- `get_pin_map`.
- `create_modules` (mcu_abi.h major 2+) para periféricos que decodificam registrador de verdade.
- Declaração de dependência de QEMU compatível.

## Tarefas

- [ ] Revisar `mcu.json` existente.
- [ ] Definir regiões MMIO iniciais de GPIO.
- [ ] Definir mapa de pinos GPIO.
- [ ] Implementar argumentos de launch.
- [ ] Declarar firmware esperado.
- [ ] Integrar com `McuRegistry`.
- [ ] Criar teste de geração de argumentos.
- [ ] Criar teste de mapeamento de GPIO.
- [ ] Documentar dependência de QEMU modificado.
- [ ] Planejar teste blink.

## Testes obrigatórios

- [ ] Adapter retorna `chipId`.
- [ ] Args incluem firmware.
- [ ] Região GPIO existe.
- [ ] Pin map contém GPIO de blink.
- [ ] Erro claro quando QEMU não está disponível.

## Critérios de aceite

- Adapter não emula CPU.
- Dependências externas estão documentadas.
- Blink está pronto para rodar quando QEMU compatível existir.

## Riscos técnicos

- Prometer ESP32 sem build QEMU compatível.
- Hardcode de paths locais.
- Misturar protocolo I2C/SPI dentro do adapter.

## Observações de integração

Protocolo de barramento (I2C/SPI/UART) é decodificado bit a bit pelo device do outro lado do fio, a
partir de `LSDN_EVT_PIN_CHANGE` — não existe módulo genérico de barramento no Core, e o adapter ESP32
nunca decodifica protocolo, só registrador GPIO/IOMUX/periférico bruto.

## O que não fazer

- Não reimplementar Xtensa.
- Não mover QEMU para Extension.
- Não fazer lógica de periférico completa dentro do adapter.
