# Medições Python Programável — Windows

Medições feitas em 2026-10-21 neste workspace, sem pacotes adicionais:

- Windows Server 2025 Standard Evaluation, x64 (10.0.26100)
- AMD Ryzen 9 5950X, 16 cores
- Python 3.12.5 em `C:\Program Files\Python312\python.exe`
- Build Release MSVC; worker Python com aquecimento realizado antes da janela de medição

## Protocolo real do worker

Três execuções de `python_program_benchmark.exe`; tabela abaixo contém a mediana entre elas. `wall_ms/batch` mede o round-trip síncrono e inclui a carga JSON do lote, mas exclui criação do worker, inicialização e compilação inicial do código. CPU e memória privada são do processo Python, não do Core. A granularidade de CPU do Windows é de 15,625 ms, então diferenças pequenas não devem ser interpretadas como precisas.

| Blocos | Entradas/bloco | Ciclos | ms/lote | CPU worker na janela (ms) | Memória privada (MB) | passos de bloco/s |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 1.000 | 1,829 | 93,750 | 13,910 | 546,7 |
| 10 | 1 | 1.000 | 1,778 | 203,125 | 14,055 | 5.623,7 |
| 100 | 1 | 500 | 3,054 | 625,000 | 13,895 | 32.744,5 |
| 1 | 4 | 1.000 | 1,818 | 46,875 | 14,070 | 550,2 |
| 1 | 16 | 1.000 | 1,810 | 93,750 | 14,133 | 552,6 |

O custo por lote domina o caso de um único bloco; agrupar até 100 blocos aumenta a vazão, com maior custo por lote e cerca de 14 MB de memória privada do worker nestes casos. Em 1 ms, o round-trip medido é maior que o período quando executado um único bloco, portanto uma sessão apertada pode avançar o tempo simulado mais lentamente que o tempo de parede.

## Scheduler e Signal Engine

`python_program_session_benchmark.exe` cria componentes Python reais dentro de `SimulationSession`, roda o scheduler por dois segundos de parede e mede tempo simulado/execuções. Esta nova rodada foi feita uma vez, após incluir o canal de diagnóstico, e não é estatística; os valores variaram em relação à rodada inicial, então servem para revelar efeito de carga, não para comparar pequenas diferenças. `worker_cpu_ms` e `worker_private_mb` medem apenas o worker Python.

| Blocos | Período | Entradas/bloco | Parede (s) | Simulado (s) | Chamadas de bloco | CPU worker (ms) | Memória privada (MB) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 ms | 1 | 2,001 | 1,297 | 1.297 | 93,750 | 13,969 |
| 10 | 1 ms | 1 | 2,001 | 1,081 | 10.810 | 296,875 | 13,879 |
| 100 | 1 ms | 1 | 2,000 | 0,325 | 32.400 | 687,500 | 13,957 |
| 1 | 10 ms | 1 | 2,000 | 10,580 | 1.058 | 140,625 | 13,922 |
| 10 | 10 ms | 1 | 2,001 | 9,410 | 9.410 | 265,625 | 14,117 |
| 100 | 10 ms | 1 | 2,000 | 3,500 | 35.000 | 718,750 | 13,988 |
| 1 | 100 ms | 1 | 2,001 | 51,699 | 517 | 62,500 | 13,988 |
| 10 | 100 ms | 1 | 2,001 | 47,364 | 4.730 | 125,000 | 14,086 |
| 100 | 100 ms | 1 | 2,000 | 19,464 | 19.400 | 343,750 | 14,074 |
| 1 | 10 ms | 4 | 2,000 | 10,450 | 1.045 | 156,250 | 14,023 |
| 1 | 10 ms | 16 | 2,001 | 10,220 | 1.022 | 140,625 | 13,859 |

O scheduler não força sincronismo com o relógio de parede e avança o tempo simulado conforme o trabalho disponível. Com 100 blocos a cada 1 ms, o modelo avançou 0,325 s em 2 s de parede, evidenciando saturação dessa configuração; com 100 ms, avançou 19,464 s na mesma janela. As fontes de entrada deste benchmark não têm fios ligados; os blocos continuam executando no scheduler e atravessam o Signal Engine. As medidas não cobrem o custo de modelos elétricos grandes, HMI/plots, NumPy ou outros pacotes.

Para repetir: compile os alvos `python_program_benchmark` e `python_program_session_benchmark` em Release e execute-os em uma máquina ociosa. Compare resultados somente em condições e builds semelhantes.
