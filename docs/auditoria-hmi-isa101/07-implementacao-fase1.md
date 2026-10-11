# Implementação em andamento: Fase 1 — fundamentos HMI

Esta primeira fatia estabelece persistência de um modelo HMI opcional no `.lsproj`, sem alterar a versão do schema atual nem a cena existente:

- `HmiApplication`: página inicial e conjunto ordenado de páginas.
- `HmiPage`: ID/nome, dimensões escolhidas pelo projeto, elementos e links de navegação.
- `HmiPageElement`: projeção referenciada a componente ou gráfico independente, com geometria local por página.
- Leitura e escrita do campo no serializer; projetos sem esse campo continuam válidos.
- Inclusão em `WebviewProjectState` e sincronização incremental Extension/Webview.
- Inclusão no snapshot de dirty/save/open; alterações de páginas atualizam o estado sujo sem sincronizar geometria com o Core.
- Coordenadas do componente do esquemático permanecem na estrutura original; a colocação de página usa outro objeto.
- SVGs novos/redesenhados ficam sujeitos à lista revisada em `06-lista-ativos-svg.md`; no mapeamento atual não há arquivos a solicitar. Primeiro se complementam fontes, estados e bindings aproveitando os símbolos existentes.

A barra do editor agora permite criar uma página HMI a partir da seleção. Cada item fica em sua cena/página própria; o esquemático não é movido nem tem suas propriedades alteradas. A dimensão inicial é 1920 × 1080.

O `Verificar HMI` também valida a integridade estrutural dos elementos locais: IDs únicos por página e geometria com coordenadas finitas e tamanho positivo. Elementos malformados recebem achado próprio antes da checagem de viewport; referências e posição dos símbolos no esquemático permanecem inalteradas.

A autoria HMI foi integrada como modo de cena no canvas existente, seguindo a separação Circuito/Símbolo/Ícone. A barra permite selecionar páginas, criar, renomear, excluir e definir a inicial. O modo usa posições por elemento e por página; pode incluir projeções ligadas a componentes internos ou elementos gráficos independentes da paleta. As mudanças de posição e propriedades ficam na página HMI, sem alterar `components[].x/y` nem as propriedades do esquemático. O HMI é persistido no `.lsproj` e também no `.lssubcircuit`, com snapshot de alterações da sessão.

A copia/cola e a duplicacao por arrasto no modo HMI criam ocorrencias locais na pagina, preservam a referencia ao componente de origem quando existe e nao inserem dispositivos ou fios no circuito. Propriedades locais sao gravadas como diferencas, de modo que leituras/runtime nao editados continuam vindo do componente vinculado.

A exposição visual de componentes no símbolo (`exposedComponents`) e a exportação de propriedades (`exportedPropertyComponentIds`) continuam conceitos independentes. A autoria HMI permite criar páginas, selecionar, renomear, excluir e definir a inicial; posicionar, redimensionar e editar elementos locais; criar atalhos para outras páginas. A navegação aparece no canvas e pode ser arrastada sem mover os elementos existentes; uma faixa na barra oferece retorno à edição e saída do HMI. O modo Operar inicia na página inicial, oculta controles de autoria e mantém as projeções atualizadas com leituras/estados de runtime; ações de operador atuam quando a simulação está rodando. Excluir uma página remove os atalhos de entrada.

## Persistência verificada

Round-trip em `.lsproj` e `.lssubcircuit` cobre páginas e destinos, ordem dos elementos, elementos vinculados e independentes, overrides locais, rotações, geometria dos atalhos, stale timeout e eventos de exceção da auditoria. A regressão compara também as coordenadas dos componentes do subcircuito antes/depois, confirmando que os dados HMI não deslocam o esquemático.

Verificação desta etapa: `ProjectSerializer.test.ts` passou; `subcircuitDocument.test.ts` passou (13 casos); `hmiAudit.test.ts` passou (12 casos, cobrindo todos os IDs de regras). `npm test` passou (exit code 0), incluindo perfis versionados, fingerprints, HART, PLC Build, IL e SFC lowering, além da matriz IEC 61131/browser pós-teste.



Desfazer/refazer tambem restaura o modelo HMI e a pagina selecionada. Copiar, colar e duplicar por arrasto no HMI continuam locais a pagina, preservam vinculos a componentes de origem e nao inserem itens ou fios no esquematico. A verificacao estatica TypeScript passou na Webview e na extensao; os testes nao foram executados.

## Continuidade da Fase 2 - qualidade de comunicacao

