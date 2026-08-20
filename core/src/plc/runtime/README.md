# STruC++ Runtime Library (vendorizado)

Headers de `include/` vendorizados a partir do pacote de release oficial do STruCpp (compilador
IEC 61131-3 Structured Text → C++17), sob `GPL-3.0-or-later WITH STruCpp-runtime-exception`.

- Origem: `Autonomy-Logic/STruCpp`, release `v0.6.3` (ver `scripts/strucpp-pin.json`, fonte única
  de verdade de versão/hash/asset).
- Extraídos do mesmo pacote `.zip`/`.tar.gz` que o binário compilador (`plc/strucpp/build/<platform>/`,
  não commitado), nunca da árvore git separadamente — garante que compilador e runtime vêm sempre
  da mesma build. Ver `scripts/build-strucpp.js`.
- Cada arquivo preserva seu cabeçalho `SPDX-License-Identifier`/copyright original — não editar
  manualmente. Para atualizar a versão vendorizada: atualizar `scripts/strucpp-pin.json` e rodar
  `npm run build:strucpp` de novo.
- Licenciamento completo em `COPYING`/`COPYING.RUNTIME` do pacote STruCpp (não commitados aqui —
  `scripts/package-release.js` os copia junto do binário relocável na etapa de empacotamento,
  mesmo padrão já usado para o payload do TAP-Windows6; ver ADR-0007).

Contexto de decisão: `.spec/adr/0007-openplc-v4-incorporation-and-native-plc-pipeline.md`,
`.spec/features/iec61131-plc.md`.
