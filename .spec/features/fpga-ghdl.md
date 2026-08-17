---
id: FEAT-005
kind: feature
status: active
dependsOn: [ARCH-001, ARCH-003, ARCH-004]
supersedes: []
---

# FPGA/VHDL com GHDL

## Contrato atual preservado

- Core é autoridade do tempo;
- GHDL avança em lockstep somente para tempo aceito;
- arena é criada antes do processo;
- processo possui timeout, stop e kill;
- cada instância FPGA mantém backend/processo próprio por enquanto.

## Experiência do usuário e distribuição

- O instalador/VSIX inclui um runtime GHDL relocável e o módulo VPI da plataforma, seguindo o mesmo
  modelo do QEMU integrado. O fluxo normal nunca depende de PATH, terminal ou instalação manual.
- A barra principal oferece **Adicionar FPGA VHDL**. A criação inteira usa seletores de arquivo,
  janela de entity e versão VHDL.
- As propriedades e o menu de contexto da FPGA expõem abrir/editar fontes, alterar fontes/entity,
  analisar, rodar, parar, reiniciar, visualizar logs e gerenciar o simulador.
- `lasecsimul.fpga.ghdlPath` é apenas override avançado. Pacote incompleto/checkout de
  desenvolvimento oferece instalação ou seleção guiada, nunca uma instrução de linha de comando ao
  usuário final.

## Cache vNext

A chave inclui conteúdos e nomes relativos das fontes, ordem, top, standard, flags, versão/fingerprint/backend do GHDL, plataforma, ABI da arena e VPI.

Compilação usa lock por chave e diretório temporário. Publicação ocorre por rename atômico e marker com metadados; entrada publicada é read-only. Falha ou timeout nunca publica hit. Cache possui orçamento/LRU.

Se artefatos GHDL não forem relocáveis, a sessão materializa hardlinks/cópias em workdir próprio.

## Adiado

Agrupar várias instâncias FPGA em um único processo exige benchmark e design separado para generics, nomes VPI, reset, fault isolation e recompilação. Não faz parte do roadmap antes de F9.

## Aceitação

- duas compilações concorrentes da mesma chave não corrompem cache;
- mudança de toolchain/VPI causa miss;
- timeout deixa cache inválido/removível;
- crash de uma FPGA não deixa processo órfão;
- pacote Release executa o teste real usando exclusivamente o GHDL integrado/relocável;
- lockstep nunca observa passo rejeitado.

## Evidência automatizada

- `core/test/core/fpga/GhdlBackendRealGhdlTest.cpp`: cache concorrente, fingerprints, timeout,
  descoberta de faixas e execução com GHDL real;
- `core/test/core/fpga/FpgaComponentRealGhdlTest.cpp`: lockstep no Scheduler, settle no timestamp
  aceito, duas instâncias e parada global;
- `core/test/core/fpga/GhdlProcessManagerTest.cpp`: timeout, kill, ambiente, exit code e logs;
- `core/test/core/fpga/GhdlArenaBridgeTest.cpp`: ABI/capacidades, overflow e logs;
- `extension/test/project/ProjectSerializer.test.ts`: round-trip e resolução de fontes relativas.
