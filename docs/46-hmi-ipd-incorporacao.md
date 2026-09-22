# Incorporação do HMI Studio do IPD — camada visual sobre o nosso motor

Auditado e implementado em 2026-09-22 contra `external-research/ipd-studio-current`
(commit `4b84fb8694bc89985872690366e8be2e32a8db2b`, PolyForm Noncommercial 1.0.0).

## 1. O pedido e o recorte

O pedido foi incorporar o "HMI training simulator" do IPD, **"só da parte visual e usando o motor
que já temos"**. Esse recorte não é uma simplificação de conveniência: ele é a única forma de a
incorporação caber na arquitetura. A FEAT-008 já estabelece que visualização é projeção de
telemetria, e um segundo simulador dentro do editor seria uma segunda resposta para "qual é o nível
do tanque" — exatamente o defeito que a própria auditoria do upstream chama de "um valor na
simulação, outro na HMI".

O que o IPD chama de HMI Studio é, na prática, duas coisas empacotadas juntas:

| Camada | Upstream | Decisão |
|---|---|---|
| Widgets, paleta, tipografia, semântica de cor | `src/hmi/theme.ts`, `src/hmi/widgets/*.tsx`, `Faceplate.tsx`, `AlarmBanner.tsx` | **Portado** |
| Simulador de processo | `src/hmi/sim/` — rede hidráulica, modelo de processo, controlador PI com anti-windup, ciclo de vida de alarme ISA-18.2, histórico amostrado, cenários, ruído determinístico | **Não portado** |

A segunda linha é um simulador que funciona, e descartá-lo foi deliberado. Quem resolve o processo
continua sendo o Core do LasecSimul.

## 2. Por que a técnica de porte é diferente da dos símbolos P&ID

O porte anterior (193 símbolos, `generate-ipd-symbol-library.mjs`) pôde ser um `DIRECT_PORT`: um
`SymbolDef.render(cfg)` devolve SVG pronto, então dá para executar o renderizador do upstream em
tempo de geração e congelar o markup.

Aqui não dá. Um widget de HMI é função da geometria **e do valor ao vivo** — `yOf(pv)`, `angOf(pv)`,
a cor contra os limites. Congelar o render produziria uma figura morta com um valor fixo, que é o
oposto do pedido. Então a geometria foi **transcrita** das fórmulas do upstream para o IR
declarativo, e o que varia é dirigido pelo resolvedor único de binding. Classificação:
`ADAPTED_PORT`.

## 3. O que foi portado

`scripts/generate-ipd-hmi-library.mjs` publica **10 widgets** em `Gráfico > HMI`, elevando o
catálogo gráfico a **242 entradas** (34 nativos + 193 P&ID + 10 HMI, mais 5 formas básicas)
— já descontadas as duplicatas nativas removidas na §9.

| Widget | Origem | O que responde ao binding |
|---|---|---|
| Indicador de barra | `bar.tsx` | preenchimento, ponteiro, marcas LL/L/H/HH, seta de SP |
| Medidor radial | `gauge.tsx` | ponteiro (−120°..+120°), arcos de zona nos limites |
| Display de valor | `display.tsx` | valor, SP opcional, cor da borda pelos limites |
| Vaso / tanque | `tank.tsx` | nível, marcas de limite; 4 silhuetas por propriedade |
| Válvula | `valve.tsx` | cor de estado, posição em % |
| Bomba / motor | `pump.tsx` | estado em cor **e em palavra**, hachura de fora de serviço |
| Lâmpada | `lamp.tsx` | estado |
| Moldura de painel | `panel.tsx` | — (layout) |
| Faceplate de malha | `Faceplate.tsx` | PV, SP e OP, cada um com binding próprio |
| Tarja de alarme | `AlarmBanner.tsx` | condição contra os limites |

### 3.1 O design system

`theme.ts` foi copiado valor a valor, na variante `hp` (ISA-101 *high performance*), que é a certa
para o nosso canvas claro. Junto vem a regra que dá sentido à paleta, e que vale a pena repetir
porque ela é a parte não óbvia: **a operação normal recua**. Equipamento parado, linha sem fluxo e
valor dentro dos limites usam só tons de superfície; cor saturada fica reservada ao que exige ação.
**Um significado por cor** — vermelho é anormal em todo lugar, e uma bomba parada é neutra, nunca
vermelha, senão uma planta corretamente desligada parece uma emergência.

Cor também nunca é o único portador: a bomba mostra `PARADA` / `EM MARCHA` / `FORA DE SERVIÇO` /
`DISPARADA` por escrito, e fora de serviço ainda recebe hachura.

## 4. As três extensões que o porte exigiu

Nenhum widget tem lógica própria; tudo o que eles precisavam a mais entrou no **resolvedor único**
(`extension/src/ui/webview/graphicsBinding.ts`), que é onde esse tipo de cálculo pertence.

