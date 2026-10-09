# Tanque pressurizado com LD301 (nível por pressão diferencial)

Subcircuito `subcircuits.process.pressurized_tank_dp`
(`subcircuits/process_pressurized_tank_dp.lssubcircuit`, gerado por
`scripts/generate-pressurized-tank.py`). Fica na paleta em *Processo › Modelos*.

É um tanque fechado e pressurizado com:

- válvula de entrada e válvula de saída, cada uma comandada por um pino de
  abertura (0–100 %, ligue um slider);
- as duas tomadas de um transmissor de pressão diferencial (LD301), instalado
  abaixo do tanque.

## Instalação simulada

```
          gás (Pgás)
   ┌────────────┐ ── tomada de cima ──[selo]── perna molhada (SGselo) ──┐
   │            │                                                        │ H + Lcap
   │  líquido   │ H                                                      │
   │  (SGp)     │                                                        │
   └────────────┘ ── tomada de baixo ──[selo]── capilar (SGcap) ──┐ Lcap │
                                                                  HIGH  LOW  → LD301
```

- **HIGH (alta):** tomada no nível mínimo, mais um capilar que desce **Lcap**
  até o transmissor, cheio de um fluido de densidade relativa **SGcap**.
- **LOW (baixa):** perna molhada do topo do tanque até o transmissor
  (altura **H + Lcap**), sempre cheia de selo de densidade relativa **SGselo**.
- A pressão do gás age nas duas pernas e se cancela no ΔP. Ela só aumenta a
  vazão de saída.

## Equações

As saídas HIGH e LOW estão em mmH2O, a unidade do LD301. Pgás está em kPa.

| Grandeza | Equação |
|---|---|
| HIGH | `1000·(SGp·h + SGcap·Lcap) + 101,972·Pgás` |
| LOW | `1000·SGselo·(H + Lcap) + 101,972·Pgás` |
| ΔP lido pelo LD301 | `HIGH − LOW = 1000·(SGp·h + SGcap·Lcap − SGselo·(H + Lcap))` |
| Vazão de entrada | `Qin_max · u_in/100`, zerada com o tanque cheio |
| Vazão de saída | `Qout_max · u_out/100 · √((SGp·h + Pgás_m)/(SGp·H + Pgás_m))`, com rampa nos últimos 2 cm |
| Nível | `dh/dt = (Qin − Qout) / (π·D²/4)`, entre 0 e H |

**Faixa do LD301 (zero elevado pela perna molhada).** Com os valores padrão
(H 3 m, todas as densidades 1, Lcap 0,2 m):

- tanque vazio: ΔP = 200 − 3200 = **−3000 mmH2O** (LRV, 4 mA);
- tanque cheio: ΔP = **0 mmH2O** (URV, 20 mA).

Com outras densidades, use:

- LRV = `1000·(SGcap·Lcap − SGselo·(H + Lcap))`
- URV = LRV + `1000·SGp·H`

Ajuste a faixa pelo PACTware (Comando 35) ou pela propriedade exportada do
LD301 da instância.

## Parâmetros

Os parâmetros são blocos **Constante** (`control.constant`) exportados. Eles
aparecem no painel **Propriedades** da instância, em "Propriedades
exportadas", e **mudam com a simulação rodando**, sem recompilar o plano:

| Parâmetro | Padrão |
|---|---|
| Altura do tanque (tomada de baixo até a de cima) | 3 m |
| Diâmetro do tanque | 1 m |
| Densidade relativa do líquido de processo | 1,0 |
| Densidade relativa do selo da perna molhada (LOW, topo) | 1,0 |
| Densidade relativa do fluido do capilar de alta (HIGH) | 1,0 |
| Capilar de alta abaixo do nível mínimo | 0,2 m |
| Pressão do gás no topo (manométrica) | 50 kPa |
| Vazão máxima de entrada (válvula 100 %) | 36 m³/h |
| Vazão máxima de saída (válvula 100 %, tanque cheio) | 36 m³/h |

O nível começa em 1,5 m.

**Saídas:** HIGH, LOW, Nível (m) e Nível (%).

## Planta incorporada ao projeto

Os projetos `trm/ld301/tanque_pressurizado_ld301.lsproj` e
`trm/ld301/teste_ld301.lsproj` levam a planta **dentro do `.lsproj`**: o
componente tem `subcircuitRef.embedded` com o manifesto inteiro e um `typeId`
próprio (`subcircuits.local.pressurized_tank_dp`). Abrir o projeto não depende
da biblioteca instalada nem de arquivo ao lado.

Ao abrir:

1. o manifesto é gravado num cache por conteúdo (`%TEMP%/lasecsimul-embedded-subcircuits`);
2. ele é registrado no Core como um subcircuito por arquivo;
3. ganha leitura ao vivo dos gráficos internos e as propriedades exportadas,
   como um item da biblioteca.

Ao salvar, o conteúdo do cache volta para o projeto, inclusive as edições
feitas em "Abrir Subcircuito".

## Propriedades exportadas por instância

Editar uma propriedade exportada de um subcircuito (LD301, TT301, tanque...)
grava **na instância**, com a chave `@<componente interno>.<propriedade>`, e
nunca no arquivo `.lssubcircuit` do modelo. Assim:

- dois LD301 no mesmo projeto podem ter faixa, tag e endereço diferentes;
- a edição entra no desfazer/refazer e é salva no `.lsproj`;
- ao abrir o projeto, cada valor é aplicado ao Core com
  `setSubcircuitChildProperty`.

O MCU interno de uma placa (firmware/QEMU) continua pelo caminho próprio.

O FY301 ainda é um dispositivo built-in: as propriedades dele já são da
instância.

## Peças novas usadas pelo modelo

- **Constante** (`control.constant`, Core `SignalConstant.hpp`): saída de sinal
  com valor e unidade. Entra no grafo como o slider de operador. Está na aba
  Controle da paleta.
- **Tanque vetorial** (`graphics.tank_svg`): o líquido sobe recortado na
  janela da arte `tank.svg`. Tem nível fixo ou ligado (Binding) e cor do
  líquido configurável.
- **Válvula globo vetorial** (`graphics.valve_globe_svg`): mostra a abertura
  num selo quando "Mostrar abertura" está ligado.
- **Primitiva `clip`** no IR de pintura: recorta primitivas por um contorno.
- **Texto com `maxWidth`**: a fonte encolhe para o valor caber na caixa. Vale
  para o Display numérico e o Display de valor.

## Testes

| Teste | O que prova |
|---|---|
| `control_block_subcircuit` (6) | HIGH/LOW, nível inicial, constante mudando com a simulação rodando sem recompilar o plano |
| `extension/src/process/pressurizedTank.realCore.test.ts` | Core real com LD301: PV −1500 mmH2O, 12 mA na faixa −3000…0, subida de 12,7 mm/s, vazão de saída, selo/gás/altura/capilar ao vivo |
| `graphicsLibrary.test.ts` | líquido 0/50/100 % recortado, cor configurável, abertura da válvula, display com fonte ajustada |
| `childPropertyOverrides.test.ts` | chaves por instância, valor efetivo modelo + instância |
