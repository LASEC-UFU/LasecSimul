# 00 - Visão Geral

## Objetivo

Definir a visão operacional do LasecSimul para que vários agentes implementem partes separadas sem quebrar a arquitetura definida nas specs.

## Escopo

Este documento complementa as specs. Ele não substitui `.spec/lasecsimul.spec` nem `.spec/lasecsimul-native-devices.spec`.

## Fontes obrigatórias

- `.spec/lasecsimul.spec`: arquitetura principal.
- `.spec/lasecsimul-native-devices.spec`: plugins nativos DLL/SO.
- `.skill/lasecsimul.skill`: regras práticas para agentes.
- `.spec/archive/lasecsimul-wasm-devices.spec`: apenas histórico superseded.

## Produto

LasecSimul é composto por dois processos:

- `LasecSimul Extension`: TypeScript no VSCode Extension Host, responsável por UI, comandos, webview, projeto e orquestração.
- `LasecSimul Core`: C++ nativo em processo separado, responsável por simulação elétrica, plugins, QEMU, registries e execução headless.

## Regras centrais

- A Extension nunca calcula simulação elétrica.
- A UI nunca acessa o Core diretamente.
- Toda comunicação Extension/Core passa por `CoreClient` e IPC.
- O Core nunca referencia API do VSCode.
- O caminho crítico do solver nunca cruza IPC.
- MCUs sempre rodam via QEMU.
- Dispositivos customizados usam plugins nativos DLL/SO.
- WASM e `worker_threads` não são arquitetura ativa.
- O Core deve ser testável em modo headless.

## MVP

O MVP deve permitir abrir a Extension, carregar a Webview, iniciar o Core separado, trocar mensagens por IPC, criar um projeto `.lsproj`, adicionar resistor/capacitor/indutor, conectar componentes, gerar netlist e resolver pelo menos circuitos resistivos simples. A arquitetura QEMU/ESP32 e plugins nativos deve estar documentada e parcialmente scaffoldada.
