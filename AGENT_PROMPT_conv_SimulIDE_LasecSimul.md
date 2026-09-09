# PROMPT PARA AGENTE — integrar o conversor SimulIDE → LasecSimul v4

Você está trabalhando no repositório **LASEC-UFU/LasecSimul**. Integre a versão v4 do importador SimulIDE fornecida neste pacote.

Repositórios de referência:

- LasecSimul: `https://github.com/LASEC-UFU/LasecSimul`
- fork SimulIDE usado como referência de formato/comportamento: `https://github.com/josuemoraisgh/SimulIDE-dev`

Antes de editar, inspecione o checkout atual e adapte os patches por símbolos/contexto. O repositório pode ter evoluído desde a criação deste pacote.

---

## 1. Objetivo funcional

O LasecSimul deve abrir arquivos SimulIDE `.sim1` e `.sim2` e convertê-los automaticamente para **`.lsproj`**.

Fluxo obrigatório:

```text
arquivo.sim1/.sim2
    ↓
SimulideParser
    ↓
SimulideCircuitDocument (IR)
    ↓
SimulideToLasecConverter
    ↓
ProjectDocument
    ↓
ProjectSerializer.save("arquivo.lsproj")
    ↓
openProjectFile("arquivo.lsproj")
```

A extensão oficial permanece **`.lsproj`**. Nunca introduza `.lsproject`.

O `.sim1/.sim2` original deve permanecer intacto. Depois da importação, `Ctrl+S` deve salvar o `.lsproj`, nunca o SimulIDE original.

---

## 2. Regra arquitetural central da v4: BEST EFFORT

**Componente não suportado NÃO pode bloquear a conversão inteira.**

A política é:

```text
componente suportado
    → converter com máxima fidelidade

componente conhecido mas com incompatibilidade estrutural
    → preservar como placeholder + warning

componente sem equivalente no LasecSimul
    → preservar como placeholder + warning

propriedade sem equivalente
    → preservar raw + warning

pin desconhecido
    → nunca descartar o fio; preservar via placeholder

endpoint realmente impossível de associar
    → preservar o fio em nó órfão sintético + warning

arquivo ilegível/corrompido ou falha de gravação
    → erro fatal
```

Não use mais a regra antiga “unknown component/pin = abortar `.lsproj`”.

### Exemplo obrigatório: Arduino Uno

O fixture `NTC_ApInst.sim1` contém um Arduino Uno que o Core atual não simula.

O correto é:

```text
Arduino Uno-63
  ↓
import.simulide.unresolved
  ↓
preservar posição
pinos A5 / 1 / 0
firmware.hex
Frequency=16 MHz
mainCompProps
atributos brutos
fios
  ↓
gerar NTC_ApInst.lsproj normalmente
```

NUNCA converter Arduino Uno para ESP32 apenas porque existe ESP32 no destino.

---

## 3. Placeholder canônico

Use o typeId:

```ts
import.simulide.unresolved
```

O importador deste pacote já grava:

```text
__ui_simulideUnsupported
__ui_simulideSourceType
__ui_simulideSourceId
__ui_simulideSourcePath
__ui_simulidePinIds
__ui_simulideRawAttributes
__ui_simulideMainCompProps
__ui_simulideProgram
__ui_simulideResolvedProgramPath
__ui_simulideSuggestedTypeId
__ui_simulideSuggestedProperties
__ui_simulidePlaceholderWidth
__ui_simulidePlaceholderHeight
```

Aplique `patches/0004-best-effort-placeholders-and-settings.patch` para:

- renderizar o placeholder na Webview;
- reconstruir seus pins a partir de `__ui_simulidePinIds`;
- nunca enviá-lo ao Core;
- manter seleção/movimentação/fios normais;
- alertar que a simulação pode ser parcial.

---

## 4. Parsing SimulIDE

Baseie-se no código real do SimulIDE:

- `Circuit::loadCircuit()` / `loadStrDoc()`;
- `<circuit ...>`;
- `<item itemtype="..." ... />`;
- `<item itemtype="Subcircuit" ...><mainCompProps .../></item>`;
- `Connector` com `startpinid`, `endpinid`, `pointList`, `uid`;
- `Node` com `CircId`;
- componentes com `CircId`.

`.sim1` e `.sim2` usam o mesmo parser geral.

O parser deve aceitar entidades numéricas usadas pelo `TextComponent`, inclusive sem `;` em arquivos antigos:

```text
&#xa;
&#x22;
&#x3D;
```

---

## 5. IDs de componentes e endpoints

Nunca faça `split('-')[0]`.

IDs reais contêm hífens. Resolva owner pelo **maior prefixo conhecido**.

Aceite também componentes que concatenam pin sem hífen, exemplo real:

```text
Aip31068_i2c-13PinSDA
Aip31068_i2c-13PinSCL
```

---

## 6. Nodes e Connector geometry

`Node-X-0`, `Node-X-1`, `Node-X-2` devem virar o mesmo endpoint:

```ts
{ kind: "node", nodeId: "Node-X" }
```

Não converta Node em componente.

