# Migração para a árvore canônica

Data: 2026-08-15.

Todo conteúdo anterior da raiz de `.spec` foi preservado em `archive/legacy-v2/`. Esses arquivos são históricos e não normativos.

| Legado | Destino canônico |
|---|---|
| `lasecsimul.spec` | `architecture/*`, ADRs e `archive/legacy-v2/lasecsimul.spec` |
| `lasecsimul-native-devices.spec` | `architecture/system-boundaries.md`, feature/plugin futura e legado |
| `lasecsimul-subcircuits.spec` | `features/subsystems.md`, `schemas/subsystem-vnext.md` e legado |
| `00–01` | arquitetura de sistema/runtime |
| `02–06`, `24–26` | Signal Engine, dinâmica, bridges e topologia |
| `07`, `16` | subsystems e schemas vNext |
| `08–15`, `28–29` | `features/protocols-and-plc.md` |
| `14` | `features/fpga-ghdl.md` |
| `17–19`, `21–22` | arquitetura/testes/governança |
| `20` | `ROADMAP.md` |
| `23` | legado/deferred ecosystem |
| `27` | referência histórica |
| `30–31`, `38`, `40` | `features/process-visualization.md` |
| `32–34` | `features/python-runtime.md` |
| `35–39` | deployment profiles e release futura |
| `41` | critérios incorporados às features/testes |
| `42` e `DECISIONS.md` | ADRs individuais |
| `43–46` | recursos, concorrência, deployment e benchmarks |
| `47–48` | boundaries/deployment profiles |
| `99` | substituído por frontmatter + governança por kind |
| addenda/manifests/status antigos | histórico em `legacy-v2/` |

Compatibilidade documental é fornecida pelo archive; não se mantém duplicata normativa nos caminhos antigos.
