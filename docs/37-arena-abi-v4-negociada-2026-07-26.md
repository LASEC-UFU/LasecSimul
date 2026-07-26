# Arena ABI v4 negociada entre Core e QEMU

Data: 2026-07-26.

## Resultado

A ABI v4 passou a ser o padrão da memória compartilhada Core–QEMU. Ela adiciona um descritor
validado em runtime antes do payload de transporte:

- magic `LSDNQAR4`;
- versão major/minor;
- tamanho do descritor, mapping total e payload;
- profundidade da fila;
- capacidades oferecidas pelo Core e pelo QEMU;
- interseção negociada;
- handshake `coreReady/qemuReady`.

O payload v3 de 1128 bytes não foi alterado: ele é encapsulado depois do descritor de 88 bytes. O
mapping v4 tem 1216 bytes. `static_assert` nos dois repositórios impede mudança acidental desses
tamanhos durante a compilação.

O QEMU correspondente é o commit `73392afd7256aaa2adba03c0473e6b2b6744ac3d`. O executável
implantado em `devices/qemu-esp32/bin/qemu-system-xtensa.exe` possui SHA-256
`9E15C4DF38D72EC542F22BD55D73DCD1617D12B70F7E0C6D7AD7B2BA67188E2A`.

## Capacidades iniciais

As capacidades obrigatórias negociadas são:

| Bit | Capacidade |
|---:|---|
| 0 | fila circular para escritas/heartbeat |
| 1 | publicação globalmente ordenada |
| 2 | slot de leitura síncrona |
| 3 | produtores MTTCG serializados com segurança |

Capacidades futuras podem ser opcionais. A validação exige todos os bits obrigatórios, mas aceita
bits adicionais e minor versions posteriores quando os tamanhos e a major version continuam
compatíveis.

## Falha rápida e rollback

Depois de iniciar o processo, o Core aguarda por até cinco segundos o `qemuReady`. Se o executável
não reconhecer a v4, o processo é encerrado e a carga falha com diagnóstico explícito, em vez de
consumir silenciosamente offsets incompatíveis.

O transporte anterior permanece disponível:

```text
LASECSIMUL_QEMU_ARENA_VERSION=3
```

Nesse modo, Core e QEMU mapeiam diretamente os 1128 bytes legados, sem descritor. O mesmo executável
novo suporta v3 e v4.

## Validação

- build completo do Core, incluindo todos os executáveis e testes, sem erro;
- build `qemu-system-xtensa` UCRT64 sem erro;
- teste unitário do bridge: descriptor/layout, handshake, capacidades obrigatórias ausentes,
  fila/ACK e rollback v3;
- QEMU real com flash apagada: v4 e v3 sustentados por cinco segundos, sem trava ou perda da fila;
- firmware real: dez ciclos Stop → Run de seis segundos em v4, sete bordas do GPIO13 em todos os
  ciclos, sem falha de boot, travamento ou resíduo após Stop.

## Escopo ainda pendente

Esta entrega cria a fundação versionada; ela não afirma que toda a arquitetura de eventos da fase 2
está concluída. Ainda faltam capacidades opcionais para rings independentes, IDs de resposta,
doorbells/notificações e lotes transacionais, sempre com comparação diferencial contra o payload
atual antes de promoção.
