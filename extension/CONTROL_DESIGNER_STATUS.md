# Projeto de Controladores: estado da implementação

Atualizado em 2026-10-18. Este registro descreve o que foi implementado, validado e o que ainda depende de trabalho externo ou de recursos não existentes no simulador.

## Implementado

- Projeto LTI com arquitetura F, C, G e H, requisitos, alternativas, vínculos com blocos e persistência em `.lsproj`.
- Modelos em função de transferência, polos/zeros e espaço de estados, tanto contínuos quanto discretos. Dinâmicas discretas exigem Ts finito e positivo; ganhos estáticos não impõem Ts.
- Coeficientes em potências decrescentes de s ou z, conversão explícita para z⁻¹ que preserva atrasos, termos diretos e posições dos coeficientes.
- Interconexões e realimentação negativa calculadas com compatibilidade explícita de domínio e Ts. Importação de redes selecionadas resolve ramos paralelos e realimentação; redes ambíguas, singulares ou incompatíveis são recusadas.
- Lugar das raízes no plano z com círculo unitário, polos e zeros de malha aberta, polos atuais, ganho selecionável, associação de ramos e refinamento adaptativo por curvatura/deslocamento.
- Estabilidade discreta por módulo dos polos, com tolerância para fronteira e classes estável, instável, marginal e próxima da fronteira.
- Bode avaliado em z=e^(jωTs), banda até Nyquist, unidades rad/s, Hz e rad/amostra, fase desenrolada e refinamento dos cruzamentos usados nas margens. Nichols, Nyquist, S e T usam a mesma resposta discreta.
- Resposta discreta por recorrência e em instantes kTs, incluindo degrau, impulso unitário de sequência, rampa e sequência de entrada arbitrária. A escolha de caminho permite avaliar perturbação de planta/medição e U/R; a sequência personalizada exibe sua magnitude de pico. Degrau exibe subida 10–90%, pico e acomodação com resolução Ts explícita.
- Polos discretos podem ser interpretados pelo ramo principal de s=log(z)/Ts; a interface informa o espaçamento dos ramos e trata z=0 sem valor logarítmico finito.
- Presets P, PI, PD filtrado, PID filtrado e compensadores podem ser convertidos explicitamente com Tustin ou ZOH. Conversões de domínio e de Ts pedem confirmação; mudar Ts sem reamostrar não é aceito silenciosamente.
- Requisitos incluem sobressinal, acomodação, margem de fase, módulo máximo dos polos discretos e pico do esforço U/R, calculados no caminho de resposta selecionado.
- O bloco `control.transfer_function` executa C(z) com coeficientes normalizados e Ts em nanossegundos. O runtime agenda a atualização pela taxa do relógio de simulação; não usa temporizador de interface. A aplicação sincroniza o circuito e passa pelo histórico undo/redo.
- Aplicação de ganhos estáticos em `control.gain`; análise e persistência guardam método de discretização, unidade de frequência, convenção de coeficientes, requisitos, vínculos e enquadramentos dos gráficos.

## Verificações concluídas nesta rodada

- `npm run compile` passou.
- `npm run test:control-designer` passou: 32 casos LTI, 11 casos de integração com blocos/redes e round-trip do serializer.
- `npm run test:e2e` passou após a correção do runner para abrir o workspace de extensão: painel, gráficos, acessibilidade/foco, importação, cálculo discreto por sequência de amostras, aplicação contínua e Ctrl+Z/Ctrl+Y.
- Testes Release `signal_dynamics` e `process_subcircuit` passaram, incluindo recorrência e agendamento do bloco discreto no Core.
- `ctest --test-dir core/build -C Release --output-on-failure` executou 114 testes: 113 foram reportados como aprovados e `hart_ld301` falhou em 18 verificações de protocolo/calibração não relacionadas ao controle discreto; cinco testes condicionais foram ignorados. `signal_dynamics` e `process_subcircuit` passaram novamente após a última recompilação Release.
- `npm test` percorreu os testes gerais até `LasecPlot manifest` e falhou no caso “ação externa ainda usa nome de registro”; os casos anteriores passaram. A falha pertence a outra área do repositório.
- Casos analíticos cobrem o degrau de primeira ordem, ZOH de 1/(s+1), fronteira de estabilidade em K=19, atraso z⁻² e conversão z/z⁻¹.

## Limitações confirmadas

