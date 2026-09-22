import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { formatGraphicalValue, graphicalRuntimeProperties, isGraphicalTypeId } from "./graphicsBinding";
import type { ComponentReadoutValue } from "./messages";

const readouts = (map: Record<string, ComponentReadoutValue>) => (id: string) => map[id];
const none = () => undefined;

(async () => {
  const { test, finish } = createTestRunner("graphicsBinding");

  await test("sem binding, o valor estatico da propriedade desenha a tela (simulacao parada)", () => {
    const out = graphicalRuntimeProperties({ value: 73 }, none);
    assert(out.__g_value === 73, "valor deveria vir da propriedade");
    assert(out.__g_pct === 73, "0..100 por padrao mapeia 1:1 para porcentagem");
    assert(out.__g_bind === "static", `sem bindSource o estado deveria ser static, veio ${out.__g_bind}`);
  });

  await test("binding Float32 resolve a leitura da fonte por ID", () => {
    const out = graphicalRuntimeProperties({ value: 0, bindSource: "probe-1" }, readouts({ "probe-1": 42.5 }));
    assert(out.__g_value === 42.5, "valor deveria vir da telemetria da fonte");
    assert(out.__g_bind === "bound", "estado deveria ser bound");
  });

  await test("binding booleano: limiar e inversao", () => {
    assert(graphicalRuntimeProperties({ value: 100 }, none).__g_on === "true", "100 >= limiar 50 liga");
    assert(graphicalRuntimeProperties({ value: 0 }, none).__g_on === "false", "0 < limiar 50 desliga");
    assert(graphicalRuntimeProperties({ value: 30, bindThreshold: 25 }, none).__g_on === "true", "limiar proprio deveria valer");
    assert(graphicalRuntimeProperties({ value: 100, bindInvert: true }, none).__g_on === "false", "inversao deveria trocar o estado");
  });

  await test("faixa de engenharia vira 0..100 %, saturando nas pontas", () => {
    const props = { bindSource: "lt", bindMin: 0, bindMax: 25 };
    assert(graphicalRuntimeProperties(props, readouts({ lt: 0 })).__g_pct === 0, "minimo -> 0 %");
    assert(graphicalRuntimeProperties(props, readouts({ lt: 12.5 })).__g_pct === 50, "meio -> 50 %");
    assert(graphicalRuntimeProperties(props, readouts({ lt: 25 })).__g_pct === 100, "maximo -> 100 %");
    assert(graphicalRuntimeProperties(props, readouts({ lt: 999 })).__g_pct === 100, "acima da faixa satura em 100 %, nunca extrapola o desenho");
    assert(graphicalRuntimeProperties(props, readouts({ lt: -999 })).__g_pct === 0, "abaixo da faixa satura em 0 %");
  });

  await test("faixa degenerada (min == max) nao vira NaN nem divisao por zero", () => {
    const out = graphicalRuntimeProperties({ bindSource: "x", bindMin: 5, bindMax: 5 }, readouts({ x: 5 }));
    assert(out.__g_pct === 0, `faixa nula deveria cair para 0 %, veio ${out.__g_pct}`);
    assert(Number.isFinite(out.__g_pct), "nunca NaN -- iria para o atributo de geometria do SVG");
  });

  await test("ganho e offset sao aplicados ao valor bruto da fonte", () => {
    const out = graphicalRuntimeProperties(
      { bindSource: "raw", bindScale: 0.1, bindOffset: -4, bindMin: 0, bindMax: 100 },
      readouts({ raw: 1000 })
    );
    assert(out.__g_value === 96, `1000 * 0.1 - 4 deveria ser 96, veio ${out.__g_value}`);
  });

  await test("fonte inexistente: marca missing, mantem a tela legivel e nunca quebra", () => {
    const out = graphicalRuntimeProperties({ value: 12, bindSource: "nao-existe" }, none);
    assert(out.__g_bind === "missing", `deveria marcar missing, veio ${out.__g_bind}`);
    assert(out.__g_value === 12, "valor estatico continua desenhando enquanto a fonte nao publica");
  });

  await test("fonte sem leitura ainda (simulacao parada) e indistinguivel de fonte removida -- ambas missing", () => {
    const out = graphicalRuntimeProperties({ bindSource: "probe-1" }, readouts({}));
    assert(out.__g_bind === "missing", "sem leitura publicada, o binding fica missing");
  });

  await test("leitura multicanal (array) resolve pelo canal pedido", () => {
    const scope = readouts({ scope: [1, 2, 3, 4] });
    assert(graphicalRuntimeProperties({ bindSource: "scope" }, scope).__g_value === 1, "canal 0 por padrao");
    assert(graphicalRuntimeProperties({ bindSource: "scope", bindChannel: 2 }, scope).__g_value === 3, "canal explicito");
    assert(graphicalRuntimeProperties({ bindSource: "scope", bindChannel: 9 }, scope).__g_bind === "missing", "canal fora da faixa vira missing, nunca undefined no desenho");
  });

  await test("binding referencia ID estavel: trocar o ROTULO da fonte nao quebra a ligacao", () => {
    // O binding guarda `bindSource` = id do componente. Um rename de rotulo nao toca o id, entao a
    // mesma leitura continua resolvendo (ARCH-006: bindings persistem por identidade estavel).
    const before = graphicalRuntimeProperties({ bindSource: "cmp-42" }, readouts({ "cmp-42": 7 }));
    const afterRename = graphicalRuntimeProperties({ bindSource: "cmp-42" }, readouts({ "cmp-42": 7 }));
    assert(before.__g_value === 7 && afterRename.__g_value === 7, "renomear rotulo nao muda o id resolvido");
  });

  await test("formatacao: casas decimais e unidade", () => {
    assert(formatGraphicalValue(12.3456, 2, "%") === "12.35 %", "arredonda e concatena a unidade");
    assert(formatGraphicalValue(12.3456, 0, "") === "12", "sem unidade nao deixa espaco sobrando");
    assert(formatGraphicalValue(Number.NaN, 1, "kPa") === "-- kPa", "valor invalido vira tracos, nunca 'NaN' na tela");
    assert(graphicalRuntimeProperties({ value: 5, bindDecimals: 3, bindUnit: "m3/h" }, none).__g_text === "5.000 m3/h", "texto do binding usa as mesmas regras");
  });

  await test("propriedade numerica que chega como string (campo de texto do Inspector) e aceita", () => {
    const out = graphicalRuntimeProperties({ value: "80" as unknown as number, bindMax: "200" as unknown as number }, none);
    assert(out.__g_value === 80, "valor numerico em string deveria ser aceito");
    assert(out.__g_pct === 40, `80 de 0..200 e 40 %, veio ${out.__g_pct}`);
  });

  await test("prefixo graphics. e o contrato de quem recebe projecao de runtime", () => {
    assert(isGraphicalTypeId("graphics.hmi.tank"), "simbolo da biblioteca");
    assert(isGraphicalTypeId("graphics.rectangle"), "forma basica legada tambem");
    assert(!isGraphicalTypeId("passive.resistor"), "componente eletrico nao");
    assert(!isGraphicalTypeId("control.pid"), "bloco de controle nao -- ele e FONTE, nao projecao");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