**Limites em unidade de engenharia.** O IR só sabe expressões lineares num único sinal
(`prop * multiplier + offset`), e posicionar uma marca de limite envolve o trio (limite, min, max).
Em vez de obrigar o usuário a converter para porcentagem à mão, o resolvedor publica
`__g_ll_pct`/`__g_l_pct`/`__g_h_pct`/`__g_hh_pct` já normalizados — e `__g_*_set`, que é o que faz
um indicador **sem** limite declarado não desenhar marca nenhuma. Inventar quatro limites padrão é,
nas palavras do próprio upstream, como três arquivos diferentes passaram a ter três cópias de
`5/10/90/95`.

**Qualidade do dado.** `__g_quality` vale `"bad"` quando há fonte declarada que nunca publicou
leitura. Um widget com qualidade ruim não desenha ponteiro nem preenchimento e imprime `- - -`
(`__g_text_q`): mostrar o último número que ele tinha é como um instrumento morto passa um turno
inteiro despercebido. `__g_text` ficou intocado de propósito — mudá-lo alteraria o comportamento
das telas já publicadas.

**Sinais secundários.** Uma malha mostra três variáveis, e um faceplate que só soubesse ler uma não
seria um faceplate. `__g_b_*` e `__g_c_*` são o MESMO contrato com outro prefixo de propriedade
(`bindSourceB`, `bindScaleB`, …), resolvidos pela MESMA função — não há um segundo resolvedor, e um
símbolo que usa só o sinal primário não declara nenhuma dessas propriedades.

## 5. Um erro que vale registrar

A primeira versão emitiu as primitivas em `package.shapes[]`, como a biblioteca P&ID portada faz.
Os dois campos aceitam a mesma lista, mas **só o renderizador de `simulidePaint` avalia
`PackageNumberExpression`**; em `shapes[]` a expressão é usada como está e o atributo sai
literalmente `[object Object]`. O resultado era enganoso: moldura, rótulos e cores corretos, e todo
elemento dirigido por valor mudo. `shapes[]` serve a primitivas de SVG estático; onde o desenho É
função do valor, o caminho é `simulidePaint`.

O medidor radial é o único que precisa de **rotação** por valor, e `simulidePaint` só tem
`transform` estático. Ele usa `viewSpec` com `overlayPaint: true`: o corpo é pintado normalmente e
só o ponteiro vem do ViewSpec, girado por `stateProjection.rotate` com `propRange: [0,100]` →
`angleRange: [-120,120]`, que é exatamente o `angOf` do upstream. O ViewSpec só ativa quando a
Webview passa um `componentId` — o teste passa um, senão exercitaria um caminho que a tela real
nunca usa.

## 5b. Dois defeitos que só a prancha de contato mostrou

Os widgets passavam em todos os testes e apareciam visivelmente errados na tela. Ambos têm a mesma
causa: geometria transcrita de um SVG cujos **defaults** e cuja **caixa** não são os nossos.

**Âncora de texto.** O renderizador assume `text-anchor="middle"` quando a forma não declara um
(`componentSymbols.ts`), enquanto o SVG do upstream assume `start`. Um rótulo transcrito como `x={8}`
era centralizado em x=8 e perdia a metade esquerda: "TI-301" virava "-301", "GRUPO" virava "RUPO".

**Caixa.** O upstream escreve o TAG em `y = h + 12`, ou seja FORA da caixa do widget — lá a tela não
recorta. Aqui a caixa É o recorte, então o rótulo era cortado ou caía em cima do corpo. Cada widget
ganhou a sua faixa de rótulo no próprio desenho (`bodyH` separado de `h`).

Nenhum dos 661 testes existentes pegava isso, porque a galeria de símbolos desenha cada peça escalada
para uma célula fixa — o que esconde exatamente esse defeito. `npm --prefix extension run
test:hmi:visual` renderiza os widgets em **1:1 com a caixa declarada marcada**, e é como os dois
foram encontrados. A regra virou teste.

## 6. Verificação

| Comando | Resultado |
|---|---|
| `npm --prefix extension test` | **666 passaram, 0 falharam** |
| `tsc --noEmit` (host e webview) | limpo |
| `node scripts/generate-ipd-hmi-library.mjs` | 10 widgets, 20 ícones |

Nove testes novos em `extension/src/catalog/graphicsLibrary.test.ts` cobrem o que é específico do
porte, renderizando pelo caminho REAL da Webview (`registerPackage` → `packageSymbolSvg`):

- a barra cresce com o valor;
- a marca `H = 80` numa faixa `0..100` cai em `y = 42.4`, e some quando o limite não é declarado;
- qualidade ruim suprime o preenchimento e imprime traços, sem deixar o último número aparecer;
- o ponteiro do medidor gira −120° em 0 % e +120° em 100 % (o que também prova que o `viewSpec`
  sobreviveu ao sanitizador do catálogo);
