# Python Programável

O bloco executa código Python interpretado pelo executável selecionado no VS Code. O Core envia um lote de blocos a um worker persistente, fora do solver elétrico; cada fonte é compilada uma vez pelo interpretador e o código Python é executado em cada scan programado pelo tempo simulado.

## Editor e portas

Arraste **Python Programável** da pasta **Controle / Python**. Use o menu de contexto do bloco para **Configurar pinos Python** ou **Editar código Python**. O editor abre um documento Python nativo no VS Code; os botões Validar e Aplicar aparecem na barra do editor. A conclusão por Ctrl+Space lista entradas e saídas, e o hover mostra os metadados disponíveis.

Entradas usam nomes de variáveis de leitura. Atribua diretamente às saídas:

```python
erro = referencia - medicao
state.integral = state.get("integral", 0.0) + erro * sim.dt
saida = max(0.0, min(100.0, 2.0 * erro + 0.1 * state.integral))
```

`sim.time` e `sim.dt` usam segundos; `sim.step` conta as chamadas daquela instância. `state` é isolado por bloco, sobrevive a pausas e reinicia com uma nova simulação. Uma saída não atribuída conserva o último valor; inicialmente usa o valor inicial do pino. Na propriedade **Saídas em caso de erro**, escolha manter as últimas saídas (padrão), usar os valores iniciais ou zerar as saídas. Uma exceção Python desativa apenas aquele bloco até reiniciar a simulação e deixa os outros continuarem; o diagnóstico aparece uma vez no log **LasecSimul: Simulação**. Configure `lasecsimul.python.stepTimeoutMs` entre 10 e 60000 ms. Timeout ou crash do worker compartilhado pausam a sessão porque a resposta do processo deixou de ser confiável.

Os tipos disponíveis são `bool`, `int64` e `real`. Ao criar cada pino, configure valor inicial e descrição; ambos ficam salvos no projeto. O valor inicial é lido enquanto a entrada não estiver conectada e é usado como saída até o código atribuir outro valor. O número de portas é limitado a 64 em cada direção. Nomes devem ser identificadores Python únicos no bloco. Alterar ou remover uma porta reconcilia os pinos e descarta conexões que apontem para uma porta removida.

## Interpretador e bibliotecas

Com `ms-python.python` instalada, o bloco consulta a API pública de ambiente Python e acompanha a troca do interpretador do workspace. Sem ela, configure `lasecsimul.python.executable`; o caminho não é salvo no projeto. Para instalar NumPy, selecione o ambiente desejado no VS Code e execute no terminal integrado:

```powershell
python -m pip install numpy
```

Validar sintaxe usa o executável selecionado e `ast.parse`, sem instalar pacotes. A ausência de bibliotecas só é detectada durante a execução; o traceback aponta o erro. O runtime compartilha um worker por sessão, mantém namespaces e estado separados por instância e não inicia processos por ciclo. Para limitar a criação de pools concorrentes de bibliotecas numéricas, o worker usa uma thread BLAS por padrão; as variáveis de ambiente explicitamente configuradas no VS Code são respeitadas. Python roda com as permissões do usuário e não é sandbox; use bibliotecas e operações externas com consciência de seus efeitos no determinismo.

## Projetos de exemplo

Abra os arquivos `.lsproj` nesta pasta para examinar e executar cada programa. Cada arquivo inclui fonte, portas tipadas, período e conexões com fontes ou modelos de processo; edite os valores ou troque os blocos pelos sensores, fontes, atuadores e modelos do seu esquemático.

- [Intertravamento digital](exemplos/controle_digital.lsproj)
- [Controle proporcional](exemplos/controle_proporcional.lsproj)
- [PID com memória](exemplos/controle_pid.lsproj)
- [Controle de nível de tanque com acumulador em malha fechada](exemplos/controle_tanque.lsproj)
- [Operação com NumPy](exemplos/numpy.lsproj)

O exemplo NumPy requer que `numpy` esteja instalado no ambiente ativo.

## Limitações e timing

O período está em nanossegundos e pertence ao relógio do scheduler, não ao relógio de parede. A resolução real depende do passo configurado e dos eventos do simulador. O código roda nas fronteiras do scheduler e nunca dentro das iterações do MNA; suas saídas alimentam a próxima avaliação do Signal Engine. A comunicação IPC de cada scan é síncrona com o scheduler: o timeout interrompe um bloco lento, mas bibliotecas com threads ou efeitos externos podem variar entre execuções. O editor faz validação sintática antes da execução, e validações de valor/tipo são aplicadas no worker a cada ciclo.

## Verificação

`python_program_block_test` cobre tipos, portas e identificadores. `python_program_execution_test` cobre variáveis diretas, estado, tempo simulado, sintaxe e isolamento de exceção entre blocos. `python_program_numpy_test` executa `numpy.clip` no interpretador indicado por `LASECSIMUL_TEST_NUMPY_EXECUTABLE`; sem esse override, ignora o teste se o interpretador padrão não tiver NumPy. `python_program_session_integration_test` liga o scheduler ao Signal Engine usando um worker Python real, confere blocos encadeados, o tanque em malha fechada, telemetria de saídas, saída inicial antes do primeiro scan, reset do estado em Stop/Run, continuidade após exceção, série do Laboratório de Cálculo e a cadeia elétrica sensor de tensão → Python → saída digital com carga de 1 kΩ. `python_runtime_test` e `python_session_test` cobrem timeout, restart e recuperação. Os projetos de exemplo têm teste de carga e ciclo save/load em `PythonProgramProject.test.ts`.

Os alvos `python_program_benchmark` e `python_program_session_benchmark` medem o protocolo do worker e a sessão real. A primeira rodada neste Windows está documentada em [benchmark-windows-2026-10-21.md](benchmark-windows-2026-10-21.md); repita a medição para outras plataformas, interpretadores e cargas.
