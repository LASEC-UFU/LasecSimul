---
id: ARCH-003
kind: architecture
status: active
dependsOn: [ARCH-002, ADR-0009]
supersedes: []
---

# Scheduler e tempo virtual

## Autoridade

O Scheduler/coordenador é a única autoridade do tempo virtual e da ordem observável. Runtimes externos avançam somente por comando do Core. A PLC VM é interna ao Core e recebe `timestampNs`/delta virtual explicitamente; nunca lê wall clock. QPC, wall-clock, wake latency e scheduling do SO podem ser registrados para diagnóstico/benchmark, mas não alteram `timestampNs`, timers, IRQs, duração de barramento ou timeout simulado.

## Chave de evento

```cpp
EventKey { timestampNs, microstep, phase, sequence }
```

Ordem lexicográfica fixa. `sequence` preserva desempate determinístico.

Fases mínimas:

1. `ExternalInput`;
2. `PlcInputLatch`;
3. `PlcTaskEvaluate`;
4. `PlcOutputCommit`;
5. `DiscreteEvaluate`;
6. `ElectricalSettle`;
7. `Commit`;
8. `Observe`.

Propagação zero-delay agenda `microstep + 1`. Um limite configurável detecta loop algébrico/oscilações e gera diagnóstico, nunca loop infinito.

## Semântica de scan PLC

Para todas as instâncias PLC com task vencendo no mesmo instante:

1. **todas** fazem latch das entradas;
2. executam tasks em ordem determinística de `(priority, taskId, instanceIndex)`;
3. **somente depois** as saídas PLC daquele instante são publicadas;
4. observers/debug veem estado commitado.

Assim, um PLC não lê acidentalmente a saída recém-calculada de outro apenas por estar depois dele no array do plano.

Uma task IEC cíclica é compilada em RateGroup quando seu período/offset/phase coincide com outras tasks. Tasks event-driven são adicionadas apenas com semântica e limite explícitos.

Timers IEC, SFC e qualquer função dependente de tempo usam tempo virtual. `TON(PT:=T#1s)` deve completar após 1 s virtual tanto em execução acelerada quanto em step/headless.

## RateGroups

Blocos/tasks com o mesmo `(periodNs, offsetNs, phase)` compartilham um evento periódico e são avaliados em ordem de índice do plano. O grupo agenda uma única próxima ativação.

Períodos inteiros em nanossegundos são o contrato inicial. Representação racional, timing wheel e calendar queue ficam adiados até benchmark/caso de uso concreto.

## Passos contínuos

O integrador pode escolher passos menores que o próximo evento, respeitando limites e rollback. Eventos externos e GHDL só observam tempos aceitos; tempo nunca retrocede para um runtime que não suporte rollback.

Um PLC já executado em um timestamp aceito não sofre rollback parcial. O integrador precisa fechar/aceitar o estado contínuo necessário antes da fase `PlcInputLatch` daquele evento.

## Pacing e fidelidade temporal

- Modo real-time compara avanço virtual/host sem usar wall-clock como fonte semântica.
- A média próxima de 100% não basta: stalls e catch-up bursts devem ser observáveis em benchmark quando relevantes.
- Espera host-side só pode ser removida depois de classificada como overhead artificial; pacing que representa restrição física/virtual correta permanece.
- Metas de wall-clock não autorizam acelerar uma operação além do hardware real.

## Alocação

- reutilizar buffers de lotes e scratch;
- imagens de I/O PLC e memória da VM são pré-alocadas ao publicar o plano;
- reduzir eventos primeiro com RateGroups;
- manter a `priority_queue` até profiler provar gargalo;
- evitar `future`/promise por evento ou por PLC scan.

## Aceitação

- ordem reproduzível em eventos de mesmo instante;
- todos os PLCs de um instante fazem input latch antes de output commit;
- timers IEC e SFC são independentes de wall clock;
- pausa/stop responsivos inclusive em não convergência;
- loop de microsteps limitado e diagnosticado;
- RateGroup gera um evento por período, não por bloco/task individual;
- nenhum uso funcional de wall clock;
- instrumentation/QPC não altera ordem, `EventKey`, timer ou IRQ;
- otimização de pacing preserva duração e oportunidades guest-visible comprovadas contra hardware/modelo.
