# Unificação visual — o que foi implementado (2026-10-20)

**Classificação:** relatório de implementação **[I]**. Executa o plano dos docs
[60](60-unificacao-visual-diagnostico-e-inventario.md)–[64](64-unificacao-visual-refazer-exemplos-calculo.md) e os
[ADR 0016](adr/0016-tela-hmi-em-janela-auxiliar-do-vscode.md), [0017](adr/0017-documento-visual-unico.md) e
[0018](adr/0018-autoridade-do-documento-no-host.md). Onde o código seguiu outro caminho que o plano, a razão está na §3.

## 1. O que existe agora

| Pedido | Como ficou |
|---|---|
| Tela HMI como recurso de Controle › Ferramentas | componente `tools.hmi_screen` ("Tela HMI"), fora do solver (`pinCount: 0`); cada botão é uma tela (`screenId`) |
| Janela independente, segundo monitor, maximizar, tela cheia real (F11/Esc) | Painel Visual (`lasecsimul.visual`) acoplado na área de editores ou numa janela auxiliar do VS Code; tela cheia nativa do Electron, nos dois monitores, volta ao estado anterior |
| Menu de contexto por estado (edição, acoplar/desacoplar, tela cheia) | itens só quando se aplicam; mesmas ações na barra e no botão do canto |
| Quatro dimensões independentes (edição, acoplamento, janela, contexto HMI/Laboratório) | sessão por tela (`VisualSession`) + estado da janela DETECTADO pela geometria; trocar uma não mexe nas outras |
| Tela cheia mostra a experiência atual do Laboratório | contexto `lab`: cabeçalho do Laboratório (marca, páginas como abas, Apresentação) e as atividades com a aparência e o cálculo de antes |
| Recursos matemáticos como elementos da HMI | `graphics.math.*` em Miscelâneos › Grafico › Matemática: atividade do Laboratório, gráfico de função, parâmetro, equação, tabela de valores, tendência |
| Faceplate no mesmo motor, exposição sem duplicação, várias instâncias isoladas | Faceplate (painel de operação) do subsistema interno = documento visual da DEFINIÇÃO aberto por INSTÂNCIA; liga-se aos componentes internos por id e comanda `@<interno>.<prop>` da instância |
| Edição, persistência, sincronização com uma simulação, métricas | autoridade do documento e do desfazer no Host; uma telemetria repartida entre as vistas; métricas medidas (§6) |
| Refazer `examples/calculo` | os cinco projetos refeitos pelo gerador (botão + tela do Laboratório + Faceplates das plantas) |

## 2. Mapa plano → código

| Plano | Implementação | Testes |
|---|---|---|
| Painel Visual, janelas (doc 61, ADR 0016) | `extension/src/ui/panels/VisualPanel.ts`, `src/visual/visualPanels.ts`, `src/ui/webview/windowGeometry.ts`, `src/ui/panels/schematicBundleHtml.ts` | `run-visual-screens-e2e.cjs` |
| Documento visual e autoridade no Host (ADR 0017/0018) | `src/ui/webview/visualDocument.ts`, `src/visual/screenStore.ts`, `src/project/ProjectSerializer.ts` | `visualDocument.test.ts`, `ProjectVisualDocuments.test.ts` |
| Botão Tela HMI (doc 62 §5) | `src/catalog/toolsCatalog.ts`, `src/visual/legacyHmiMigration.ts` | `run-visual-screens-e2e.cjs` |
| Telemetria para N vistas (doc 62 §3.3) | `state.runtimeSinks` + `postRuntime` em `src/core/coreLifecycle.ts` | todos os E2E com simulação |
| Laboratório como elementos (doc 62 §6) | `src/ui/webview/mathWidgets.ts`, `src/catalog/mathCatalog.ts`, `src/ui/webview/labPages.ts`, `src/visual/labEmbeds.ts`, `src/visual/labScreens.ts`, `tsconfig.lab-embed.json` | `mathWidgets.test.ts`, `run-calculus-lab-e2e.cjs`, `run-calculus-lab-tank-e2e.cjs`, `run-visual-math-e2e.cjs` |
| Contextos de apresentação (doc 62 §7) | casca `lab` em `src/ui/webview/main.ts` (`renderLabShellHeader`) + `styles.css` | `run-calculus-lab-e2e.cjs`, `run-visual-math-e2e.cjs` |
| Faceplate e exposição (doc 62 §8–10) | `faceplate:<typeId>` em `screenStore.ts`; `openInstanceFaceplate`/`faceplateRuntimeTransform` em `visualPanels.ts`; `instanceReadableItems` em `coreLifecycle.ts` | `run-visual-faceplate-e2e.cjs` |
| Copiar/colar entre HMI e Faceplate (doc 62 §13.1) | `visualClipboardSet`/`visualClipboard`, `remapBindingPaths` | `visualDocument.test.ts`, `run-visual-faceplate-e2e.cjs` |
| Exemplos refeitos (doc 64) | `scripts/generate-calculus-lab-examples.cjs` | `ProjectVisualDocuments.test.ts`, os três E2E do Laboratório |
| Métricas (doc 63 §3.2) | contadores `window.__visualStats` (papel visual) | `run-visual-performance-e2e.cjs` |

