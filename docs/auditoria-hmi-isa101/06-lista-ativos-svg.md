# Lista de ativos SVG para próximas etapas

**Estado:** revisão baseada no catálogo e nos tipos de componentes registrados no Core. Nenhum SVG novo está confirmado como necessário. O catálogo contém muitos símbolos P&ID, mas eles são gráficos semânticos estáticos; o catálogo de componentes do Core não oferece modelos de processo para a maioria das famílias. Portanto, complementar primeiro o modelo/bindings/estados e preservar cada instância e sua posição. Solicitar nova arte apenas se, após essa complementação, o desenho não atender à tarefa HMI.

## Já disponível — não precisa reenviar agora

| Família | Ativos gráficos atuais | Diretriz |
|---|---|---|
| Bombas | `graphics.pid.pump_*`; `graphics.hmi.pump` | Símbolos e widget HMI disponíveis. Não há modelo Core de bomba no catálogo atual; `outputs.dc_motor` representa motor elétrico, não bomba/processo. Complementar fonte de estado e binding de equipamento. SVG: não solicitar agora. |
| Válvulas | `graphics.pid.valve_*`, `graphics.pid.cv_*`; `graphics.hmi.valve`; `graphics.valve_globe_svg` | Desenhos estáticos e widget de abertura disponíveis. Não há modelo Core de válvula/processo no catálogo atual. Definir binding de posição/comando/qualidade e falha. SVG: não solicitar agora. |
| Tanques/vasos | `graphics.pid.vessel_*`; `graphics.tank_svg`; `graphics.hmi.tank` | Desenhos e widget com nível disponíveis. Não há modelo Core de tanque/processo no catálogo atual. Vincular a fonte de nível já simulada/representada; especificar alarmes e qualidade. SVG: não solicitar agora. |
| Motores | `graphics.pid.motor`; `outputs.dc_motor` | Existe modelo elétrico de motor DC. Confirmar quais propriedades/sinais do motor são publicáveis para HMI; não assumir estado de manutenção ou falha de processo. Símbolo existente fica no lugar. SVG: não solicitar agora. |
| Ventiladores/sopradores | `graphics.pid.fan`, `graphics.pid.blower` | Símbolos P&ID existem; modelo Core dedicado e widget HMI dedicado não aparecem no catálogo. Identificar sinais por binding ou especificar o modelo mínimo. SVG: não solicitar agora. |
| Misturadores/agitação | `graphics.pid.agitator`, `graphics.pid.mixer_static`, `graphics.hmi.*` genéricos | Símbolo estático existe; não há modelo Core dedicado nem widget HMI de agitador. Definir estado/velocidade e origem de dados. SVG: não solicitar agora. |
| Filtros | `graphics.pid.bagfilter`, `graphics.pid.filter_*`, `graphics.pid.strainer_*` | Símbolos estáticos existem; modelo Core e widget dedicado não aparecem no catálogo. Definir diferencial de pressão/saturação/indisponibilidade e origem dos sinais. SVG: não solicitar agora. |
| Aquecimento e troca térmica | `graphics.pid.heater_*`, `graphics.pid.hx_*`; `graphics.heat_exchanger` | Símbolos estáticos disponíveis; modelo Core dedicado não aparece no catálogo. Mapear temperaturas/fluxos e estados antes de determinar se algum desenho falta. SVG: não solicitar agora. |

## Mapeamento encontrado e complementação necessária

O catálogo de componentes atual lista modelos elétricos, de instrumentação, comunicação, desenho e controle de baixo nível. Entre as sete famílias acima, `outputs.dc_motor` é o único modelo de equipamento diretamente relacionado; ele modela um motor DC. Os `graphics.pid.*` não são dispositivos Core e não produzem telemetria por si. Os widgets `graphics.hmi.*` são elementos visuais configuráveis e podem receber bindings, mas isso também não cria o modelo de processo ausente.

