export interface PropertySchemaOption {
  value: string;
  label: string;
}

/** Espelha 1:1 o JSON devolvido pelo Core (`propertySchemaToJson` em `CoreApplication.cpp`) — mesmo
 * schema rico que `.lsdevice` já declara pra plugins, agora também devolvido pra built-ins
 * (`ComponentMetadataRegistry`, populado em `registerBuiltinComponents`). Schema é por `typeId`
 * (catálogo), nunca por instância — ver `getPropertySchemas` no Core. */
export interface PropertySchemaDto {
  id: string;
  label: string;
  group: string;
  unit: string;
  valueKind: "number" | "string" | "bool" | "point";
  editor: string;
  default: number | string | boolean | { x: number; y: number };
  min?: number;
  max?: number;
  step?: number;
  options?: PropertySchemaOption[];
  hidden: boolean;
  readOnly: boolean;
  noCopy: boolean;
  affectsTopology: boolean;
  affectsPinCount: boolean;
  requiresRestart: boolean;
  showOnSymbol: boolean;
}

/** Espelha 1:1 `readoutFormatToJson` em `CoreApplication.cpp` -- ABI v2, ver
 * .spec/lasecsimul-native-devices.spec. */
export type ReadoutFormatDto =
  | { kind: "scalar"; unit: string }
  | { kind: "channelHistory"; channels: number }
  | { kind: "bitmaskHistory"; channels: number };

/** Espelha 1:1 `interactionKindToJson` em `CoreApplication.cpp`, mais valores Extension-side
 * ("joystick", "encoder", "touchpad") que o Core não conhece mas a Extension lê do .lsdevice. */
export type InteractionKindDto = "momentary" | "toggle" | "none" | "joystick" | "encoder" | "touchpad";

export interface McuSerialPortDto {
  label: string;
  usartIndex: 0 | 1 | 2;
}

export interface TelemetrySample {
  instanceId: string;
  pinId: string;
  timeNs: bigint;
  value: number;
}

export interface DeviceLibraryManifest {
  publisher: string;
  version: string;
  devices: { typeId: string; manifestPath: string }[];
}