## 3. Onde o código seguiu outro caminho que o plano

### 3.1 O `.lsproj` não mudou de versão

O plano previa `schemaVersion` 3 com um formato novo. Ficou o 2, com dois campos opcionais: `visualDocuments` (telas) e
`subsystems[].faceplate` (o Faceplate dentro da definição). `hmiApplication` e `calculusLab` só são **lidos**: na abertura
viram uma Tela HMI cada (com o botão no esquemático), o projeto fica marcado como alterado e a próxima gravação já sai no
formato novo. Um arquivo antigo abre sem diálogo nem conversão manual; um arquivo novo aberto numa versão antiga só perde
as telas, o resto do projeto abre.

### 3.2 Laboratório: a atividade inteira é um elemento

O doc 64 decompunha cada atividade em ~16 elementos (`function_plot`, `series_chart`, `steps`…) com um `DocumentGraph`.
O implementado é o elemento **`graphics.math.activity`**: a atividade do Laboratório, sem reescrita, dentro de um
`<iframe>` da página. Motivos: as vistas atuais têm o cálculo e o desenho validados (riscos R9 divergência numérica e R10
fidelidade visual do doc 63), e os checks dos dois E2E do Laboratório passam inalterados nas páginas novas (§5). Em
edição a atividade abre no modo professor; duplo clique edita "por dentro" (gravar pergunta, valores iniciais, modelo) e
o que o professor grava vira propriedade do elemento, com desfazer da tela. "Ocupar a página" faz a atividade preencher
a janela em operação, refluindo como o Laboratório numa janela daquele tamanho.

Para compor telas novas existem os elementos independentes: **gráfico de função** (f e g, derivada, raízes), **parâmetro**
(slider), **equação** (MathML, com substituição), **tabela de valores** e **tendência** (série no tempo de um binding).
Eles compartilham o **escopo da página**: cada `graphics.math.parameter` declara um nome (`a`, `b`…) que as expressões dos
outros usam. Não há tabela de sinais/expressões do documento nem `DocumentGraph`.

**Consequência:** o critério 9 do doc 64 vale para as páginas de elementos e para o que a atividade expõe no modo
professor; trocar, por exemplo, a cor de uma curva DENTRO de uma atividade não é possível (é desenho da atividade).

### 3.3 Por que a atividade roda num `<iframe>` com o código inline

O `<iframe>` isola o CSS global do Laboratório (`lab.css`) e os ids fixos das vistas (`#tkChartH`…). Um documento aninhado
numa Webview não carrega recursos: o *service worker* do VS Code identifica a Webview pela URL do cliente (`?id=`), que um
`srcdoc`/`about:blank` não tem — os pedidos voltam 404 (medido: `responseStatus` 0 mesmo depois de `document.open()`).
Por isso o Laboratório é compilado num arquivo só (`tsconfig.lab-embed.json`, AMD, 365 KB), o Host o envia uma vez por
vista e ele vai inline no `srcdoc`, com o nonce da página (a CSP é herdada). As mensagens da atividade passam pelo Painel
Visual (`labEmbedMessage`) e cada elemento tem o seu experimento de processo no Host (`labEmbeds.ts`); ao trocar de
janela, o experimento continua e reenvia estado e série (`ProcessExperiment.replay`).

O painel antigo do Laboratório (`CalculusLabPanel`) foi removido; o comando "LasecSimul: Laboratório de Cálculo" abre (ou
cria, com as seis atividades-modelo) a tela do Laboratório do projeto.

### 3.4 Faceplate: o painel de operação usa o motor das telas; o símbolo continua na sessão

O implementado é o **Faceplate de operação**: um documento visual por definição de subsistema interno (`faceplate:<typeId>`),
aberto pelo menu da instância ("Abrir Faceplate da instância") numa vista PRÓPRIA da instância. Na vista:

- os "componentes do projeto" são os internos da definição com os valores daquela instância (`effectiveChildProperties`);
- a telemetria é só a da instância (`<instância>:<interno>` → id interno);
- comandos (slider, botão) gravam `@<interno>.<prop>` na instância — vale só para ela, entra no desfazer e no arquivo, o Core
  aplica ao vivo (`setSubcircuitChildProperty`);