- o faceplate desenha três barras que seguem três sinais independentes;
- a tarja escolhe a severidade maior quando o valor viola H e HH ao mesmo tempo;
- todo rótulo declara âncora explícita e cai dentro da caixa do widget (as duas regressões da §5b);
- **e dois testes negativos**: todo widget tem `pinCount: 0`, e nenhum declara propriedade de modelo
  de processo (`kp`, `ki`, `flow`, `pressure`, `scenario`, …). É a garantia estrutural de que o
  motor continua sendo o nosso, em vez de uma promessa neste documento.

## 7. O que ficou de fora, e por quê

1. **Todo o `src/hmi/sim/`** — por decisão explícita do recorte (§1).

2. **Trend e sparkline** (`trend.tsx`, o `spark` de `display.tsx`). Eles precisam de histórico
   amostrado por sinal. O nosso `__history` existe, mas é alimentado só para os typeIds de
   instrumento (`updateReadoutHistories` filtra por `instrumentHistoryKind`), não para um binding
   gráfico qualquer. Fazer o trend honestamente significa acumular amostras por elemento gráfico no
   mesmo tique de telemetria — mecanismo novo, pequeno mas real. Preferi não entregar um gráfico que
   desenha uma curva inventada.

3. **Ciclo de vida de alarme.** `__g_alarm` é **codificação visual** do valor contra os limites, não
   um motor: não há reconhecer, silenciar, inibir, prateleira nem prioridade configurável. Um alarme
   ISA-18.2 de verdade tem estado que persiste e transições que um operador comanda, o que é
   funcionalidade de motor, não de desenho.

4. **Páginas de operador** (`src/hmi/operator/`: visão geral, alarmes, tendências, diagnósticos,
   cenários) e o workspace HMI. São telas inteiras do aplicativo do IPD, não elementos de biblioteca;
   incorporá-las seria embutir um segundo aplicativo, que o próprio enunciado do porte proíbe.

5. **Botões e chaves** já existiam como `graphics.hmi_button` / `hmi_lamp_button` / `hmi_toggle`
   (porte anterior, registrado na sua própria linha do registro de reúso). Não foram duplicados.

## 8. Proveniência

Registrado em `docs/third-party/IPD_STUDIO_PROVENANCE.md` como `ADAPTED_PORT`, com arquivos de
origem, commit fixado, PolyForm Noncommercial 1.0.0, URL da licença e o aviso exigido repetidos em
cada item do catálogo e em cada ícone gerado. O uso é acadêmico/não comercial, e o código adaptado
não é apresentado como original.

## 9. Deduplicação (2026-09-22)

O editor passou a mostrar `Duplicate device ID: logic.adc` / `logic.dac`. A causa era estrutural e
não tinha relação com o porte: esses dois dispositivos existiam ao mesmo tempo como item do
`component-catalog.json` **e** como manifesto em `devices/simulide-logic/*.lsdevice`. A convenção do
repositório foi confirmada contando — dos 80 dispositivos de `devices/library.json`, os outros **78
não aparecem** no catálogo estático. Um dispositivo de biblioteca pertence ao seu manifesto; os dois
itens estáticos eram a anomalia e foram removidos, junto de `adc_dac_entries.json`, uma terceira
cópia órfã na raiz do repositório que nada referenciava.

A verificação existente (`deviceUniqueness.test.ts`) exercitava a **função**, não os **dados**, então
o defeito só aparecia como popup ao abrir o editor. Agora um teste roda o mesmo detector sobre o
catálogo, as duas `library.json` e os manifestos reais.

Na camada gráfica havia a mesma espécie de duplicação, e ela é a que o usuário pediu para resolver:
três famílias de equipamento tinham versão nativa desenhada à mão **e** versão herdada do IPD.
Removidos: `graphics.tank`, `tank_horizontal`, `vessel`, `tank_ipd`, `valve`, `control_valve_ipd`,
`control_valve_industrial`, `hand_valve_industrial`, `pump`, `motor`. Os 24 sinóticos TDPS passaram a
usar `graphics.hmi.tank`, `graphics.hmi.valve` e `graphics.hmi.pump`, que além de herdados respondem
ao binding — o desenho P&ID (`graphics.pid.*`) é congelado e não mostraria nível nem posição.

O que **não** foi tocado, porque não era duplicação: `value_display` (263 instâncias), `label` (55),
`controller_faceplate` (53), `signal_line` (51), `pipe` (49), `instrument` (24) e `level_bar` (24).
Nenhum deles tem contraparte no IPD; são elementos nativos de supervisório, e removê-los destruiria
as telas sem nada para pôr no lugar.

Um segundo defeito estrutural apareceu no caminho: o gerador nativo filtrava o catálogo apenas pelos
typeIds que ele ainda declarava, então um símbolo REMOVIDO da fonte permanecia no catálogo para
sempre, porque nada mais o reivindicava. Ele agora poda o namespace `graphics.<id>` inteiro (exceto
`pid.*`, `hmi.*` e as formas legadas), e "apagar daqui" passou a significar "apagar do catálogo".
