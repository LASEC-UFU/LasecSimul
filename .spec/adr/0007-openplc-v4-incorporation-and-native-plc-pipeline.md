---
id: ADR-0007
kind: adr
status: accepted
dependsOn: [ADR-0001, ADR-0002, ADR-0003]
supersedes: [ADR-0006]
---

# Incorporação do OpenPLC v4/STruCpp, relicenciamento GPL-3.0 e pipeline PLC nativo

## Contexto

ADR-0006 decidiu estudar o OpenPLC Editor v4 como referência de arquitetura, sem copiar código GPL-3.0, e compilar as cinco linguagens IEC para uma `IecCanonicalIR` própria interpretada por uma VM de bytecode sandboxada no Core.

Essa decisão foi revisitada. O objetivo passa a ser **maximizar o reaproveitamento** do que já existe e é maduro no ecossistema OpenPLC v4, em vez de reconstruir do zero o que já foi resolvido, sempre pensando em uma arquitetura escalável para novos dispositivos/linguagens. Levantamento do código-fonte real de `Autonomy-Logic/openplc-editor` e `Autonomy-Logic/STruCpp` mostra:

- os editores gráficos **LD** e **FBD** estão completos e maduros (react-flow, autocomplete, drag-and-drop, toolbox) — a parte mais cara de construir do zero;
- **ST**/**IL** já têm configuração Monaco pronta (`editor/monaco/configs/languages/il`);
- o backend (`src/backend/shared/transpilers/st-transpiler`) já baixa POUs gráficos (`walker/ld.ts`, `walker/fbd.ts`) para **ST textual único**, unificado com POUs textuais (`emit/pou-textual.ts`, `emit/pou-graphical.ts`) — ST já é, na prática, a IR canônica do próprio OpenPLC;
- **SFC não está implementado** no OpenPLC v4 atual (apenas um placeholder de tela e ícones existem; não há `walker` de lowering para SFC) — este é o único dos cinco front-ends que o LasecSimul precisa construir do zero, sem equivalente maduro a reaproveitar;
- o backend de execução do OpenPLC v4 não é uma VM de bytecode: **STruCpp compila ST para C++17**, que é então compilado por um toolchain C++ real em um binário/biblioteca nativa;
- **licenciamento**: `openplc-editor` é GPL-3.0. `STruCpp` é GPL-3.0 para o compilador, mas os *runtime headers/libraries* que ele injeta no programa compilado do usuário carregam uma **Runtime Library Exception** nos moldes da GCC Runtime Library Exception (`COPYING.RUNTIME`): o programa ST/C++ **compilado pelo usuário** pode ser distribuído sob qualquer licença, inclusive proprietária. Só o compilador em si (e qualquer obra que o incorpore) precisa ser GPL-3.0.
- o LasecSimul hoje é distribuído sob "todos os direitos reservados" (nenhuma licença publicada), o que é incompatível com incorporar código GPL-3.0 diretamente sem uma decisão de relicenciamento.

O precedente de bundlar toolchain externo de terceiros já existe no produto: `features/fpga-ghdl.md` já empacota GHDL relocável no instalador/VSIX e executa-o como processo próprio com timeout/kill, sem exigir instalação manual do usuário.

## Decisão

1. **Relicenciamento**: o LasecSimul passa a ser distribuído sob **GPL-3.0-or-later**. O arquivo `LICENSE` na raiz do repositório substitui o texto de "todos os direitos reservados"; `extension/package.json` reflete a mesma licença.
2. **LasecSimul PLC Runtime Library Exception**: nos moldes exatos da exceção do STruCpp, o LasecSimul publica sua própria runtime exception (`LICENSE-RUNTIME-EXCEPTION.txt`) cobrindo os runtime headers/libraries que o pipeline de compilação injeta no `PlcNativeModule` gerado a partir do projeto IEC de um usuário. **O programa PLC de um usuário do LasecSimul — o resultado de compilar seu próprio projeto IEC — pode ser distribuído sob qualquer licença**, incluindo proprietária; apenas o compilador/toolchain do LasecSimul em si é GPL-3.0. Isso preserva a proposta de valor para clientes finais mesmo com o produto sendo GPL-3.0.
3. **Vendoring direto**: os editores gráficos LD/FBD, a configuração Monaco de ST/IL e os padrões de UI (explorer por kind, biblioteca system/user, instances-editor) do OpenPLC Editor v4 são portados/adaptados diretamente do código-fonte para a Webview do LasecSimul, preservando avisos de copyright/licença GPL-3.0 exigidos por arquivo/módulo de origem.
4. **SFC é construído pelo LasecSimul**: como não existe editor/lowering SFC maduro no OpenPLC v4 para reaproveitar, o LasecSimul implementa o editor gráfico SFC e o lowering `SFC -> ST` como código próprio, seguindo o mesmo contrato de saída (ST textual) que os walkers `ld.ts`/`fbd.ts` produzem, para entrar no mesmo pipeline.
5. **ST como IR textual única**: LD, FBD e SFC baixam para **ST canônico gerado** (não para uma `IecCanonicalIR` estruturada própria); ST autoral do usuário e ST gerado por lowering entram no mesmo compilador. Isso substitui a decisão 3 do ADR-0006.
6. **STruCpp vendorizado**: o compilador ST -> C++17 do STruCpp é incorporado ao toolchain de build do LasecSimul (mesmo modelo de bundling relocável já usado para GHDL). A saída é C++17 compilado por um toolchain C++ real em um módulo nativo por projeto (`PlcNativeModule`), substituindo o `PlcBytecode`/VM de bytecode das decisões 5 e 6 do ADR-0006.
7. **Isolamento por processo, não por VM**: `PlcNativeModule` roda em um **worker próprio** dentro do padrão coordenador/workers limitados de ADR-0003 — mesmo modelo já usado para o worker Python (`features/python-runtime.md`) e para o processo GHDL (`features/fpga-ghdl.md`) — e não é `dlopen`/`LoadLibrary` dentro do processo principal do Core. `InputLatch`/`TaskEvaluate`/`OutputCommit` (ver `features/iec61131-plc.md`) tornam-se um protocolo de IPC com o worker, análogo ao `STEP_BATCH` do worker Python, em vez de chamadas de função para uma VM in-process.
8. `FUNCTION_BLOCK` mantém estado por instância; `FUNCTION` não possui memória de instância persistente; `PROGRAM` é raiz ligada a task/resource — isso não muda em relação ao ADR-0006.
9. A matriz de interoperabilidade 5×5 continua gate obrigatório, agora provada pelo ST gerado/compilado em vez de uma ABI de bytecode compartilhada.
10. IL permanece suportada explicitamente para compatibilidade e ensino.

## Consequências

Positivas:

- reaproveita a parte mais cara de construir (editores gráficos LD/FBD maduros, testados, com UX validada em produção real);
- reaproveita o lowering gráfico-para-ST já resolvido para LD/FBD;
- ganha desempenho de código nativo C++17 em vez de bytecode interpretado;
- clientes do LasecSimul mantêm seus próprios programas PLC sob a licença que quiserem, graças à runtime exception herdada do STruCpp;
- reduz o trabalho de construir um compilador ST/IL/LD/FBD do zero a apenas SFC.

Custos/riscos:

- o LasecSimul inteiro passa a ser GPL-3.0 — qualquer parte do produto que hoje é ou seria proprietária/fechada perde essa opção para versões futuras distribuídas; forks de terceiros tornam-se legalmente possíveis;
- perde-se a validação de VM (limites de memória/índice/stack/opcode antes do `RUN`); o isolamento passa a depender do processo do worker e do que o deployment (Desktop/SharedHost) impõe a ele — mesma admissão já feita para o worker Python ("Python não é sandbox de segurança forte");
- exige toolchain C++ real disponível para compilar `PlcNativeModule` (mesmo modelo de bundling relocável do GHDL, mas C++17 completo é mais pesado que um simulador VHDL);
- SFC não tem equivalente maduro a copiar — o cronograma desse front-end não é acelerado pela incorporação;
- manutenção de avisos de copyright/licença por arquivo vendorizado e acompanhamento de atualizações upstream do OpenPLC/STruCpp passam a ser trabalho recorrente.

## Rejeitado

- manter a VM de bytecode sandboxada como único backend (ADR-0006, superseded por este ADR);
- reescrever do zero editores LD/FBD que já existem maduros no OpenPLC v4;
- `dlopen`/`LoadLibrary` do `PlcNativeModule` dentro do processo principal do Core sem isolamento de processo;
- adotar apenas os conceitos do OpenPLC sem incorporar o código-fonte (opção descartada nesta revisão; ADR-0006 documentava essa postura anterior).

## Aviso de proveniência e licença

Todo arquivo vendorizado de `openplc-editor`/`STruCpp` preserva seu cabeçalho de copyright original e a licença GPL-3.0. O toolchain vendorizado (STruCpp) é distribuído com `COPYING` e `COPYING.RUNTIME` originais junto ao binário/pacote relocável, no mesmo padrão de distribuição já usado para GHDL.
