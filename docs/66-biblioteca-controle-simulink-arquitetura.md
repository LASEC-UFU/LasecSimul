# Biblioteca de controle equivalente ao Simulink — arquitetura e decisões

Este documento fixa a arquitetura da nova biblioteca de blocos de controle/modelagem dinâmica do
LasecSimul, equivalente aos blocos documentados pela MathWorks para o Simulink, e do mecanismo que
converte os blocos antigos (`control.*`, `subcircuits.control.*`) para ela. Os demais documentos da
série:

- `67-biblioteca-controle-simulink-inventario.md` — inventário dos blocos oficiais investigados e o
  estado de implementação de cada um;
- `68-biblioteca-controle-equivalencias.md` — matriz de equivalência bloco antigo → estrutura nova;
- `69-biblioteca-controle-migracao-e-validacao.md` — inventário de projetos, relatório de migração e
  comparação numérica antes/depois.

## 1. Ponto de partida (auditoria, 2026-10-20)

- O Core tem um único `SignalEngine` (`core/src/simulation/SignalEngine.*`): grafo de blocos com
  `SignalBlockKind` fixo, grupos por taxa (`RateGroup`), SCC com política explícita de laço algébrico,
  estados contínuos integrados por RK4 com duplicação de passo (erro estimado entra no passo
  adaptativo do Scheduler) e estados discretos travados na ativação.
- Os blocos `control.*` são instâncias de `SignalMathBlock` (`core/src/components/control/`), que
  traduz typeId + propriedades em blocos do engine. A paleta mostra 24 *wrappers*
  `subcircuits.control.*` (um `.lssubcircuit` com túneis e um único `control.*` dentro).
- Plantas e composições usam os primitivos diretamente: 22 composições TDPS (`tdps_*`), 9 plantas de
  processo (`process_*`), 3 transmissores HART, 5 exemplos do Laboratório, 7 projetos em `trm/` e
  fixtures de teste.
- Lacunas do engine para Simulink: sinais só escalares nas portas genéricas; sem tempo de
  amostragem herdado/contínuo/constante; sem fontes dependentes do tempo; blocos contínuos integrados
  isoladamente com entrada segurada (ZOH) dentro do passo; ordenação só dentro de cada grupo de taxa.
- Falha pré-existente registrada: `process_subcircuit` (ctest) espera 4 parâmetros no espaço de
  estados, mas o commit `b026c407e` passou a anexar `x0`. Não foi causada por este trabalho.

## 2. Identidade dos blocos novos

- typeId `sl.<bloco>` (ex.: `sl.gain`, `sl.transfer_fcn`, `sl.discrete_pid_controller`). O prefixo é
  só um espaço de nomes; os nomes mostrados são os nomes dos blocos na documentação oficial
  ("Transfer Fcn", "Gain"…), com tradução pt-BR.
- Parâmetros usam **o nome programático oficial** (`Gain`, `Numerator`, `Denominator`,
  `InitialCondition`, `SampleTime`, `UpperLimit`…), com o valor como **expressão** (texto) no
  subconjunto MATLAB descrito em §5. Rastreabilidade direta com `set_param` do Simulink.
- Portas: entradas `in1..inN`, saídas `out1..outM` (numeração 1-based do Simulink); portas de
  controle opcionais com nome de papel (`reset`, `x0`, `tr`, `up`, `lo`, `enable`, `trigger`).
- `control.*` passa a ser exclusivamente legado (lido só pelo módulo de migração). Blocos
  específicos do LasecSimul sem equivalente no Simulink que não são de controle (estoque conservativo
  do Laboratório) ficam fora da biblioteca Simulink com typeId próprio (`process.*`), ver doc 68.

## 3. Especificação declarativa única

`project/schema/block-library/*.json` (um arquivo por biblioteca do Simulink) é a fonte única de:
nomes, URL da documentação oficial, parâmetros (tipo, padrão, opções, aba, visibilidade condicional,
ajustável em execução), regras de portas, tempo de amostragem padrão e ícone. É lido:

- pelo Core (embutido no executável em tempo de build) para registrar metadados/schemas e resolver
  portas por instância;
- pela Extension para a paleta, o inspetor, os pinos por instância e o desenho do símbolo.

Regras de portas são vocabulário fechado (contagem fixa; contagem por parâmetro; sinais "+-|" do Sum;
operadores "*/" do Product; vetor de larguras do Mux; porta opcional condicionada a parâmetro). As
duas implementações (C++ e TS) são verificadas uma contra a outra por teste.

## 4. Execução: kernels no estilo S-function

Novo `SignalBlockKind::Kernel`: o comportamento vem de uma tabela de kernels (um arquivo por família
em `core/src/simulation/kernels/`), com os mesmos papéis do modelo de execução do Simulink:

