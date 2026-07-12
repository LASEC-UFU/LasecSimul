import { WebviewComponentCatalogEntry, WebviewProjectState } from "./model";

// Categoria/subcategoria/label usam o nome EXATO da taxonomia do SimulIDE (itemlibrary.cpp +
// traducao pt_BR) - ver docs/15-taxonomia-paleta.md pra tabela completa (inclusive os ~130 itens
// do SimulIDE que o LasecSimul ainda nao implementa). Ao adicionar um componente novo, achar a
// categoria correspondente la ANTES de inventar uma nova aqui.
export const defaultComponentCatalog: WebviewComponentCatalogEntry[] = [
  { typeId: "sources.dc_voltage", label: "Fonte de Tensao", category: "Fontes", folderPath: ["Fontes"], icon: "fonte-de-tensao", pinCount: 2, defaultProperties: { voltage: 5 } },
  { typeId: "other.ground", label: "Terra (0 V)", category: "Fontes", folderPath: ["Fontes"], icon: "terra", pinCount: 1, defaultProperties: {} },
  { typeId: "logic.button", label: "Botao", category: "Interruptores", folderPath: ["Interruptores"], icon: "botao", pinCount: 2, defaultProperties: { pressed: false } },
  { typeId: "instruments.voltmeter", label: "Voltimetro", category: "Medidores", folderPath: ["Medidores"], icon: "voltimetro", pinCount: 3, defaultProperties: {} },
  { typeId: "passive.resistor", label: "Resistor", category: "Passivos", subcategory: "Resistores", folderPath: ["Passivos", "Resistores"], icon: "resistor", pinCount: 2, defaultProperties: { resistance: 1000 } },
  { typeId: "passive.capacitor", label: "Capacitor", category: "Passivos", subcategory: "Reativo", folderPath: ["Passivos", "Reativo"], icon: "capacitor", pinCount: 2, defaultProperties: { capacitance: 1e-6 } },
  { typeId: "passive.inductor", label: "Indutor", category: "Passivos", subcategory: "Reativo", folderPath: ["Passivos", "Reativo"], icon: "inductor", pinCount: 2, defaultProperties: { inductance: 1e-3 } },
  { typeId: "connectors.bus", label: "Barramento", category: "Conectores", folderPath: ["Conectores"], icon: "bus", pinCount: 1, defaultProperties: {} },
  // `pinIds: ["pin"]` -- todo `.lssubcircuit` (gravado por `createSubcircuitFromSelectionHandler` OU
  // autorado à mão) referencia o pino do túnel como `pinId: "pin"` (singular, sem sufixo numérico) em
  // `wires[]`. Sem isto aqui, `pinsForTypeId` cairia no genérico `pin-1`, e toda instância viva de um
  // túnel (ex: "Abrir Subcircuito", `extension.ts::openSubcircuitForEditingCommand`) teria seus fios
  // de fronteira órfãos -- `pinScenePosition` (main.ts) casa por STRING exata do id.
  { typeId: "connectors.tunnel", label: "Tunel", category: "Conectores", folderPath: ["Conectores"], icon: "tunel", pinCount: 1, pinIds: ["pin"], defaultProperties: {} },
  { typeId: "connectors.socket", label: "Soquete", category: "Conectores", folderPath: ["Conectores"], icon: "socket", pinCount: 8, defaultProperties: {} },
  { typeId: "connectors.header", label: "Cabecalho", category: "Conectores", folderPath: ["Conectores"], icon: "header", pinCount: 8, defaultProperties: {} },
  { typeId: "graphics.image", label: "Imagem", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-image", pinCount: 0, defaultProperties: { path: "" } },
  { typeId: "graphics.text", label: "Texto", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-text", pinCount: 0, defaultProperties: { text: "Text" } },
  { typeId: "graphics.rectangle", label: "Retangulo", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-rectangle", pinCount: 0, defaultProperties: {} },
  { typeId: "graphics.ellipse", label: "Elipse", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-ellipse", pinCount: 0, defaultProperties: {} },
  { typeId: "graphics.line", label: "Linha", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-line", pinCount: 0, defaultProperties: {} },
  { typeId: "other.package", label: "Pacote", category: "Outros", folderPath: ["Outros"], icon: "package", pinCount: 0, defaultProperties: {}, disabled: true, disabledReason: "subcircuito/package interativo ainda indisponivel" },
  { typeId: "other.test_unit", label: "Unidade de Teste", category: "Outros", folderPath: ["Outros"], icon: "test-unit", pinCount: 0, defaultProperties: {}, hidden: true },
  { typeId: "other.dial", label: "Rotativo", category: "Outros", folderPath: ["Outros"], icon: "dial", pinCount: 0, defaultProperties: {}, hidden: true },
  { typeId: "logic.buffer", label: "Buffer", category: "Logicos", folderPath: ["Logicos", "Portas"], icon: "buffer", pinCount: 2, defaultProperties: {} },
  { typeId: "logic.and_gate", label: "And Gate", category: "Logicos", folderPath: ["Logicos", "Portas"], icon: "andgate", pinCount: 3, defaultProperties: {} },
  { typeId: "logic.or_gate", label: "Or Gate", category: "Logicos", folderPath: ["Logicos", "Portas"], icon: "orgate", pinCount: 3, defaultProperties: {} },
  { typeId: "logic.xor_gate", label: "Xor Gate", category: "Logicos", folderPath: ["Logicos", "Portas"], icon: "xorgate", pinCount: 3, defaultProperties: {} },
  { typeId: "logic.counter", label: "Simple Counter", category: "Logicos", folderPath: ["Logicos", "Aritmeticos"], icon: "2to1", pinCount: 3, defaultProperties: { maxValue: 1 } },
  { typeId: "logic.bin_counter", label: "Binary Counter", category: "Logicos", folderPath: ["Logicos", "Aritmeticos"], icon: "2to3g", pinCount: 6, defaultProperties: {} },
  { typeId: "logic.full_adder", label: "Full Adder", category: "Logicos", folderPath: ["Logicos", "Aritmeticos"], icon: "2to2", pinCount: 5, defaultProperties: {} },
  { typeId: "logic.magnitude_comp", label: "Magnitude Comparator", category: "Logicos", folderPath: ["Logicos", "Aritmeticos"], icon: "3to2g", pinCount: 11, defaultProperties: {} },
  { typeId: "logic.shift_reg", label: "Shift Register", category: "Logicos", folderPath: ["Logicos", "Aritmeticos"], icon: "1to3", pinCount: 11, defaultProperties: {} },
  { typeId: "logic.function", label: "Function", category: "Logicos", folderPath: ["Logicos", "Aritmeticos"], icon: "package", pinCount: 3, defaultProperties: { functions: "i0 | i1" } },
  { typeId: "logic.flipflop_d", label: "FlipFlopD", category: "Logicos", folderPath: ["Logicos", "Memorias"], icon: "2to2", pinCount: 6, defaultProperties: {} },
  { typeId: "logic.flipflop_t", label: "FlipFlopT", category: "Logicos", folderPath: ["Logicos", "Memorias"], icon: "2to2", pinCount: 6, defaultProperties: {} },
  { typeId: "logic.flipflop_rs", label: "FlipFlop RS", category: "Logicos", folderPath: ["Logicos", "Memorias"], icon: "2to2", pinCount: 4, defaultProperties: {} },
  { typeId: "logic.flipflop_jk", label: "FlipFlop JK", category: "Logicos", folderPath: ["Logicos", "Memorias"], icon: "3to2", pinCount: 7, defaultProperties: {} },
  { typeId: "logic.latch_d", label: "Latch", category: "Logicos", folderPath: ["Logicos", "Memorias"], icon: "package", pinCount: 4, defaultProperties: {} },
  { typeId: "logic.memory", label: "Memory", category: "Logicos", folderPath: ["Logicos", "Memorias"], icon: "2to3g", pinCount: 15, defaultProperties: {} },
  { typeId: "logic.dynamic_memory", label: "Dynamic Memory", category: "Logicos", folderPath: ["Logicos", "Memorias"], icon: "2to3g", pinCount: 15, defaultProperties: {} },
  { typeId: "logic.i2c_ram", label: "I2C Ram", category: "Logicos", folderPath: ["Logicos", "Memorias"], icon: "2to3", pinCount: 5, defaultProperties: { sizeBytes: 65536, controlCode: 80, frequencyKHz: 100, persistent: false } },
  { typeId: "logic.mux", label: "Mux", category: "Logicos", folderPath: ["Logicos", "Conversores"], icon: "mux", pinCount: 13, defaultProperties: {} },
  { typeId: "logic.demux", label: "Demux", category: "Logicos", folderPath: ["Logicos", "Conversores"], icon: "demux", pinCount: 12, defaultProperties: {} },
  { typeId: "logic.bcd_to_dec", label: "Bcd To Dec", category: "Logicos", folderPath: ["Logicos", "Conversores"], icon: "2to3g", pinCount: 14, defaultProperties: {} },
  { typeId: "logic.dec_to_bcd", label: "Dec To Bcd", category: "Logicos", folderPath: ["Logicos", "Conversores"], icon: "3to2g", pinCount: 14, defaultProperties: {} },
  { typeId: "logic.bcd_to_7seg", label: "Bcd To 7S.", category: "Logicos", folderPath: ["Logicos", "Conversores"], icon: "2to3g", pinCount: 11, defaultProperties: {} },
  { typeId: "logic.i2c_to_parallel", label: "I2C to Parallel", category: "Logicos", folderPath: ["Logicos", "Conversores"], icon: "2to3g", pinCount: 14, defaultProperties: { controlCode: 80, frequencyKHz: 100 } },
  { typeId: "logic.adc", label: "ADC", category: "Logicos", folderPath: ["Logicos", "Outros logicos"], icon: "1to3", pinCount: 9, defaultProperties: { vref: 5 } },
  { typeId: "logic.dac", label: "DAC", category: "Logicos", folderPath: ["Logicos", "Outros logicos"], icon: "3to1", pinCount: 9, defaultProperties: { vref: 5 } },
  { typeId: "logic.seven_segment_bcd", label: "7 Segment BCD", category: "Logicos", folderPath: ["Logicos", "Outros logicos"], icon: "7segbcd", pinCount: 11, defaultProperties: {} },
  { typeId: "logic.lm555", label: "LM555", category: "Logicos", folderPath: ["Logicos", "Outros logicos"], icon: "ic2", pinCount: 8, defaultProperties: {} },
];

// Removidos do catalogo ate terem ComponentRegistry::registerFactory real no Core (ver
// docs/mvp-limitacoes.md): semiconductors.diode/transistor_npn/transistor_pnp e logic.led exigem
// modelo nao-linear (sem Newton-Raphson real ainda, so o contrato/mecanica em IComponentModel) -
// modela-los como resistor linear seria fisicamente incorreto. MCUs/ABIs externos entram pelo
// catalogo unificado via `registeredSources` (manifesto `.lsdevice` unico), nao por hardcode aqui. Novos MCUs
// devem seguir a taxonomia ja mapeada em docs/15-taxonomia-paleta.md ("Microcontroladores" >
// plataforma/chip).

export function createInitialWebviewState(catalog: WebviewComponentCatalogEntry[] = defaultComponentCatalog): WebviewProjectState {
  return {
    locale: "pt-BR",
    catalog,
    components: [],
    topology: { revision: 0, nodes: [], conductors: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedComponentIds: [],
    selectedWireIds: [],
  };
}
