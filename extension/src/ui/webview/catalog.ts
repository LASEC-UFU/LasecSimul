import { WebviewComponentCatalogEntry, WebviewProjectState } from "./model";

// Categoria/subcategoria/label usam o nome EXATO da taxonomia do SimulIDE (itemlibrary.cpp +
// traducao pt_BR) - ver docs/15-taxonomia-paleta.md pra tabela completa (inclusive os ~130 itens
// do SimulIDE que o LasecSimul ainda nao implementa). Ao adicionar um componente novo, achar a
// categoria correspondente la ANTES de inventar uma nova aqui.
export const defaultComponentCatalog: WebviewComponentCatalogEntry[] = [
  { typeId: "sources.dc_voltage", label: "Fonte de Tensao", category: "Fontes", folderPath: ["Fontes"], icon: "fonte-de-tensao", pinCount: 2, defaultProperties: { voltage: 5 } },
  { typeId: "other.ground", label: "Terra (0 V)", category: "Fontes", folderPath: ["Fontes"], icon: "terra", pinCount: 1, defaultProperties: {} },
  { typeId: "logic.button", label: "Botao", category: "Interruptores", folderPath: ["Interruptores"], icon: "botao", pinCount: 2, defaultProperties: { pressed: false } },
  { typeId: "instruments.voltmeter", label: "Voltimetro", category: "Medidores", folderPath: ["Medidores"], icon: "voltimetro", graphical: true, pinCount: 3, defaultProperties: {} },
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
  { typeId: "connectors.socket", label: "Soquete", category: "Conectores", folderPath: ["Conectores"], icon: "socket", graphical: true, pinCount: 8, defaultProperties: {} },
  { typeId: "connectors.header", label: "Cabecalho", category: "Conectores", folderPath: ["Conectores"], icon: "header", graphical: true, pinCount: 8, defaultProperties: {} },
  { typeId: "graphics.image", label: "Imagem", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-image", graphical: true, pinCount: 0, defaultProperties: { path: "" } },
  { typeId: "graphics.text", label: "Texto", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-text", graphical: true, pinCount: 0, defaultProperties: { text: "Text" } },
  { typeId: "graphics.rectangle", label: "Retangulo", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-rectangle", graphical: true, pinCount: 0, defaultProperties: {} },
  { typeId: "graphics.ellipse", label: "Elipse", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-ellipse", graphical: true, pinCount: 0, defaultProperties: {} },
  { typeId: "graphics.line", label: "Linha", category: "Grafico", folderPath: ["Grafico"], icon: "graphic-line", graphical: true, pinCount: 0, defaultProperties: {} },
  { typeId: "other.package", label: "Pacote", category: "Outros", folderPath: ["Outros"], icon: "package", graphical: true, pinCount: 0, defaultProperties: {}, disabled: true, disabledReason: "subcircuito/package interativo ainda indisponivel" },
  { typeId: "other.test_unit", label: "Unidade de Teste", category: "Outros", folderPath: ["Outros"], icon: "test-unit", pinCount: 0, defaultProperties: {}, hidden: true },
  { typeId: "other.dial", label: "Rotativo", category: "Outros", folderPath: ["Outros"], icon: "dial", graphical: true, pinCount: 0, defaultProperties: {}, hidden: true },
  { typeId: "digital.generic_fpga", label: "Bloco Programável FPGA", category: "GHDL", folderPath: ["GHDL"], workspaceSection: "digital", icon: "package", pinCount: 0, defaultProperties: {} },
  { typeId: "plc.instance", label: "PLC IEC 61131-3", category: "Controle", folderPath: ["PLC IEC 61131-3"], workspaceSection: "control", icon: "package", pinCount: 0,
    defaultProperties: { plcIecProjectRef: "", plcArtifactRef: "", plcEntryConfiguration: "", plcTaskIntervalMs: 10 },
    propertySchema: [
      { id: "plcIecProjectRef", label: "Projeto IEC 61131-3", group: "PLC", unit: "", editor: "filePath", default: "" },
      { id: "plcArtifactRef", label: "Artefato compilado", group: "PLC", unit: "", editor: "filePath", default: "" },
      { id: "plcEntryConfiguration", label: "Configuracao de entrada", group: "PLC", unit: "", editor: "text", default: "" },
      { id: "plcTaskIntervalMs", label: "Periodo da tarefa", group: "PLC", unit: "ms", editor: "number", default: 10, min: 0.1, max: 60000 },
    ] },
  { typeId: "protocol.modbus.server", label: "Servidor Modbus", category: "Process", folderPath: ["Process", "Protocolos Industriais", "Modbus"], workspaceSection: "process", icon: "package", pinCount: 2, pinIds: ["value", "gnd"], defaultProperties: { channel: "modbus-1", enabled: true, scanPeriodMs: 100, timeoutMs: 1000, unitId: 1, area: "holdingRegister", address: 0, scale: 0.001, offset: 0 } },
  { typeId: "protocol.modbus.client", label: "Cliente Modbus", category: "Process", folderPath: ["Process", "Protocolos Industriais", "Modbus"], workspaceSection: "process", icon: "package", pinCount: 2, pinIds: ["value", "gnd"], defaultProperties: { channel: "modbus-1", enabled: true, scanPeriodMs: 100, timeoutMs: 1000, unitId: 1, area: "holdingRegister", address: 0, scale: 0.001, offset: 0 } },
  { typeId: "protocol.hart.transmitter", label: "Transmissor HART", category: "Process", folderPath: ["Process", "Protocolos Industriais", "HART"], workspaceSection: "process", icon: "package", pinCount: 2, pinIds: ["value", "gnd"], defaultProperties: { channel: "hart-1", enabled: true, scanPeriodMs: 100, timeoutMs: 1000, pollingAddress: 0, uniqueId: "0011223344", tag: "TIC101", unit: "V" } },
  { typeId: "protocol.hart.communicator", label: "Comunicador HART", category: "Process", folderPath: ["Process", "Protocolos Industriais", "HART"], workspaceSection: "process", icon: "package", pinCount: 2, pinIds: ["value", "gnd"], defaultProperties: { channel: "hart-1", enabled: true, scanPeriodMs: 100, timeoutMs: 1000, pollingAddress: 0, uniqueId: "0011223344", tag: "TIC101", unit: "V", hartCommand: "1" } },
  { typeId: "logic.buffer", label: "Buffer", category: "Logicos", folderPath: ["Portas"], icon: "buffer", pinCount: 2, defaultProperties: {} },
  { typeId: "logic.and_gate", label: "And Gate", category: "Logicos", folderPath: ["Portas"], icon: "andgate", pinCount: 3, defaultProperties: {} },
  { typeId: "logic.or_gate", label: "Or Gate", category: "Logicos", folderPath: ["Portas"], icon: "orgate", pinCount: 3, defaultProperties: {} },
  { typeId: "logic.xor_gate", label: "Xor Gate", category: "Logicos", folderPath: ["Portas"], icon: "xorgate", pinCount: 3, defaultProperties: {} },
  { typeId: "logic.counter", label: "Simple Counter", category: "Logicos", folderPath: ["Aritmeticos"], icon: "2to1", pinCount: 3, defaultProperties: { maxValue: 1 } },
  { typeId: "logic.bin_counter", label: "Binary Counter", category: "Logicos", folderPath: ["Aritmeticos"], icon: "2to3g", pinCount: 6, defaultProperties: {} },
  { typeId: "logic.full_adder", label: "Full Adder", category: "Logicos", folderPath: ["Aritmeticos"], icon: "2to2", pinCount: 5, defaultProperties: {} },
  { typeId: "logic.magnitude_comp", label: "Magnitude Comparator", category: "Logicos", folderPath: ["Aritmeticos"], icon: "3to2g", pinCount: 11, defaultProperties: {} },
  { typeId: "logic.shift_reg", label: "Shift Register", category: "Logicos", folderPath: ["Aritmeticos"], icon: "1to3", pinCount: 11, defaultProperties: {} },
  { typeId: "logic.function", label: "Function", category: "Logicos", folderPath: ["Aritmeticos"], icon: "package", pinCount: 3, defaultProperties: { functions: "i0 | i1" } },
  { typeId: "logic.flipflop_d", label: "FlipFlopD", category: "Logicos", folderPath: ["Memorias"], icon: "2to2", pinCount: 6, defaultProperties: {} },
  { typeId: "logic.flipflop_t", label: "FlipFlopT", category: "Logicos", folderPath: ["Memorias"], icon: "2to2", pinCount: 6, defaultProperties: {} },
  { typeId: "logic.flipflop_rs", label: "FlipFlop RS", category: "Logicos", folderPath: ["Memorias"], icon: "2to2", pinCount: 4, defaultProperties: {} },
  { typeId: "logic.flipflop_jk", label: "FlipFlop JK", category: "Logicos", folderPath: ["Memorias"], icon: "3to2", pinCount: 7, defaultProperties: {} },
  { typeId: "logic.latch_d", label: "Latch", category: "Logicos", folderPath: ["Memorias"], icon: "package", pinCount: 4, defaultProperties: {} },
  { typeId: "logic.memory", label: "Memory", category: "Logicos", folderPath: ["Memorias"], icon: "2to3g", pinCount: 15, defaultProperties: {} },
  { typeId: "logic.dynamic_memory", label: "Dynamic Memory", category: "Logicos", folderPath: ["Memorias"], icon: "2to3g", pinCount: 15, defaultProperties: {} },
  { typeId: "logic.i2c_ram", label: "I2C Ram", category: "Logicos", folderPath: ["Memorias"], icon: "2to3", pinCount: 5, defaultProperties: { sizeBytes: 65536, controlCode: 80, frequencyKHz: 100, persistent: false } },
  { typeId: "logic.mux", label: "Mux", category: "Logicos", folderPath: ["Conversores"], icon: "mux", pinCount: 13, defaultProperties: {} },
  { typeId: "logic.demux", label: "Demux", category: "Logicos", folderPath: ["Conversores"], icon: "demux", pinCount: 12, defaultProperties: {} },
  { typeId: "logic.bcd_to_dec", label: "Bcd To Dec", category: "Logicos", folderPath: ["Conversores"], icon: "2to3g", pinCount: 14, defaultProperties: {} },
  { typeId: "logic.dec_to_bcd", label: "Dec To Bcd", category: "Logicos", folderPath: ["Conversores"], icon: "3to2g", pinCount: 14, defaultProperties: {} },
  { typeId: "logic.bcd_to_7seg", label: "Bcd To 7S.", category: "Logicos", folderPath: ["Conversores"], icon: "2to3g", pinCount: 11, defaultProperties: {} },
  { typeId: "logic.i2c_to_parallel", label: "I2C to Parallel", category: "Logicos", folderPath: ["Conversores"], icon: "2to3g", pinCount: 14, defaultProperties: { controlCode: 80, frequencyKHz: 100 } },
  { typeId: "logic.adc", label: "ADC", category: "Logicos", folderPath: ["Outros logicos"], icon: "1to3", pinCount: 9, defaultProperties: { vref: 5 } },
  { typeId: "logic.dac", label: "DAC", category: "Logicos", folderPath: ["Outros logicos"], icon: "3to1", pinCount: 9, defaultProperties: { vref: 5 } },
  { typeId: "logic.seven_segment_bcd", label: "7 Segment BCD", category: "Logicos", folderPath: ["Outros logicos"], icon: "7segbcd", pinCount: 11, defaultProperties: {} },
  { typeId: "logic.lm555", label: "LM555", category: "Logicos", folderPath: ["Outros logicos"], icon: "ic2", pinCount: 8, defaultProperties: {} },
  { typeId: "logic.subtractor", label: "Subtractor", category: "Logicos", folderPath: ["Aritmeticos"], icon: "2to2", pinCount: 5, defaultProperties: {} },
  { typeId: "logic.multiplier", label: "Multiplier", category: "Logicos", folderPath: ["Aritmeticos"], icon: "ic2", pinCount: 16, defaultProperties: {} },
  { typeId: "logic.divider", label: "Divider", category: "Logicos", folderPath: ["Aritmeticos"], icon: "ic2", pinCount: 16, defaultProperties: {} },
  { typeId: "logic.shifter", label: "Shifter", category: "Logicos", folderPath: ["Aritmeticos"], icon: "ic2", pinCount: 20, defaultProperties: { arithmetic: false } },
  { typeId: "logic.negator", label: "Negator", category: "Logicos", folderPath: ["Aritmeticos"], icon: "ic2", pinCount: 16, defaultProperties: {} },
  { typeId: "logic.minmax", label: "Min/Max", category: "Logicos", folderPath: ["Aritmeticos"], icon: "ic2", pinCount: 16, defaultProperties: {} },
  { typeId: "logic.absolute", label: "Absolute", category: "Logicos", folderPath: ["Aritmeticos"], icon: "ic2", pinCount: 16, defaultProperties: {} },
  { typeId: "logic.bit_adder", label: "Bit Adder", category: "Logicos", folderPath: ["Aritmeticos"], icon: "2to3g", pinCount: 12, defaultProperties: {} },
  { typeId: "logic.register", label: "Register", category: "Logicos", folderPath: ["Memorias"], icon: "2to3", pinCount: 19, defaultProperties: {} },
  { typeId: "logic.random", label: "Random", category: "Logicos", folderPath: ["Memorias"], icon: "package", pinCount: 10, defaultProperties: { seed: 1 } },
  { typeId: "logic.decoder", label: "Decoder", category: "Logicos", folderPath: ["Conversores"], icon: "1to3", pinCount: 12, defaultProperties: {} },
  { typeId: "logic.priority_encoder", label: "Priority Encoder", category: "Logicos", folderPath: ["Conversores"], icon: "3to1", pinCount: 12, defaultProperties: {} },
  { typeId: "logic.bit_selector", label: "Bit Selector", category: "Logicos", folderPath: ["Conversores"], icon: "mux", pinCount: 13, defaultProperties: {} },
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
    symbolElements: [],
    iconElements: [],
    exposedComponents: [],
    exportedPropertyComponentIds: [],
  };
}
