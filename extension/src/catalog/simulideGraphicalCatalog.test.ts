import * as fs from "node:fs";
import * as path from "node:path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";

const builtinGraphical = [
  "switches.push", "switches.switch", "switches.switch_dip", "switches.relay", "switches.keypad",
  "passive.variable_resistor", "passive.potentiometer", "passive.variable_capacitor", "passive.variable_inductor",
  "outputs.led", "outputs.led_rgb", "outputs.led_bar", "outputs.led_matrix", "outputs.seven_segment",
  "outputs.dc_motor", "outputs.stepper", "outputs.incandescent_lamp",
  "connectors.socket", "connectors.header",
  "graphics.image", "graphics.text", "graphics.rectangle", "graphics.ellipse", "graphics.line",
  "other.package", "other.dial",
  "meters.probe", "meters.ampmeter", "instruments.voltmeter", "meters.freqmeter", "meters.oscope", "meters.logic_analyzer",
  "sources.fixed_volt", "sources.clock", "sources.wave_gen", "sources.voltage_source", "sources.current_source",
];

const manifestGraphical = [
  "sensors.ldr", "sensors.thermistor", "sensors.rtd", "sensors.strain", "sensors.ds1621", "sensors.dht22",
  "sensors.sr04", "sensors.ds18b20", "peripherals.ds1307", "peripherals.touchpad", "peripherals.serialterm",
  "peripherals.serialport", "peripherals.ky040", "peripherals.ky023", "peripherals.esp01",
  "outputs.servo", "outputs.aip31068_i2c", "outputs.gc9a01a", "outputs.hd44780", "outputs.ks0108",
  "outputs.pcd8544", "outputs.pcf8833", "outputs.sh1107", "outputs.ssd1306", "outputs.st7735",
  "outputs.st7789", "outputs.ili9341", "outputs.max72xx_matrix", "outputs.ws2812",
];

(async () => {
  const { test, finish } = createTestRunner("SimulIDE graphical catalog");
  const workspace = path.resolve(__dirname, "../../../..");
  const catalog = JSON.parse(fs.readFileSync(path.join(workspace, "project/schema/component-catalog.json"), "utf8")) as {
    items: Array<{ typeId: string; graphical?: boolean; icon?: string }>;
  };
  const catalogById = new Map(catalog.items.map((item) => [item.typeId, item]));
  const manifests = fs.readdirSync(path.join(workspace, "devices"), { recursive: true })
    .filter((entry) => String(entry).endsWith(".lsdevice"))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(workspace, "devices", String(entry)), "utf8")) as { typeId: string; graphical?: boolean; icon?: string });
  const manifestById = new Map(manifests.map((item) => [item.typeId, item]));
  const iconExists = (icon: string | undefined): boolean => Boolean(icon) && [".png", ".svg"].some((extension) =>
    fs.existsSync(path.join(workspace, "extension/media/components/light", `${icon}${extension}`))
  );

  await test("todos os built-ins que herdam m_graphical no SimulIDE estão marcados e têm ícone", () => {
    for (const typeId of builtinGraphical) {
      const item = catalogById.get(typeId);
      assert(item?.graphical === true, `${typeId} deveria declarar graphical:true`);
      assert(iconExists(item?.icon), `${typeId} deveria apontar para um ícone existente`);
    }
  });

  await test("devices equivalentes aos componentes gráficos do SimulIDE preservam flag e ícone", () => {
    for (const typeId of manifestGraphical) {
      const item = manifestById.get(typeId);
      assert(item?.graphical === true, `${typeId} deveria declarar graphical:true`);
      assert(iconExists(item?.icon), `${typeId} deveria usar o asset de ícone importado do SimulIDE`);
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