- A busca no projeto não encontrou módulo, formato de exportação ou API chamado Ident. Não há integração específica implementável sem a interface/esquema do Ident; a importação por coeficientes, polos/zeros, espaço de estados e blocos do circuito está disponível.
- O simulador executa transferência discreta na grade Ts e integra seu escalonamento ao relógio de simulação. Ainda não há modelo híbrido completo que simule a planta contínua entre amostras com amostrador e retentor explícitos; o Control Designer também não mistura dinâmicas contínuas e discretas na análise LTI.
- A aplicação do controlador discreto é suportada em `control.transfer_function`; o bloco não oferece campos para estado inicial configurável. Condições iniciais do controlador não são transferidas.
- As respostas incluem degrau, impulso unitário de sequência, rampa, entrada amostrada e resposta natural a x₀ da planta em malha fechada. A resposta natural exige C e H estáticos; condições iniciais de estados dinâmicos em C/H e campos de estado inicial no bloco de circuito ainda não são transferidos.
- Presets digitais suportam Tustin, ZOH, Euler para frente e Euler para trás. A derivada filtrada sobre a medição é configurável no SisoTools e usa caminhos separados na análise; não é convertida para um bloco PID dedicado no circuito.
- O lugar adaptativo refina curvatura e deslocamento, mas usa limites de profundidade/pontos; não constitui uma prova de que todo detalhe arbitrariamente estreito foi resolvido.
- Bode enumera candidatos a extremos de magnitude resolvendo a equação estacionária algébrica para modelos contínuos e discretos, além da grade de apresentação. Os candidatos dependem do solucionador numérico de polinômios; polos próximos do eixo/unidade e raízes mal condicionadas continuam sujeitos ao diagnóstico por resíduo.
- Nyquist calcula encirclements assinados pelo princípio do argumento a partir das raízes dos polinômios abertos e fechados, sem inferir a contagem da grade do gráfico. Retorna indefinido se raízes ficarem próximas da fronteira de estabilidade ou apresentarem resíduo excessivo.
- O lugar das raízes refina por erro de corda e deslocamento, com até 8.192 pontos. Expõe se atingiu os limites numéricos configurados e o maior resíduo das raízes; isso detecta falhas observadas, mas não prova ausência de um ramo arbitrariamente estreito entre ganhos.

## Continuidade

Não foi feito commit ou push. As limitações acima são pontos concretos restantes para fechar todo o escopo do pedido; a integração Ident e a simulação híbrida dependem de interfaces/capacidades que não existem hoje no repositório.

## Atualização: x₀, derivada na medição e aquisição do analisador lógico

- A realização A/B/C/D da planta agora inclui editor persistente para x₀. Campo vazio significa vetor nulo; vetor informado exige exatamente n valores finitos. A resposta natural em malha fechada simula diretamente A/B/C/D e mantém modos internos. Nesta versão, a resposta de condição inicial cobre C e H estáticos; se C ou H forem dinâmicos, a interface informa que os estados iniciais desses blocos ainda não podem ser editados. Interconexões algébricas singulares são recusadas.
- O preset de compensador oferece derivada filtrada sobre a medição. O ramo de referência contém P/PI; o ramo de medição contém a derivada filtrada. A opção e os modelos dos dois ramos são persistidos e participam das análises em malha fechada.
- A contagem de Nyquist usa o princípio do argumento e checagem de resíduo em vez de refinamento da curva amostrada. Bode inclui os candidatos algébricos a extremos de ganho. O lugar das raízes informa a convergência dos refinamentos e o resíduo numérico.
- O analisador lógico deriva rótulos e largura de barramentos da configuração salva antes da primeira amostra. O E2E agora aguarda separadamente a visibilidade de DATA[7] e a chegada de amostras antes de testar o trigger.
- A bateria `npm run test:control-designer` passou: 34 casos LTI e 11 casos de integração. O E2E completo ainda encontra falhas independentes anteriores à asserção de DATA[7] (comparação visual do osciloscópio); após a mudança da condição inicial vazia, a verificação de DATA[7] é ultrapassada.

## Atualização: nome e plantas em espaço de estados SISO

