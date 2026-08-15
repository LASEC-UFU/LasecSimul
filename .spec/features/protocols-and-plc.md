---
id: FEAT-007
kind: feature
status: deferred
dependsOn: [FEAT-001, ARCH-003, ARCH-006]
supersedes: []
---

# Protocolos industriais e PLC

HART, Modbus, PLC e transportes físicos permanecem features específicas. Infraestrutura comum só é extraída após duas implementações demonstrarem duplicação real.

## Contratos

- timeouts e scan cycle usam tempo virtual;
- PLC possui task/scan semantics e IR próprios, não é um Signal Engine renomeado;
- endpoints virtuais não abrem portas do host implicitamente;
- registro/variável de smart instrument possui uma única fonte de estado;
- transporte semântico e camada física podem evoluir separadamente.

## Ordem

1. variável/parameter registry;
2. PLC runtime mínimo;
3. Modbus server/client semântico;
4. integração PLC ↔ Modbus;
5. HART semântico;
6. camadas físicas quando justificadas.

## Aceitação

- determinismo sob aceleração/pausa;
- isolamento de namespace/portas entre sessões;
- golden de scan e timeout;
- nenhum framework universal antecipado.