| Símbolo existente → possível fonte | Estados/sinais para HMI | Trabalho de software antes de pedir arte | Posição/layout |
|---|---|---|---|
| `graphics.pid.motor` → `outputs.dc_motor` | ligado/desligado e variáveis elétricas que o Core disponibilizar; falha/qualidade somente se houver fonte explícita | Inspecionar propriedades e telemetria publicadas; mapear sem atribuir semântica de processo inexistente | Manter ID, X/Y, rotação, escala e camada |
| `graphics.pid.pump_*` → componente/sinais existentes no projeto ou futuro modelo de bomba | comando, ligado, indisponível, falha e, quando modelados, vazão/pressão | Criar/estender modelo de processo ou bindings projetados a sinais explícitos; associar `graphics.hmi.pump` como widget opcional | Manter símbolo e conexões no mesmo local |
| `graphics.pid.valve_*` / `cv_*` → tag/faceplate ou futuros sinais de válvula | posição pedida/real, aberta/fechada, modo e qualidade | Estabelecer contrato de binding e ação com unidade, limites, qualidade e permissões de operação; usar widget `graphics.hmi.valve` | Manter símbolo e conexões no mesmo local |
| `graphics.pid.vessel_*` → fonte de nível existente ou futuro modelo de vaso | nível, limites, qualidade; capacidade apenas quando modelada | Conectar widget `graphics.hmi.tank` ou `graphics.tank_svg` à fonte; não inferir volume a partir do desenho | Manter símbolo e conexões no mesmo local |
| `graphics.pid.fan` / `blower` → sinais existentes ou futuro modelo | ligado, rotação, falha/indisponível | Definir fonte e estados; avaliar widget genérico (display/lamp/faceplate) | Manter símbolo no mesmo local |
| `graphics.pid.agitator` / `mixer_static` → sinais existentes ou futuro modelo | ligado, rotação, falha/indisponível | Definir fonte e estados; widget genérico até surgir requisito visual específico | Manter símbolo no mesmo local |
| `graphics.pid.filter_*` → sinais existentes ou futuro modelo | diferencial de pressão, condição de saturação/limpeza e qualidade | Definir variáveis e alarmes; usar indicadores existentes enquanto suficientes | Manter símbolo no mesmo local |
| `graphics.pid.heater_*` / `hx_*` → sensores/variáveis existentes ou futuro modelo | temperaturas, fluxo/serviço e qualidade | Bindings a sinais explícitos e faceplate/indicadores; modelo dedicado somente se simulação precisar representar dinâmica física | Manter símbolo no mesmo local |

Assim, “tem o P&ID, mas faltam dispositivos” significa que o desenho do equipamento já pode estar no esquema, enquanto faltam objetos/sinais Core com comportamento simulado e contrato de dados para animá-lo e operá-lo. O primeiro complemento deve aproveitar tags, sensores, controladores, gráficos e posições já existentes. A arte SVG só volta à lista se a avaliação de uma tarefa concreta encontrar uma limitação visual que overlays e widgets não resolvam.

O inventário gráfico tem cobertura estática nessas famílias. A falta que a auditoria identificou é principalmente de modelo dinâmico, telemetria, estados, histórico e comando; uma nova imagem por si só não resolve essas lacunas.

## Solicitação de arte SVG

**Lista para o usuário enviar agora: vazia.** Os nomes de arquivos sugeridos anteriormente (`motor-processo.svg`, `ventilador-soprador.svg`, `misturador-agitador.svg`, `trocador-calor-processo.svg`, `filtro-processo.svg`, `valvula-atuada.svg`, `bomba-processo.svg`) ficam suspensos: eram hipóteses antes de cruzar o catálogo, e não evidência de que a arte existente seja insuficiente. O próximo trabalho é de modelo, sinais, qualidade, bindings e interação, aproveitando as figuras e a geometria existentes.

Reabrir a solicitação por família somente quando um requisito operacional concreto demonstrar que o símbolo atual, overlays e widgets disponíveis não o representam. Nesse momento definir orientação, estados visuais, dimensões e se uma base em camadas resolve sem variantes separadas. Prioridade só deve ser atribuída após essa evidência.

## Especificação para os SVGs que você enviar

Quando eu confirmar um item da lista como necessário, envie a arte vetorial original em SVG editável, com `viewBox` definido e paths vetoriais. Se houver estados distintos que não possam ser expressos por camadas/overlays, envie variantes claramente nomeadas. Prefira desenho sem texto incorporado (rótulos são localizados no produto), sem bitmap embutido e com elementos separados por estado quando isso ajudar a animação. Inclua uma imagem neutra/base e uma breve legenda indicando tipo, orientação e significado de cada variante.

**Fluxo combinado:** primeiro fechamos o mapeamento símbolo→Core→estado/widget; então eu devolvo a lista final de SVGs realmente necessários para você fornecer em alta qualidade. A lista acima é preliminar e evita trabalho de arte duplicado.
