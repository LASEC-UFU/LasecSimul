# FPGA Genérico (VHDL/GHDL)

Suporte a um componente **FPGA Genérico** que compila e simula VHDL de verdade via
[GHDL](https://github.com/ghdl/ghdl), rodando em lockstep com o resto da simulação elétrica do
LasecSimul (Scheduler continua sendo a única autoridade de tempo virtual — ver
`.spec/features/fpga-ghdl.md`). Este documento cobre instalação, criação de projeto, portas/clocks,
diagnósticos e limitações conhecidas.

## Instalação do GHDL

O GHDL **não é vendorizado** com a extensão (é um toolchain de sistema, como o GDB usado por
depuração de firmware) — precisa estar instalado e acessível.

- **Windows**: `winget install ghdl.ghdl.ucrt64.mcode` (testado contra GHDL 6.0.0, backend mcode).
- **Linux/macOS**: use o pacote da sua distro ou compile a partir do
  [repositório oficial](https://github.com/ghdl/ghdl).

Configure `lasecsimul.fpga.ghdlPath` (Configurações do VS Code) se `ghdl` não estiver no `PATH` do
sistema — mesma convenção de `lasecsimul.debug.gdbPath` (GDB do QEMU).

O **módulo VPI** (`lasecsimul_vpi.dll`/`.so`) é a ponte entre o Core e o processo GHDL — esse SIM é
incluído com a extensão (compilado por `npm run build:fpga-vpi` no desenvolvimento e pelo CI de
release; o empacotamento falha se o artefato estiver ausente). Se a extensão reportar "módulo VPI não
encontrado", no repositório de desenvolvimento rode:

```powershell
npm run build:fpga-vpi
```

(exige também um MinGW/UCRT GCC no PATH — ex. `winget install BrechtSanders.WinLibs.POSIX.UCRT` —
já que o GHDL distribuído via winget não é compatível com o linker do MSVC para este módulo.)

## Criando um FPGA genérico

Ao contrário de todo outro componente do catálogo, o FPGA Genérico **não é arrastável da paleta**
com um pinset fixo — o pinset real só é conhecido depois de compilar o VHDL. O fluxo é:

1. **Comando "LasecSimul: Adicionar FPGA Genérico"** (Command Palette, `Ctrl+Shift+P`).
2. Selecione um ou mais arquivos `.vhd`/`.vhdl` (múltiplos arquivos: ordem de análise é a ordem de
   seleção — resolução automática de dependências entre arquivos fica fora de escopo por ora,
   declare a ordem certa manualmente se tiver mais de um arquivo).
3. Informe o nome da entity **top-level** a simular.
4. A extensão compila (`ghdl -a`/`-e`, com cache de compilação — ver "Cache de compilação" abaixo) e
   descobre as portas reais da entity. O componente nasce no esquemático já com um pino elétrico por
   bit de porta.

Depois de colocado, clique com o botão direito no bloco pra:

- **Analisar VHDL**: recompila e redescobre portas contra o VHDL atual (útil depois de editar o
  `.vhd` num editor de texto). Se o conjunto de pinos mudou, o circuito é reconstruído no Core
  automaticamente (fios que tocavam um pino removido são descartados, mesmo comportamento de
  qualquer componente com contagem de pinos dinâmica).
- **Rodar/Parar/Reiniciar FPGA**: controla individualmente a instância. O Run geral compila/inicia
  todos os FPGAs configurados; o Stop geral encerra todos os processos GHDL.
- **Ver log do GHDL**: log combinado do processo (stdout/stderr) e do protocolo VPI, útil pra depurar um `assert`/erro
  de runtime do VHDL.

## Portas e tipos suportados

- `std_logic`/`std_logic_vector` apenas — cada bit de um vetor vira um pino elétrico próprio
  (`nome(N)`, N = índice VHDL real da declaração — `(3 downto 0)` e `(0 to 3)` são tratados
  corretamente).
- Direção `in`/`out` apenas — `inout` não é suportado.
- Fidelidade de 9 estados (`U`,`X`,`0`,`1`,`Z`,`W`,`L`,`H`,`-`) na **leitura** de saídas do GHDL; a
  **escrita** de entradas do lado do Core é sempre 2-estado (`0`/`1`) — o próprio modelo elétrico do
  LasecSimul é puramente por tensão, então uma entrada VHDL nunca recebe `X`/`Z`/etc. de propósito
  vindo do circuito.

## Clock e sincronização de tempo

O Core é a autoridade do tempo — não existe um "clock" separado dentro do GHDL. Toda entrada VHDL
(inclusive `clk`) é amostrada do circuito elétrico normal: ligue um componente `Clock` comum (ou
qualquer fonte que alterne nível) na porta que a sua entity declarar como clock. O GHDL avança
somente até instantes de tempo **aceitos** pelo Scheduler (nunca observa um passo depois rejeitado
por não-convergência), e cada avanço de tempo do Scheduler dispara exatamente um `ADVANCE_TO`/
`TIME_REACHED` — sem ciclos de delta intermediários visíveis ao circuito elétrico (o GHDL resolve
todos os deltas internamente antes de responder).

## Cache de compilação

Compilações são cacheadas por conteúdo — a mesma combinação de fontes+top+standard+versão do
GHDL+módulo VPI nunca recompila. O cache vive em `.lasecsimul/fpga-cache/` dentro da pasta do
projeto (apagável a qualquer momento, é só um cache) e tem um orçamento com descarte automático das
entradas mais antigas quando cheio.

## Diagnósticos

Erros de compilação VHDL aparecem no painel **Problemas** do VS Code, ancorados no arquivo/linha/
coluna reais reportados pelo GHDL (`arquivo.vhd:12:5: mensagem`) — clique no diagnóstico pra pular
direto pro ponto do erro. O canal de saída "LasecSimul: Simulação" também registra o evento.

## Limitações conhecidas

- **Um processo GHDL por instância FPGA** — agrupar várias instâncias num único processo (mais
  barato pra projetos com muitos FPGAs) está fora de escopo por enquanto (ver `.spec/features/
  fpga-ghdl.md`, seção "Adiado").
- **Sem visualização de waveform** (VCD) integrada ainda — só o log combinado do processo.
- **Sem suporte a `inout`**, generics via GUI, nem backends além do GHDL
  (Verilator/CXXRTL não implementados).
- **Sem resolução automática de dependência entre múltiplos arquivos VHDL** — declare a ordem
  manualmente se sua entity usa pacotes/entities de outro arquivo.

## Exemplo

Veja `examples/fpga-vhdl-counter/` — um contador de 4 bits dirigido por um `Clock` real do
esquemático, saída em 4 LEDs.
