# Taxonomia da Paleta de Componentes

## Objetivo

Registrar a árvore de categorias/subcategorias/itens da paleta de componentes do SimulIDE-dev
(`src/gui/componentlist/itemlibrary.cpp`, função `loadItems()`, com tradução pt_BR em
`resources/translations/simulide_pt_BR.ts`) — fonte de verdade pra QUALQUER componente novo no
LasecSimul (built-in, plugin nativo ou subcircuito) ser categorizado na paleta. **Nunca inventar uma
categoria nova se o SimulIDE já tem uma equivalente.**

## Regra

`WebviewComponentCatalogEntry.category`/`.subcategory` (`extension/src/ui/webview/model.ts`) usam o
nome **exato** em português (PT-BR) que o SimulIDE usa, na mesma ordem em que aparecem na tabela
abaixo. `ComponentPaletteProvider.ts` (TreeView nativo, container próprio na Activity Bar) constrói a
árvore a partir disso — categoria de topo nunca tem ícone (igual ao SimulIDE); subcategoria e item
sempre têm (`extension/media/components/{light,dark}/<icon>.svg`).

## Status: o que o LasecSimul já implementa

| typeId | Categoria | Subcategoria | Label na paleta | Ícone |
|---|---|---|---|---|
| `instruments.voltmeter` | Medidores | — | Voltímetro | `voltimetro` |
| `sources.dc_voltage` | Fontes | — | Fonte de Tensão | `fonte-de-tensao` |
| `other.ground` | Fontes | — | Terra (0 V) | `terra` |
| `switches.push` | Interruptores | — | Push | `push` |
| `switches.switch` | Interruptores | — | Switch (all) | `switch` |
| `switches.switch_dip` | Interruptores | — | Switch Dip | `switchdip` |
| `switches.relay` | Interruptores | — | Relay (all) | `relay-spst` |
| `switches.keypad` | Interruptores | — | KeyPad | `keypad` |
| `passive.resistor` | Passivos | Resistores | Resistor | `resistor` |
| `passive.capacitor` | Passivos | Reativo | Capacitor | `capacitor` |
| `passive.inductor` | Passivos | Reativo | Indutor | `inductor` |
| `connectors.tunnel` | Conectores | — | Túnel | `tunel` |

Todo o resto da tabela abaixo é a taxonomia **completa** do SimulIDE, pra referência ao implementar
um componente novo — categorias/itens sem `typeId` na coluna ainda não existem no LasecSimul. Uma
categoria/subcategoria só aparece na árvore da paleta (`ComponentPaletteProvider`) se tiver pelo
menos um item em `catalog.ts` — não mostramos pasta vazia.

## Taxonomia completa do SimulIDE (referência)

Ordem das categorias de topo é a ordem real do `itemlibrary.cpp`, não alfabética.

### Medidores

Probe (Ponta de prova), **Voltímetro**\*, Ampmeter (Amperímetro), Frequency Meter (Frequencímetro),
Oscope (Osciloscópio), Logic Analyzer (Analisador Lógico).

### Fontes

Fixed Volt (Tensão Fixa), Clock (Gerador de pulso), Wave Gen (Gerador de Onda), **Fonte de
Tensão**\*, Current Source (Fonte de corrente), Fonte Controlada, Battery (Bateria), Rail (Linha de
alimentação), **Terra (0 V)**\*.

### Interruptores

**Botão**\* (Push), **Chave**\* (Switch), **Chave DIP**\* (Switch DIP), **Relé**\* (Relay),
**Teclado**\* (Keypad). Todos com `package.simulidePaint` real (geometria/pinos/estado aberto-fechado
traduzidos de `push.cpp`/`switch.cpp`/`switchdip.cpp`/`relay.cpp`; Teclado é property-driven --
cresce com `rows`/`columns` reais, ver `componentSymbols.ts`).

### Passivos

- **Resistores**: **Resistor**\*, Resistor DIP, Potenciômetro, Resistor Trimpot (Variable Resistor).
- Sensores Resistivos: LDR, Termistor, RTD, Strain Gauge.
- **Reativo**: **Capacitor**\*, Capacitor Eletrolítico, Capacitor Variável, **Indutor**\*, Indutor
  Variável, Transformador.

### Ativos

- Retificadores: Diodo, Diodo Zener, SCR, DIAC, TRIAC.
- Transistores: BJT (Bipolar), MOSFET, JFET.
- Outros Ativos: Amplificador Operacional, Comparador, Regulador de Tensão, Multiplexador Analógico.

### Saídas

- LEDs: LED, LED RGB, Barra de LEDs, Display de 7 Segmentos, Matriz de LEDs, Matriz MAX72xx, WS2812.
- Displays: AIP31068 I2C, GC9A01A, HD44780, ILI9341, KS0108, PCD8544, PCF8833, SH1107, SSD1306,
  ST7735, ST7789.
- Motores: Motor DC, Motor de Passo, Servo.
- Outras Saídas: Saída de Áudio, Lâmpada.

### Microcontroladores

Plataformas (cada uma agrupa seus próprios chips): Arduino, AVR, PIC, I51, MCS65, Z80, STM32,
Espressif (ESP32 entra aqui), Shields, QemuDevice.

- Sensores: SR04 (Ultrassônico), DHT22, DS1621, DS18B20.
- Periféricos: SD Card, Porta Serial, Terminal Serial, Touchpad, KY023 (Joystick), KY040 (Encoder
  Rotativo), DS1307 (RTC), ESP-01 (WiFi).

### Lógicos

- Portas: Buffer, Porta AND, Porta OR, Porta XOR.
- Aritméticos: Contador, Contador Binário, Somador Completo, Comparador de Magnitude, Registrador
  de Deslocamento, Função.
- Memórias: FlipFlop D/T/RS/JK, Latch D, Memória, Memória Dinâmica, RAM I2C.
- Conversores: Multiplexador, Demultiplexador, BCD para Decimal, Decimal para BCD, BCD para
  7-Segmentos, I2C para Paralelo.
- Outros Lógicos: ADC, DAC, Display 7-Seg BCD, LM555 (Timer).

### Subcircuitos

SubCircuit — equivalente ao que `.spec/lasecsimul-subcircuits.spec` especifica pro LasecSimul
(circuito reutilizável definido por `.lssubcircuit`, ver ADR 0008).

### Conectores

Barramento (Bus), **Túnel**\* (Tunnel), Soquete (Socket), Header.

### Gráficos

Imagem, Texto, Retângulo, Elipse, Linha — componentes só-visuais (anotação do esquemático, sem
elétrica nenhuma).

### Outros

SubPackage, Unidade de Teste, Mostrador (Dial).

\* Já implementado no LasecSimul — ver tabela de status acima.

## Quando adicionar um componente novo

1. Achar a categoria/subcategoria exata na tabela acima (mesmo nome em português).
2. Se for built-in/plugin: registrar `category`/`subcategory`/`icon` em `catalog.ts` com esse nome
   exato — nunca abreviar/traduzir diferente do que está aqui.
3. Criar `media/components/light/<icone>.svg` e `media/components/dark/<icone>.svg` (mesmo estilo
   visual do símbolo já usado no canvas, `componentSymbols.ts`, quando fizer sentido reaproveitar a
   geometria) — categoria de topo nunca leva ícone próprio, só subcategoria/item.
4. Se a categoria/subcategoria ainda não existir em nenhuma entrada de `catalog.ts`, ela aparece
   automaticamente na árvore (`ComponentPaletteProvider` deriva a árvore do catálogo, não tem lista
   hardcoded de categorias) — não precisa editar o provider pra isso.