- editar o Faceplate muda a definição (todas as instâncias abertas recebem a mudança) **sem reconstruir o Core**;
- as páginas HMI antigas de uma definição viram o Faceplate na primeira abertura; na sessão de um subsistema interno o modo
  HMI deu lugar ao botão "Faceplate".

A página `symbol` (o desenho da instância no esquemático, com pinos, encapsulamento e componentes expostos) **continua**
sendo editada em "Editar Painel" (sessão do subsistema): ela compila para `PackageDescriptor`/pinos usados pela fiação, e
migrar essa autoria para o Painel Visual é o próximo passo (§7). Sistemas externos (`.lssubcircuit` por referência) não têm
Faceplate: "Incorporar como subsistema interno" antes.

### 3.5 Exposição: ids internos e caminhos, sem tabela de exposições

No Faceplate, elementos ligam-se aos internos pelo id (o mesmo em todas as instâncias). Numa Tela HMI, um binding pode ler um
interno de uma instância pelo caminho **`<instância>:<interno>`** (ex.: `tanque-lab:acc`); o Host passa a ler esse interno da
instância real (`instanceReadableItems`). Nada é copiado: a leitura e a escrita são sempre do componente real. A tabela
`Exposure` do doc 62 §9.1 não foi criada; `exposedComponents` e `exportedPropertyComponentIds` continuam como antes. Caminhos
têm **um nível** (o que o Core resolve hoje).

### 3.6 Os Faceplates moram no Host, fora de `schematicState.subsystems`

O esquemático devolve a tabela de subsistemas inteira em cada `projectChanged`; uma cópia atrasada dela apagaria uma edição
do Faceplate feita noutra vista. Por isso o Faceplate vive na loja de documentos visuais do Host (com as telas) e só vai para
dentro da definição ao gravar (`subsystemsForSave`); ao abrir, sai da definição para a loja.

### 3.7 Catálogo por vista

O catálogo do esquemático tem 36 MB (pacotes, imagens de placas, tabelas HART). Mandá-lo a cada vista fazia cada troca de
janela custar ~5,5 s e ~20 MB. A vista recebe só os tipos que usa (os do documento e os componentes que ele projeta, comanda
ou lê) mais os matemáticos e ferramentas; um tipo novo chega junto com a colocação pela paleta ou com a colagem de outra vista.

## 4. Como usar

| Para | Faça |
|---|---|
| Criar uma Tela HMI | paleta › Controle › Ferramentas › "Tela HMI"; clique no esquemático |
| Abrir | duplo clique no botão (com a simulação rodando, um clique); menu do botão: abrir acoplada, flutuante ou em tela cheia |
| Editar / operar | barra da tela ou menu de contexto; Esc ou F11 saem da tela cheia |
| Colocar elementos | com a tela em edição e ativa, clique um item gráfico da paleta (vai para a tela, não para o esquemático) |
| Laboratório | comando "LasecSimul: Laboratório de Cálculo" ou o botão do projeto; "+ Página do Laboratório…" na edição insere uma atividade |
| Editar uma atividade (professor) | em edição, duplo clique na atividade; clicar fora volta à página |
| Faceplate de uma instância | menu da instância do subsistema interno › "Abrir Faceplate da instância" |
| Ler um interno numa tela | binding com Fonte `instância:interno` |
| Copiar entre vistas | Copiar numa tela/Faceplate e Colar noutra: as ligações são remapeadas (`interno` ↔ `instância:interno`) |

## 5. Testes

Unitários (cadeia `npm test`): `visualDocument.test.ts` (7), `mathWidgets.test.ts` (8), `ProjectVisualDocuments.test.ts` (4),
além dos existentes; 73/73 arquivos passaram em 2026-10-20.

E2E no VS Code real com o Core real: todas as suítes no VS Code 1.128.0 de teste; Telas e Laboratório também no 1.141 instalado.
Na rodada do 1.141 a sessão RDP estava desconectada (um único monitor virtual), então o passo do 2º monitor foi pulado ali; ele
passou no 1.128 com os dois monitores. Se o monitor secundário sumir durante o teste (desconexão RDP), a suíte de telas avisa e
pula a verificação de volta ao monitor em vez de acusar falha:

| Suíte | Comando | Cobre |
|---|---|---|
| Telas | `npm run test:visual:e2e` | paleta, duplo clique, menus por estado, colocação roteada, desfazer/refazer no Host atravessando o Undock, tela cheia nos dois monitores, maximizar, operar, telemetria, acoplar, gravar |
| Laboratório | `npm run test:lab:e2e` | os checks do Laboratório nas páginas novas, Apresentação, professor por dentro, páginas-modelo com desfazer, CSP |
| Tanque (Core) | `npm run test:lab:tank:e2e` | os checks com o Core real, aberto pelo botão do exemplo, gravar/reabrir |
| Elementos matemáticos | `npm run test:visual:math:e2e` | parâmetros/gráfico/tabela/equação, mudança do professor vista pelo aluno, tela cheia `lab` nos dois monitores |
| Faceplate | `npm run test:visual:faceplate:e2e` | duas instâncias, valores e comandos isolados, edição da definição sem reconstruir, caminho `instância:interno` numa tela, colar com remapeamento |
| Desempenho | `npm run test:visual:performance` | M1, M2, M6, M7, M8, M10 (§6) |