| Função | Quando roda |
|---|---|
| `init` | ao ligar o plano (estados iniciais; IC externa lida das entradas) |
| `outputs` | a cada acerto de amostra do bloco (contínuo: a cada passo maior e a cada estágio do RK) |
| `update` | depois de todas as saídas do instante (estados discretos) |
| `derivatives` | estágios do integrador contínuo |
| `nextBreakpoint` | instantes que o passo precisa acertar exatamente (degrau, borda de pulso) |

Cada porta de entrada declara *direct feedthrough*; só essas arestas entram no SCC/ordenação (laço
algébrico continua exigindo política explícita). Nada aloca no caminho quente: estados, históricos
e vetores de trabalho são reservados no `bind()`.

### 4.1 Tempo de amostragem

`SampleTime` segue a semântica oficial: `-1` herdado, `0` contínuo, `Ts` ou `[Ts offset]` discreto,
`inf` constante. A sessão resolve na materialização: herdado recebe a taxa mais rápida das entradas
(contínuo se alguma entrada for contínua); sem entradas, constante. Blocos discretos ficam no
`RateGroup` de período `Ts` e deslocamento `offset`.

### 4.2 Partição contínua acoplada

Blocos de tempo contínuo formam uma partição ordenada. O passo contínuo do Scheduler integra **todos
os estados contínuos juntos** por RK4 com duplicação de passo: em cada estágio as saídas da partição
são reavaliadas no instante do estágio (fontes contínuas inclusive) e as derivadas calculadas — o
mesmo que um solver de passo fixo/variável do Simulink faz nos passos menores. Saídas de blocos
discretos entram seguradas (ZOH), como no Simulink. O erro estimado participa do controle de passo
já existente.

### 4.3 Ordem global no instante

Quando vários grupos de taxa têm acerto no mesmo instante, os blocos executam na ordem topológica
global (não grupo a grupo), como na execução *single-tasking* do Simulink: um bloco lento que
alimenta um rápido é visto no mesmo instante.

### 4.4 Sinais vetoriais

Portas declaram largura (fixa, herdada de uma entrada, ou derivada de parâmetro). A sessão propaga
larguras pelos fios até um ponto fixo; os kernels fazem expansão escalar como o Simulink.

### 4.5 Parâmetros ajustáveis

Parâmetros marcados `tunable` mudam com a simulação rodando sem recompilar o plano (cópia de
parâmetros por runtime); os demais exigem recompilação (simulação parada), como no Simulink.

### 4.6 Sinais lógicos

Sinais lógicos são `double` 0/1 — equivale à opção oficial "Implement logic signals as Boolean data
(vs. double)" desligada. Tipos inteiros/ponto fixo não existem no engine: blocos que dependem deles
emulam o efeito numérico (arredondamento/saturação) sobre `double` quando isso é bem definido.

## 5. Avaliação de parâmetros

Subconjunto MATLAB avaliado no Core (C++, autoridade) e na Extension (TS, para ícone e validação no
inspetor): números, `+ - * / ^ .* ./ .^ '`, parênteses, matrizes `[a b; c d]`, faixas `a:b:c`,
constantes `pi`, `Inf`, `NaN`, `eps`, `true`/`false`, funções escalares elementares e de construção
(`zeros`, `ones`, `eye`, `conv`, `poly`, `sqrt`, `exp`…). Expressões que referenciam variáveis do
workspace do MATLAB não existem aqui e são recusadas com mensagem explícita. Vetores de teste
compartilhados garantem que as duas implementações concordam.

## 6. Migração

Módulo único em TypeScript (`extension/src/migration/controlLibrary/`), separado do motor de
execução:

1. detecta typeIds legados no documento (componentes, tabela `subsystems`, manifestos incorporados);
2. aplica a regra da matriz de equivalência (1→1, 1→N, subsistema interno com os blocos novos);
3. reescreve fios, propriedades exportadas (`@id.prop`), componentes expostos, referências de telas,
   faceplates, Laboratório e séries;
4. valida a estrutura e devolve um relatório determinístico.

É idempotente (documento sem typeId legado não muda) e roda ao abrir `.lsproj`/`.lssubcircuit`. Ao
salvar um documento migrado, o original é copiado antes para `<arquivo>.legacy-backup` (uma vez).
Conversões sem equivalência demonstrável não são feitas em silêncio: o bloco fica marcado e o
relatório explica o impedimento.

## 7. Validação antes/depois

O executável do Core e a biblioteca do commit `ab4c1efb7` foram congelados em
`core/build-legacy-reference/` (fora do git, com SHA-256 em `SOURCE.txt`). Um executor sem VS Code
carrega cada projeto/planta, roda o original no Core legado e o migrado no Core novo com os mesmos
estímulos e compara cada saída (erro absoluto máximo, erro relativo, RMS, instantes de eventos).
