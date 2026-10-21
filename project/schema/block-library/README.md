# Especificação da biblioteca de blocos equivalente ao Simulink

Fonte única (docs/66 §3) lida pelo Core (embutida no executável em tempo de build) e pela Extension.
Um arquivo por biblioteca do Simulink; uma família extensa pode ficar num arquivo próprio com o mesmo
`library`/`name`/`title`/`order` (ex.: `pid-continuous.json` e `pid-discrete.json` aparecem nas pastas
Contínuos e Discretos). Cada família tem dono único nos demais arquivos também: kernels
(`core/src/simulation/library/kernels/<Família>Kernels.cpp`), builders
(`core/src/components/blocks/builders/<Família>Builders.cpp`), ícones
(`extension/src/ui/webview/blockLibrary/icons/<família>.ts`), teste (`core/test/core/library/`) e
casos de porta (`test/fixtures/block-library/port-vectors-<família>.json`). Cada bloco:

| Campo | Significado |
|---|---|
| `id` | slug; o typeId é `sl.<id>` |
| `name` | nome oficial do bloco na documentação MathWorks |
| `title` | nome traduzido (`pt-BR`); `en` usa `name` |
| `doc` | URL da página oficial do bloco |
| `simulink` | identificação no arquivo `.slx/.mdl`: `blockType` (BlockType nativo) e/ou `sourceBlock` (bloco de biblioteca mascarado, `BlockType="Reference"`) e, quando o mesmo BlockType gera vários blocos, `match` (parâmetros que distinguem) |
| `sampleTime` | `{ "param": "SampleTime" }` (parâmetro oficial) ou `{ "fixed": "continuous" \| "inherited" \| "constant" }` |
| `params[]` | parâmetros oficiais: `name` (nome programático), `type` (`expr`, `enum`, `bool`, `string`), `default` (como na documentação), `options` (enum), `group` (aba do diálogo), `visibleWhen`, `tunable`, `title` |
| `inputs[]`, `outputs[]` | regras de porta: `{ "id": "in1" }` fixa; `"when": {param: [valores]}` condicional; `{ "repeat": {"param", "rule"}, "prefix", "start" }` com `rule` = `signs` (Sum), `ops` (Product), `count`, `vectorLength` |
| `size` | tamanho padrão do ícone no Simulink (px) |

Valores `bool` são `true`/`false` (o importador converte `on`/`off`). Expressões numéricas seguem o
subconjunto MATLAB de `core/src/simulation/library/ParamExpr.hpp`.