No SimulIDE, `pointList` contém extremidades. No LasecSimul, `vertices` contém apenas pontos intermediários:

```ts
vertices = points.length >= 2 ? points.slice(1, -1) : [];
```

### `uid` duplicado

O fixture `NTC_ApInst.sim1` possui `Connector-302` e `Connector-303` repetidos.

Nunca deixar ids duplicados em `ProjectTopology`.

Renomear determinísticamente:

```text
Connector-302
Connector-302.imported-2
```

com warning, sem perder fio.

---

## 7. Mapeamento de componentes

Prioridade:

1. `package.simulidePaint.source.className` do catálogo atual;
2. fallback declarativo em `SimulideComponentMapper.ts`;
3. typeId/label exato normalizado.

Não espalhe regras no `projectCommands.ts`.

Mapeamentos especiais já incluídos:

```text
Resistor
Potentiometer
Capacitor
Inductor
Diode/Zener
OpAmp
LEDs
AIP31068
PCD8544
SerialTerm/SerialPort
Ground/Rail/FixedVolt/WaveGen
Oscope/LAnalizer
Thermistor
Text/Rectangle/Ellipse/Line/Image
ESP32 DevKitC reconhecido
```

---

## 8. Aliases de pins confirmados em arquivos reais

Obrigatórios:

```text
Resistor lPin -> pin-1
Resistor rPin -> pin-2

Ground Gnd -> pin

Fixed Voltage outnod -> out
Rail outnod -> pin-1
WaveGen outnod -> pin-1

SerialTerm pin0 -> tx
SerialTerm pin1 -> rx
SerialPort pin0 -> tx
SerialPort pin1 -> rx

Aip31068_i2c PinSDA -> sda
Aip31068_i2c PinSCL -> scl

Pcd8544 PinRst -> rst
Pcd8544 PinCs  -> ce
Pcd8544 PinDc  -> dc
Pcd8544 PinSi  -> din
Pcd8544 PinScl -> clk

Thermistor lPin -> a
Thermistor rPin -> b
```

Se um componente conhecido tiver um pin conectado que ainda não pode ser resolvido, **não descarte o conductor**. A v4 rebaixa apenas aquele componente a placeholder, preservando `__ui_simulideSuggestedTypeId` e as propriedades já mapeadas.

---

## 9. Unidades

`parseEngineeringNumber()` deve aceitar:

```text
p n u µ μ m k M G T
Ω / Ω
% 
°C
ºC
```

Exemplos:

```text
1 kΩ      -> 1000
10 uF     -> 1e-5
152.4 ºC  -> 152.4
16 MHz    -> 16000000
```

---

## 10. Thermistor — obrigatório

Fixture real: `extension/test/fixtures/simulide/real-user/NTC_ApInst.sim1`.

Mapeamento:

```text
Thermistor -> sensors.thermistor
Temp       -> temp
Min_Temp   -> min_temp
Max_Temp   -> max_temp
Dial_Step  -> dialStep
B          -> b_coeff
R25        -> r25
lPin       -> a
rPin       -> b
```

No fixture:

```text
Temp="152.4 ºC"
B="3455"
R25="10000 Ω"
```

Esses valores devem sobreviver corretamente.

---

## 11. OpAmp — fidelidade elétrica obrigatória

Apenas persistir `gain` não basta.

Aplicar `patches/0005-electrical-and-visual-fidelity-real-fixtures.patch`.

Campos SimulIDE:

```text
Gain
Out_Imped
Power_Pins
Switch_Pins
Volt_Pos
Volt_Neg
```

Campos LasecSimul v4:

```text
gain
outImpedance
powerPins
switchPins
voltPos
voltNeg
```

Comportamento a reproduzir:

```text
Vout = gain * (V+ - V-)

powerPins=false:
    clamp entre voltNeg e voltPos

powerPins=true:
    clamp entre os pinos powerNeg/powerPos reais
```

O fixture NTC usa `0..5 V`; os filtros anteriores usam power pins.

---

## 12. LED `Grounded=true`

SimulIDE aterra internamente o segundo terminal e o esconde.

A v4 persiste:

```ts
grounded: true
```

O Core/render precisa reproduzir isso; não deixar catodo flutuante e não exigir GND visual extra se o modelo puder fazer o aterramento interno.

---

## 13. `Small=true`

Arquivos reais usam variante pequena de:

```text
Fixed Voltage
Probe
```

A v4 mapeia `small`. O renderer/package deve respeitar a geometria pequena e os pins correspondentes.

---

## 14. Propriedades sem equivalente

Nunca jogar fora.

Guardar como:

```text
__ui_simulideRaw_<nome-normalizado>
```

com warning.

Isso permite implementar suporte futuro sem precisar reler o `.sim1/.sim2`.

---

## 15. Fidelidade gráfica

Aplicar `0002-graphical-fidelity.patch` e manter as correções da v3.

Preservar:

### Rectangle / frame

```text
H_size
V_size
Color
Border
Opacity
Z_Value
```

### Ellipse

mesmos campos de Shape.

### Line