O envelope de `componentReadout` e `boardOverlayReadouts` aceita o estado do transporte e `sampleTimestampNs` do frame coerente do Core; os bindings expoem esse tempo simulado como `__g_sample_timestamp_ns`, acompanhado de `__g_sample_timestamp_available` para distinguir um timestamp zero valido de ausencia. Quando uma requisicao de frame falha, o host invalida os snapshots anteriores de leituras, estados visuais, overlays e tensoes; bindings graficos passam a expor `__g_bind=disconnected`, `__g_quality=disconnected` e `__g_text_q=OFFLINE`. Fonte sem amostra continua distinta (`missing`/`bad`). Ao recuperar a comunicacao, um frame valido restaura o estado conectado. A aplicacao HMI aceita `staleAfterMs`, configuravel na barra do editor e desativado por padrao; se nenhum frame novo chegar durante o intervalo configurado com a simulacao rodando, elementos vinculados indicam `STALE` e deixam de exibir o valor como bom. A pausa suspende a contagem. O timestamp e compartilhado por todas as leituras do mesmo frame e nao representa horario individual de atualizacao do dispositivo; a politica ainda precisa de validacao por processo.

No overlay de subcircuitos, as tres fontes de um widget HMI (`bindSource`, `bindSourceB` e `bindSourceC`) agora entram na coleta de telemetria. Isso permite que faceplates multi-sinal atualizem PV, SP e saída quando usados sobre um subcircuito, mesmo quando as sondas fonte não são exibidas no símbolo.

No inspetor de propriedades dos gráficos `graphics.*`, os campos de origem agora são seletores dos componentes da cena que declaram `readoutFormat`, com ID visível para distinguir nomes repetidos. Um binding antigo sem origem disponível aparece como fonte não encontrada; se o componente ainda existe mas não declara leitura compatível, o inspetor explica essa lacuna. O critério evita oferecer símbolos P&ID e widgets sem leitura decodificável como fontes de valor. Esse é um diagnóstico de edição do binding, não um auditor completo da aplicação HMI.

Depois de selecionar uma origem, `bindChannel` vira um seletor limitado aos canais publicados por ela. Para origem escalar, somente o canal 0 é oferecido; para históricos/vetores, cada canal mostra seu índice. Assim a UI evita valores fora da faixa no uso normal, e a verificação continua detectando projetos legados ou valores importados inválidos.

A barra de autoria HMI inclui `Verificar HMI`, que percorre todas as páginas e informa referências de componente removidas, fontes inexistentes, fontes sem `readoutFormat`, canais fora da faixa publicada (inclusive canal diferente de zero em fonte escalar), controles sem alvo/propriedade de ação válidos, destinos de navegação inválidos, páginas sem caminho desde a inicial, IDs de página duplicados ou página inicial ausente, dimensões inválidas e elementos fora dos limites da página. Problemas estruturais/de binding são separados de avisos de rota/viewport. Cada achado ligado a um elemento abre a página correspondente e seleciona o elemento quando ainda existe na cena, inclusive quando sua referência ao componente esquemático foi removida. A verificação é informativa e não altera propriedades, layout ou autorização de operação; páginas sem binding configurado são válidas como composição estática. Coordenadas fora dos limites são reportadas, nunca corrigidas automaticamente.

Nos widgets com ação, os campos `actionTarget` e `actionProperty` podem selecionar componentes existentes e propriedades disponíveis/gravadáveis segundo o schema e as propriedades do alvo. IDs visíveis distinguem componentes homônimos; valores legados inválidos permanecem visíveis para correção. A ação continua sendo uma escrita genérica de propriedade e não implementa permissivos, autorização ou confirmação industrial.

## Continuidade da Fase 2 - revisao de unidades e faixas

O `Verificar HMI` compara a unidade declarada por fontes escalares com `bindUnit` de cada sinal do widget. Rotulo ausente ou unidade diferente sem escala/offset gera aviso; qualquer escala/offset nao neutro gera aviso de conversao nao verificada, mesmo quando os rotulos coincidem. Unidade igual so e considerada compativel quando escala=1 e offset=0. O diagnostico nao converte valores nem altera limites.

A verificacao tambem reporta parametros numericos nao finitos, casas decimais fora de 0..6, faixa de engenharia degenerada e limites LL/L/H/HH fora de ordem. Faixas invertidas continuam aceitas para escalas de acao reversa. Valores nao sao corrigidos automaticamente. Fontes multicanal sem unidade declarada continuam sem conclusao automatica.

`reviewGraphicalBindingUnit` e `reviewGraphicalBindingConfiguration` sao funcoes puras cobertas em `graphicsBinding.test.ts` (15 casos passam).