Regressão das suítes existentes na mesma rodada: Sintonia PID, 20 cenários de fios, reabertura de projetos e subsistemas
(`run-subsystems-e2e.cjs`) passaram. A suíte de subsistemas copiava e colava com Ctrl+C/Ctrl+V, que nesta máquina passa pela
área de transferência do usuário; agora usa os itens "Copiar"/"Colar" do menu de contexto do LasecSimul (mesmas funções, sem a
área de transferência do sistema).

## 6. Métricas medidas

Medidas por `run-visual-performance-e2e.cjs` (VS Code 1.128, página de 300 elementos, 2026-10-20). Alvos do doc 63 §3.2.

| Métrica | Medido | Alvo | Situação |
|---|---|---|---|
| M1 Dock/Undock até a vista pintada | p50 ≈ 0,6 s, p95 0,76–1,26 s (20 trocas) | p95 ≤ 1,5 s | atende (antes do catálogo por vista: p95 5,9 s) |
| M2 tela cheia | 0 gravações de documento; entrar ≈ 1,4 s (inclui desacoplar) | 0 operações; relayout ≤ 300 ms | atende quanto ao documento; o relayout em si não foi isolado |
| M3 IPC de telemetria por tique | 1 leitura no Core, repartida a N vistas (`postRuntime`) | 1 | atende por construção (não instrumentado) |
| M6 memória por vista | 5–20 MB de heap no processo da vista | ≤ 40 MB | atende; ver deriva na §7 |
| M7 arrastar com 300 elementos | p95 31,3 ms por quadro, igual ao da vista parada (p95 31,3 ms) | p95 ≤ 16 ms | o arrasto não perde quadro; nesta máquina a vista pinta a ~32 Hz mesmo parada, então o alvo absoluto não é mensurável aqui (o teste compara com a cadência parada) |
| M8 interação matemática | p95 5–7 ms por mudança de parâmetro (repinta gráfico, equação e tabela) | p95 ≤ 2,5 ms (alvo da PoC do Laboratório) | dentro de um quadro; acima do alvo da PoC |
| M9 bytes por edição | o documento inteiro por edição (`visualDocumentChanged`) | elementos tocados | **não atende** |
| M10 `init` da vista | 89 KB (era 36 MB antes do catálogo por vista) | ≤ 200 KB | atende |
| M11 restauração após troca de janela | documento, desfazer, página, zoom, modo e contexto voltam (E2E) | 100 % | atende |
| M12 assinaturas de série | 1 por atividade aberta; duas vistas da mesma planta = 2 | 1 | **não atende** |

## 7. Pendências conhecidas

| Item | Situação | Próximo passo |
|---|---|---|
| Deriva de memória (M6) | em 20 trocas de janela a inclinação do heap do processo da vista variou de 0,16 a 0,71 MB por troca entre rodadas, com ruído de ±4 MB (ex.: 9,5 → 17,7 MB, sem crescimento monotônico); cada troca é um documento novo e o `init` é constante (89 KB) | heap snapshot para ver se o VS Code/Chromium retém documentos de Webview descartados |
| M7 numa máquina a 60 Hz | aqui a vista pinta a ~32 Hz mesmo parada | medir de novo num monitor físico a 60 Hz; se passar de 16 ms, repintura incremental por elemento |
| M9, M12 | ver §6 | patch por elemento; `SeriesStore` compartilhado por assinatura |
| Página `symbol` do Faceplate | continua em "Editar Painel" (sessão) | autoria do símbolo no Painel Visual, com pinos e encapsulamento |
| Faceplate de sistema externo | não existe | `faceplate` no `.lssubcircuit` lido para externos |
| Faceplate depois de recarregar o VS Code | restaurado no contexto da instância (o estado da Webview guarda `__visualInstanceId`); sem E2E de recarga | E2E com "Developer: Reload Window" |
| Elemento "Faceplate embutido numa tela" (doc 62 §4) | não feito; telas leem internos por caminho | elemento que desenha uma página do Faceplate no contexto de uma instância |
| Caminhos de N níveis | um nível | resolução nível a nível no Core |
| Decomposição das atividades | atividades monolíticas (§3.2) | extrair `series_chart`/`process_tank` se houver demanda |
| Política `stop-required` fora das atividades | comandos de Faceplate seguem a propriedade comum | `CommandGateway` com política por parâmetro |