```text
H_size/V_size -> deltaX/deltaY
Color
Border
Opacity
Z_Value
```

Não reduzir linha diagonal a horizontal.

### TextComponent

```text
Text
Margin
Border
Color
Opacity
Font
Font_Color
Font_Size
Fixed_Width
```

### Image

```text
H_size
V_size
Border
Image_File
BckGndData
Color
Opacity
Z_Value
```

Imagem externa relativa deve ser embutida em base64 quando disponível.

### Labels

Preservar:

```text
idLabPos
valLabPos
labelrot
valLabRot
```

---

## 16. Rotação intrínseca de packages

Não aplicar duas vezes rotações que o catálogo já contém em `package.initialTransform`.

Casos reais:

```text
Rail  +90°
Probe -45°
```

O importador v4 já usa `projectRotationForSimulide()`.

---

## 17. Settings globais de simulação

No SimulIDE real:

```text
stepSize = picosegundos por passo
stepsPS  = passos por segundo de parede
NLsteps  = iterações não-lineares máximas
reaStep  = período do AnalogClock em ps
```

Converter:

```text
initialStepSeconds = stepSize * 1e-12
minimumStepSeconds = stepSize * 1e-12
maximumStepSeconds = stepSize * 1e-12
adaptiveTimeStep = false

timeScale = stepSize * stepsPS / 1e12
maximumNewtonIterations = NLsteps
reactivePeriodSeconds = reaStep * 1e-12
```

Adicionar `reactivePeriodSeconds?` ao `ProjectSimulationSettings` e ao round-trip do serializer.

---

## 18. Fluxo de abertura

Criar/usar função equivalente a:

```ts
openSupportedProjectFile(filePath, options)
```

```text
.lsproj -> openProjectFile
.sim1/.sim2 -> openSimulideAsLsproj -> save -> openProjectFile(.lsproj)
```

`openProjectCommand()` deve aceitar `lsproj`, `sim1`, `sim2`.

Registrar custom editor separado para `*.sim1`/`*.sim2` apenas como gatilho de conversão.

---

## 19. Colisão de `.lsproj`

Nunca sobrescrever silenciosamente.

Oferecer:

- Abrir `.lsproj` existente;
- Substituir;
- Criar cópia `name.imported-N.lsproj`;
- Cancelar.

---

## 20. Relatório de importação

Output Channel:

```text
LasecSimul: Importação SimulIDE
```

Exibir:

```text
componentes encontrados
emitidos no .lsproj
convertidos integralmente
convertidos parcialmente
placeholders
nodes
condutores preservados
endpoints órfãos preservados
warnings
fatal errors
```

Um placeholder é uma **pendência**, não falha de conversão.

---

## 21. Fixtures reais obrigatórios

Use os quatro arquivos incluídos:

```text
extension/test/fixtures/simulide/real-user/devkitc_test.sim2
extension/test/fixtures/simulide/real-user/filto_aliasing0.sim2
extension/test/fixtures/simulide/real-user/filto_aliasing1.sim2
extension/test/fixtures/simulide/real-user/NTC_ApInst.sim1
```

Critérios mínimos:

### devkitc_test.sim2

- todos os connectors preservados;
- ESP32 DevKitC reconhecido;
- AIP SDA/SCL;
- SerialTerm/SerialPort;
- `Grounded=true` do LED preservado funcionalmente;
- firmware preservado;
- `Small` preservado.

### filto_aliasing0.sim2 / filto_aliasing1.sim2

- todos os components/nodes/connectors preservados;
- WaveGen completo;
- Oscope/LAnalizer UI state;
- OpAmp com alimentação/clamp correto;
- labels/rotação.

### NTC_ApInst.sim1

O teste isolado deste pacote já confirmou:

```text
22 componentes emitidos
11 Nodes originais
36 condutores preservados
1 placeholder: Arduino Uno
Thermistor temp=152.4
Thermistor B=3455
Thermistor R25=10000
pins Uno preservados: A5, 1, 0
Connector uids duplicados renomeados sem perda
stepSize=1e6 ps -> 1e-6 s
timeScale=1
```

No checkout real, exigir que o projeto salvo/reaberto mantenha esses invariantes.

---

## 22. Critério de aceite final

A integração só está concluída quando:

1. `.sim1` e `.sim2` abrem pelo Explorer e pelo comando Open;
2. `.lsproj` é gerado e passa a ser o documento ativo;
3. componente não suportado nunca aborta a importação inteira;
4. nenhum connector suportável é descartado silenciosamente;
5. placeholders preservam pins/fios/raw data;
6. todos os quatro fixtures reais geram `.lsproj` válidos;
7. o `.lsproj` salvo reabre sem perder placeholder pins ou conductor ids;
8. gráficos/textos/frames mantêm geometria/cores/ordem;
9. OpAmp/LED/Thermistor têm equivalência elétrica prevista neste prompt;
10. testes e `tsc`/build do checkout real passam.

Não declare “100% equivalente” se algum comportamento do Core continuar sem implementação. Declare precisamente o que é convertido funcionalmente e o que ficou como placeholder/metadata preservada.
