import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ProjectSerializer } from "../../src/project/ProjectSerializer";

(async () => {
  const examples = path.resolve(__dirname, "../../../../docs/python-programavel/exemplos");
  const serializer = new ProjectSerializer();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lasecsimul-python-project-"));
  const files = ["controle_digital.lsproj", "controle_proporcional.lsproj", "controle_pid.lsproj", "controle_tanque.lsproj", "numpy.lsproj"];
  for (const file of files) {
    const source = path.join(examples, file);
    const project = await serializer.load(source);
    const block = project.components.find(component => component.typeId === "python.programmable");
    assert.ok(block, `${file}: projeto deve ter o bloco Python`);
    assert.strictEqual(block.typeId, "python.programmable", `${file}: typeId`);
    assert.ok(String(block.properties.source).trim().length > 0, `${file}: fonte embutida`);
    const ports = JSON.parse(String(block.properties.ports)) as { inputs: Array<{ name: string; type: string }>; outputs: Array<{ name: string; type: string }> };
    assert.ok(ports.inputs.length > 0 && ports.outputs.length > 0, `${file}: portas tipadas`);
    assert.ok(project.components.some(component => component.typeId === "control.constant"),
      `${file}: projeto deve conter uma fonte ou uma planta simulada`);
    for (const port of ports.inputs) {
      const connected = project.topology.conductors.some(wire =>
        (wire.from.kind === "port" && wire.from.componentId === block.id && wire.from.pinId === port.name) ||
        (wire.to.kind === "port" && wire.to.componentId === block.id && wire.to.pinId === port.name));
      assert.ok(connected, `${file}: entrada Python ${port.name} deve estar conectada no grafo`);
    }
    const roundTripPath = path.join(scratch, file);
    await serializer.save(roundTripPath, project);
    const reopened = await serializer.load(roundTripPath);
    const reopenedBlock = reopened.components.find(component => component.typeId === "python.programmable");
    assert.deepStrictEqual(reopenedBlock?.properties, block.properties, `${file}: código, portas e período preservados no save/load`);
    assert.deepStrictEqual(reopened.topology.conductors, project.topology.conductors, `${file}: conexões preservadas no save/load`);
  }
  await fs.rm(scratch, { recursive: true, force: true });
  console.log("Python block project examples: schema and save/load OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
