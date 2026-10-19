# Subsistemas internos e sistemas externos

Dois conceitos convivem na modelagem hierárquica do LasecSimul:

| | Sistema externo | Subsistema interno |
|---|---|---|
| Onde fica | arquivo `.lssubcircuit` próprio | dentro do documento (`.lsproj` ou `.lssubcircuit`), tabela `subsystems` |
| Reuso | entre projetos, paleta, biblioteca | dentro do documento (várias instâncias) |
| Paleta | só quando o usuário pede ("Adicionar à paleta") | nunca |
| Ao copiar o projeto | precisa do arquivo (caminho relativo) | vai junto, sem arquivo temporário nem caminho externo |

Os dois usam o mesmo manifesto (schemaVersion 3: modelo interno, interface/IO, Painel, propriedades
exportadas). Não há formato novo: a definição interna é um manifesto completo guardado na tabela.

## Definição e instância

- A **definição** é identificada por um `typeId` estável com prefixo `subsystem.` (ex.: `subsystem.planta`).
  O nome mostrado (`name`) é só apresentação: renomear não muda o `typeId` nem as ligações.
- A **instância** é um componente comum cujo `typeId` é o da definição. Cada instância tem parâmetros
  próprios (propriedades exportadas, `@<id interno>.<propriedade>`) e estado de simulação próprio:
  o Core expande cada instância separadamente.
- Editar o Modelo Interno de uma definição atualiza **todas** as instâncias dela. Para mudar só uma,
  use **Duplicar como definição independente…**. Mover ou editar um componente exposto direto no
  Painel de uma instância também altera a definição (como num sistema externo, onde altera o arquivo);
  o valor só daquela instância vai nas propriedades exportadas dela.
- Uma definição pode conter instâncias de outras (subsistema dentro de subsistema). Referência
  recursiva entre definições (A contém B que contém A) é recusada ao inserir, colar, incorporar, salvar
  o Modelo Interno ou abrir o projeto -- considerando também as definições abertas nos níveis acima
  (dentro de `Planta › Sensor`, colar uma Planta é recusado). Realimentação de sinal entre blocos
  continua permitida.

## Operações

Clique direito numa instância de **subsistema interno**:

- **Abrir Modelo Interno** / **Editar Painel**: entra na definição. A barra mostra o caminho
  (`Projeto › Planta › Sensor`); **Voltar ao nível superior** sobe um nível.
- **Inserir outra instância**, **Duplicar como definição independente…**, **Renomear subsistema…**.
- **Exportar como sistema externo…**: grava um `.lssubcircuit` autossuficiente (leva as definições
  internas de que depende). O projeto continua usando a cópia interna; o aviso oferece
  **Adicionar à paleta**.

Clique direito numa instância de **sistema externo**:

- **Abrir Sistema Externo**: edita o arquivo (que pode ter subsistemas internos próprios).
- **Incorporar ao projeto**: a instância passa a usar uma cópia interna, independente do arquivo.
- **Adicionar à paleta** (pasta "Meus Sistemas").

Seleção de um ou mais componentes → **Criar Subsistema Interno**: a seleção vira uma instância de uma
definição nova do documento (nenhum arquivo, nenhum item de paleta).

Comandos (`Ctrl+Shift+P`): **Inserir Subsistema Interno…**, **Gerenciar Subsistemas Internos…**
(inserir, abrir, editar Painel, renomear, exportar, excluir) e **Importar Sistema Externo como Cópia
Incorporada…**. Excluir uma definição usada dentro de outra é recusado; com instâncias no projeto,
pede confirmação e remove também as instâncias e os fios delas. Tudo isso pode ser desfeito.

## Copiar e colar

- Sistema externo continua externo: o caminho é resolvido no destino e o arquivo não é alterado.
- Subsistema interno colado em outro documento continua interno: a definição e toda a hierarquia
  abaixo dela são copiadas, sem vínculo com a origem. Instâncias que compartilhavam uma definição
  continuam compartilhando a cópia.
- Subsistema interno copiado de dentro de um `.lssubcircuit` em edição e colado num projeto vira
  subsistema interno do projeto.
- Nada é sobrescrito: definição com o mesmo `typeId` e conteúdo diferente entra com outra identidade
  (`subsystem.sensor_2`) e, se o nome já existir, nome ajustado ("Sensor (2)").
- Colar é um passo único de desfazer. Converter entre interno e externo é sempre uma ação explícita.

## Persistência e Core

- `.lsproj` e `.lssubcircuit` guardam a tabela em `subsystems` (só quando não vazia). Caminhos de
  sistemas externos usados dentro das definições ficam relativos ao documento no arquivo e absolutos
  em memória.
- Projetos antigos com cópias incorporadas por instância (`subcircuitRef.embedded`) são migrados na
  leitura para a tabela; instâncias com o mesmo conteúdo passam a compartilhar uma definição.
- No Core, as definições internas são registradas (dependências antes) pelo `typeId`. Subsistemas
  internos de um sistema externo são registrados no espaço de nomes do arquivo
  (`subsystem.sensor@subcircuits.planta`) e nunca colidem com os do projeto.

Código: `extension/src/ui/webview/subsystemModel.ts` (modelo puro), `extension/src/project/subsystemRuntime.ts`
(catálogo/Core) e `extension/src/extension.ts` (comandos). Testes: `subsystemModel.test.ts`,
`test/project/ProjectSubsystems.test.ts` e, com o Core compilado, `src/project/subsystems.realCore.test.ts`
(simulação) e `npm run test:subsystems:e2e` (VS Code real: criar, aninhar, navegar, desfazer/refazer,
renomear, duplicar, exportar, colar entre projetos, incorporar, excluir, reabrir e copiar de pasta).
