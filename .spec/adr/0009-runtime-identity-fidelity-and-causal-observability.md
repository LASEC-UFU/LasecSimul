---
id: ADR-0009
kind: adr
status: accepted
dependsOn: [ADR-0001, ADR-0002, ADR-0003, ADR-0004]
supersedes: []
---

# Fidelidade ao hardware, identidade de execução e observabilidade causal bounded

## Contexto

O LasecSimul executa domínios internos e runtimes externos, incluindo QEMU, GHDL, Python e workers PLC. Em Desktop uma otimização pode parecer barata, mas no perfil SharedHost/thin-client qualquer thread, processo, buffer, wakeup ou polling adicional é multiplicado pelo número de sessões. Ao mesmo tempo, reduzir wall-clock não pode alterar FIFO, IRQ, timers, registradores, bytes, ordenação, ACK/NACK, duração virtual ou oportunidades legítimas de execução que o hardware real apresentaria ao firmware.

Diagnósticos de alta resolução também precisam correlacionar eventos entre processos sem transformar relógio de host em relógio funcional da simulação, sem exigir ABI nova apenas para tracing e sem criar um serviço global de observabilidade.

## Decisão

1. **Hardware real é a referência de correção.** O objetivo de performance é remover trabalho exclusivamente host-side/IPC mantendo o comportamento guest-visible correspondente ao hardware. Quando o modelo atual divergir de hardware, datasheet ou documentação oficial, corrige-se o modelo; não se preserva a divergência apenas por compatibilidade com um backend de referência.
2. **Scheduler continua autoridade única do tempo virtual.** QPC, wall-clock, latência de wake e scheduling do SO são dados diagnósticos e nunca definem diretamente tempo virtual, timers, IRQs, duração de barramento ou timeout de protocolo simulado.
3. **Identidade de execução nasce no cold path.** Cada execução real possui `session_execution_id`; cada runtime lógico possui `runtime_instance_id`; cada tentativa de lançamento de processo externo reserva um `launch_generation` monotônico que não é reutilizado. Sequências locais existentes, como `i2cRequestSeq`, continuam sendo usadas dentro daquela geração.
4. **Pause/resume preserva identidade; stop + novo start cria nova execução.** Relaunch do mesmo runtime preserva `runtime_instance_id` e muda `launch_generation`. Falha de launch pode deixar gap; geração não sofre rollback.
5. **Identidade não exige lookup/string/hash no hot path.** Metadados densos são resolvidos no lifecycle e passados ao processo externo por launch metadata/ambiente/argumento quando necessário. ABI de dispositivo/arena só muda por necessidade funcional, não por tracing.
6. **Identity e provenance são conceitos separados.** Identity responde qual execução/runtime/launch produziu um evento. Provenance registra binários, hashes, firmware/artefato, ABI, protocolo, toolchain e caminhos efetivamente carregados.
7. **Causal trace é diagnóstico opt-in, separado de telemetria.** Core e runtimes externos mantêm buffers/arquivos próprios e fazem merge offline. Raw trace não passa por `ReliableControl`, `LossyTelemetry` ou Webview.
8. **Trace respeita SharedHost.** `OFF` não aloca buffer detalhado, não abre arquivo, não cria thread/wake/sincronização específica; `COUNTERS` mantém apenas contadores bounded; `DETAILED` é lazy, bounded, explicitamente habilitado e invalida análise causal quando há records descartados.
9. **Nenhuma thread/processo por trace, dispositivo ou protocolo.** O recorder executa no contexto já existente. Qualquer flush/worker futuro exige benchmark e orçamento explícito.
10. **Otimização deve ser validada em fidelidade e densidade.** Uma solução não é aceita se reduz latência multiplicando recursos por sessão sem evidência de benchmark favorável no SharedHost.

## Consequências

- `transaction_id` de uma transação local pode ser representado por `{session_execution_id, runtime_instance_id, launch_generation, local_sequence}` sem alterar o protocolo funcional quando `local_sequence` já atravessa request/response.
- Headers de trace carregam invariantes de execução/provenance; records quentes repetem apenas campos necessários à causalidade.
- Backends reference/fast são comparados entre si e contra hardware/datasheet; o reference backend não é oracle absoluto.
- DETAILED pode consumir memória significativa em diagnóstico local, mas não pode aumentar a footprint padrão das sessões SharedHost.
- Qualquer proposta de fast path deve declarar que trabalho host-side foi removido e provar que estados/tempos guest-visible não mudaram, salvo correção comprovada do modelo.