- A ferramenta aparece como **SisoTools** na paleta, no Command Palette e no título da interface, em português e inglês.
- A seção "Planta em espaço de estados (SISO)" aceita A quadrada, B e C vetores de dimensão n, D escalar e coeficientes reais finitos; no domínio discreto, Ts deve ser positivo.
- A realização original A/B/C/D permanece no `ControlDesignProject` e sobrevive ao salvar/reabrir `.lsproj`. A função equivalente usada nas análises mantém o polinômio característico completo: polos de modos não controláveis ou não observáveis continuam presentes na avaliação de estabilidade interna.
- Lugar das raízes, Bode, respostas, polos, margens, estabilidade e comparação de compensadores usam a planta equivalente. A aplicação do compensador ao circuito permanece integrada ao bloco de função de transferência/gain selecionado.
- A conversão interna limita as potências da recorrência escalando A e recusa coeficientes que excedam a faixa numérica representável. Modelos com mais de 24 estados continuam recusados.
- Para mudar domínio ou Ts com uma realização ativa, remova-a ou reconfigure-a explicitamente; o editor não reinterpreta A como outra dinâmica. Pode-se escolher contínuo ou discreto antes de inserir as matrizes.
- Plantas A/B/C/D ficam preservadas no projeto SisoTools e podem ser importadas de `control.state_space` ou aplicadas a esse bloco no circuito. O Core executa as matrizes originais: integração contínua adaptável por passo de ponto médio/RK4 e recorrência discreta em Ts, com validação dimensional e valores finitos.
- Requisitos de amortecimento mínimo e taxa mínima de decaimento são avaliados nos polos fechados. Para polos discretos, usa-se o ramo principal `s=log(z)/Ts`; polos em `z=0` têm taxa de decaimento infinita e razão de amortecimento não definida.

Verificação desta atualização: `npm run compile`, `npm run test:control-designer` (32 casos LTI, 11 de integração e round-trip do serializer). O E2E também cobre a entrada matricial discreta e a conservação de um polo instável oculto.

## Continuidade SisoTools — 2026-10-18

- Adicionado `control.state_space` à paleta com A/B/C/D, domínio contínuo/discreto e Ts explícito. O Core executa a realização original; estados não controláveis ou não observáveis não são removidos.
- O SisoTools importa esse bloco mantendo a realização nas propriedades do projeto e pode aplicar a planta editada a um bloco `control.state_space` no esquemático, pela mesma atualização reversível do circuito. Respostas às análises seguem usando a conversão interna de polinômio característico completo.
- Euler para frente/trás, requisitos de amortecimento/decaimento e contagem aproximada de encirclements de Nyquist foram implementados.
- O editor de x₀ e a derivada configurável sobre a medição foram adicionados; as condições iniciais permanecem limitadas a planta com C/H estáticos. Os gráficos Bode e lugar das raízes são representações finitas e não oferecem certificado formal de cobertura entre pixels/pontos. Nyquist é calculado pelo princípio do argumento com raízes numéricas e não é uma prova intervalar certificada.
- Validação: compilação TypeScript e testes do Control Designer passaram (32 LTI, 11 integração e round-trip). CTest focado passou (signal_dynamics, process_subcircuit); build Release de lasecsimul-core passou. Duas execuções do E2E geral falharam no fluxo independente de instrumentos, aguardando DATA[7] no instrumento logic; os passos SisoTools ocorreram antes dessa falha.

## Atualização: limites numéricos das curvas e Nyquist

- O Bode inclui candidatos a extremos obtidos da equação estacionária algébrica da magnitude. A localização desses candidatos ainda depende de raízes em ponto flutuante; portanto, isto melhora a detecção de picos, mas não certifica que todas as raízes reais foram encontradas.
- Nyquist calcula o número assinado pelo princípio do argumento usando raízes numéricas dos polinômios aberto e característico. O sinal é ajustado à orientação do contorno contínuo ou discreto. Resíduo alto ou raiz próxima à fronteira torna a resposta indefinida. Como o isolamento das raízes não é intervalar, a contagem não é uma prova formal.
- Lugar das raízes refina com tolerâncias de curvatura e deslocamento e informa resíduo e esgotamento dos limites. Atingir as tolerâncias não prova que não exista um ramo estreito entre amostras.
- A interface agora apresenta essas condições como tolerâncias numéricas e explicita que a curva do lugar das raízes não tem certificado formal de cobertura. A limitação de certificação permanece aberta: removê-la requer isolamento/certificação de raízes com aritmética intervalar ou exata e subdivisão certificada, não apenas mais amostras.
- Validação desta rodada: `npm run test:control-designer` passou (34 testes LTI e 11 de integração); `npm run compile` passou.
