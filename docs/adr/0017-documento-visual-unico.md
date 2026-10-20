# ADR 0017 - Um documento visual para Tela HMI, Laboratório de Cálculo e Faceplate

## Objetivo

Definir o modelo de dados e de elementos comum às três ferramentas visuais.

## Status

Aceita e implementada com ajustes (2026-10-20), ver [docs/65](../65-unificacao-visual-implementacao.md) §3: o `.lsproj` continua no `schemaVersion` 2, com
`visualDocuments` (telas) e `subsystems[].faceplate` (Faceplates); `calculusLab` e `hmiApplication` só são lidos e viram
telas na abertura. Supersede o formato do [ADR 0015](0015-calculuslab-no-lsproj.md). Proposta em 2026-10-19; análise em
[`docs/60`](../60-unificacao-visual-diagnostico-e-inventario.md) e [`docs/62`](../62-unificacao-visual-arquitetura-e-documento.md).

## Contexto

- HMI e Faceplate já são modos de cena do mesmo editor, mas com dados diferentes (`HmiPageElement` × `symbolElements` +
  `exposedComponents`); o Laboratório usa outro painel, outro modelo (`calculusLab.activities`) e vistas monolíticas.
- "Mostrar o objeto real sem duplicá-lo" existe duas vezes, com formas incompatíveis.
- Nenhum arquivo do repositório usa `hmiApplication`; 5 exemplos usam `calculusLab`; 61 dos 62 subcircuitos da biblioteca
  têm exposições. A política de schemas beta (ADR-0005 da `.spec`) admite ruptura com conversor explícito.

## Decisão

- `VisualDocument { kind: "screen" | "faceplate", pages[], signals[], expressions[], parameters[], presentation }`.
- Páginas com layout `canvas` (absoluto, escala uniforme) ou `grid` (responsivo, para preservar o Laboratório).
- Elementos: `item` (qualquer `graphics.*`, inclusive `graphics.math.*`), `ref` (projeção de componente real por caminho
  de instância), `pin` (só na página `symbol` do Faceplate), `faceplate` (painel de uma instância embutido numa tela).
- O Laboratório deixa de ser tipo de documento: é **contexto de apresentação** (casca e tema atuais) + **elementos
  matemáticos** + **modelos de página** das seis atividades.
- O Faceplate é o documento visual da definição do subsistema: página `symbol` (instância no esquemático) e páginas `panel`
  (operação por instância). Exposições explícitas (`signal`/`parameter`/`state`/`component`) com ids públicos estáveis.
- A Tela HMI é inserida pelo componente `tools.hmi_screen` em Controle → Ferramentas (um botão = um documento).
- Formatos: `.lsproj` v3 (`visualDocuments`), manifesto/`.lssubcircuit` v4 (`faceplate`, `exposures`), com conversor.

## Consequências

- Um editor, um renderizador, um Inspector, uma auditoria de referências para as três ferramentas.
- Tudo o que se desenha numa tela se desenha no Faceplate; matemática e processo convivem no mesmo documento.
- Ruptura de formato: conversor obrigatório para exemplos, bibliotecas e geradores do repositório.
