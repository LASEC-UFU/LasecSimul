---
id: FEAT-005
kind: feature
status: active
dependsOn: [ARCH-001, ARCH-003, ARCH-004, ARCH-009, FEAT-011]
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
- O catálogo oferece **Bloco Programável FPGA** na aba `Digital` da paleta lateral (ver
  [FEAT-011](workspace-navigation.md)); o editor de esquemático também oferece um botão de inserção
  rápida na barra de ferramentas, sempre disponível (o editor não tem abas). A inserção cria
  imediatamente um componente visual persistível, sem configuração VHDL, sem entradas e sem saídas;
  inserir o bloco não inicia GHDL nem exige que o toolchain esteja disponível.
- As propriedades e o menu de contexto do bloco vazio oferecem **Carregar código VHDL...**. Somente
  essa ação solicita fontes, entity e versão VHDL, executa a análise e associa a configuração ao bloco
  já existente.
- Depois de uma análise válida, cada porta escalar ou bit de vetor da interface VHDL materializa o
  terminal correspondente, com direção e índice estáveis. Uma entity válida sem portas mantém o bloco
  com zero terminais e não é tratada como erro.
- Reanalisar ou trocar fontes/entity/standard atualiza os terminais do mesmo componente. Ligações de
  terminais removidos são descartadas de forma explícita, e o Core é reconstruído quando a interface
  ou os metadados de porta mudam.
- Depois da configuração, propriedades e menu de contexto também expõem abrir/editar fontes, alterar
  fontes/entity, analisar, rodar, parar, reiniciar, visualizar logs e gerenciar o simulador.
- `lasecsimul.fpga.ghdlPath` é apenas override avançado. Pacote incompleto/checkout de
  desenvolvimento oferece instalação ou seleção guiada, nunca uma instrução de linha de comando ao
  usuário final.

O bloco sem código é autoria válida e não participa da inicialização de backends FPGA ao iniciar a
simulação. Executar ou analisar sem configuração deve orientar o usuário a carregar VHDL, sem criar
processo externo ou um pinset placeholder.

## Cache vNext

A chave inclui conteúdos e nomes relativos das fontes, ordem, top, standard, flags, versão/fingerprint/backend do GHDL, plataforma, ABI da arena e VPI.

Compilação usa lock por chave e diretório temporário. Publicação ocorre por rename atômico e marker com metadados; entrada publicada é read-only. Falha ou timeout nunca publica hit. Cache possui orçamento/LRU.

Se artefatos GHDL não forem relocáveis, a sessão materializa hardlinks/cópias em workdir próprio.

## Lifecycle e diagnóstico

GHDL reutiliza o contrato de identidade/provenance de `ARCH-009`: runtime instance estável para a instância lógica, launch generation nova em cada tentativa e metadata resolvida no cold path. Trace detalhado, quando habilitado, é bounded e local ao processo; não cria thread dedicada nem altera lockstep/tempo virtual.

## Adiado

Agrupar várias instâncias FPGA em um único processo exige benchmark e design separado para generics, nomes VPI, reset, fault isolation e recompilação. Não faz parte do roadmap antes de F9.

## Aceitação

- o bloco programável pode ser inserido na aba `Digital` com zero entradas, zero saídas e nenhuma
  configuração FPGA;
- antes de carregar código, o bloco permanece visível, selecionável, movível, persistível e não inicia
  GHDL; seu símbolo não desenha leads ou terminais fictícios;
- carregar uma entity materializa os terminais no mesmo bloco conforme direção, largura e índices das
  portas analisadas;
- uma entity válida com zero portas conclui a análise e conserva zero terminais;
- reanálise preserva ligações de terminais que continuam existindo e remove ligações órfãs;
- o bloco programável não aparece nas abas `Analógico`, `Controle` ou `Processo`;
- duas compilações concorrentes da mesma chave não corrompem cache;
- mudança de toolchain/VPI causa miss;
- timeout deixa cache inválido/removível;
- crash de uma FPGA não deixa processo órfão;
- pacote Release executa o teste real usando exclusivamente o GHDL integrado/relocável;
- lockstep nunca observa passo rejeitado;
- relaunch não colide identidade/trace com execução anterior;
- trace OFF não acrescenta worker/thread/buffer permanente.

## Evidência automatizada

- `extension/src/fpga/fpgaPins.test.ts`: ausência de terminais antes da análise e materialização de
  portas escalares/vetoriais, incluindo intervalos ascendentes não nulos;
- `extension/src/ui/webview/componentSymbols.test.ts`: corpo visual do FPGA vazio sem leads
  fictícios;
- `extension/src/ui/webview/paletteTree.test.ts`: presença exclusiva do bloco FPGA na aba `Digital`;
- `core/test/core/fpga/GhdlBackendRealGhdlTest.cpp`: cache concorrente, fingerprints, timeout,
  descoberta de faixas e execução com GHDL real;
- `core/test/core/fpga/FpgaComponentRealGhdlTest.cpp`: lockstep no Scheduler, settle no timestamp
  aceito, duas instâncias e parada global;
- `core/test/core/fpga/GhdlProcessManagerTest.cpp`: timeout, kill, ambiente, exit code e logs;
- `core/test/core/fpga/GhdlArenaBridgeTest.cpp`: ABI/capacidades, overflow e logs;
- `extension/test/project/ProjectSerializer.test.ts`: round-trip do bloco vazio, configuração FPGA e
  resolução de fontes relativas.
