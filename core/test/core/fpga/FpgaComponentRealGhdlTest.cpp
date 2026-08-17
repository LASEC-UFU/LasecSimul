// Passo 5 do plano FPGA/VHDL (golden-puzzling-quasar.md): prova de ponta a ponta de VERDADE --
// SimulationSession + Scheduler reais, componentes eletricos built-in reais (Clock/Rail) fiados a
// um FpgaComponent real, rodando GHDL de verdade via TimeStepCommitFn. Isto e o que os Casos A
// (combinacional) e B (sequencial, clock real) do plano pedem. Mesma convencao de self-skip das
// outras rodadas reais.
#include "components/sources/Clock.hpp"
#include "components/sources/Rail.hpp"
#include "fpga/FpgaComponent.hpp"
#include "fpga/GhdlBackend.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace lasecsimul;
using namespace lasecsimul::fpga;
namespace fs = std::filesystem;

#define TEST_CHECK(expr)                                                                                             \
    do {                                                                                                             \
        if (!(expr)) throw std::runtime_error(std::string("check failed: ") + #expr + " (line " + std::to_string(__LINE__) + ")"); \
    } while (false)

namespace {

std::string uniqueSuffix() {
    return std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

#if defined(_WIN32)
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/win-x64/lasecsimul_vpi.dll";
#elif defined(__APPLE__)
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/macos-universal/liblasecsimul_vpi.dylib";
#else
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/linux-x64/liblasecsimul_vpi.so";
#endif

bool ghdlAvailable() {
    fpga::GhdlProcessManager probe;
    try {
        probe.start(fpga::GhdlLaunchSpec{"ghdl", {"--version"}, {}, {}, {}});
    } catch (const std::exception&) {
        return false;
    }
    const std::optional<int> exitCode = probe.waitForExit(std::chrono::seconds(3));
    if (!exitCode) {
        probe.kill();
        return false;
    }
    return probe.logs().find("GHDL") != std::string::npos;
}

void registerCommon(registry::ComponentRegistry& reg) {
    reg.registerFactory("sources.rail", [](const registry::ComponentParams& p) {
        return std::make_unique<components::Rail>(Pin{"out"}, p.property("voltage", 0.0));
    });
}

void testCombinationalAndSequentialAgainstRealScheduler(const std::string& vpiModulePath) {
    const fs::path workDir = fs::temp_directory_path() / ("lasecsimul-fpga-component-" + uniqueSuffix());
    const fs::path cacheDir = workDir / "cache";
    const fs::path vhdlFile = workDir / "component_test.vhd";
    fs::create_directories(workDir);
    {
        // Um único entity cobrindo os dois casos de aceite do plano: `led_and` é combinacional
        // (Caso A), `count` é um contador de 4 bits avançado por um clock REAL do Scheduler
        // (Caso B) -- um compile só, dois comportamentos verificados.
        std::ofstream out(vhdlFile);
        out << "library ieee;\n"
               "use ieee.std_logic_1164.all;\n"
               "use ieee.numeric_std.all;\n"
               "entity component_test is\n"
               "    port (\n"
               "        clk     : in  std_logic;\n"
               "        sw0     : in  std_logic;\n"
               "        sw1     : in  std_logic;\n"
               "        led_and : out std_logic;\n"
               "        count   : out std_logic_vector(3 downto 0)\n"
               "    );\n"
               "end entity;\n"
               "architecture rtl of component_test is\n"
               "    signal counter : unsigned(3 downto 0) := (others => '0');\n"
               "begin\n"
               "    led_and <= sw0 and sw1;\n"
               "    process(clk)\n"
               "    begin\n"
               "        if rising_edge(clk) then\n"
               "            counter <= counter + 1;\n"
               "        end if;\n"
               "    end process;\n"
               "    count <= std_logic_vector(counter);\n"
               "end architecture;\n";
    }

    plugins::GlobalPluginCache cache;
    session::SimulationSession session(cache);
    registerCommon(session.components());

    session.components().registerFactory("sources.clock", [&session](const registry::ComponentParams&) {
        return std::make_unique<components::Clock>(session.scheduler(), Pin{"out"}, 3.3, 1'000'000.0, true);
    });

    // ComponentRegistry::Factory só recebe ComponentParams -- neste teste direto (sem IPC, mesma
    // convenção de bus_test.cpp/simulide_sources_meters_test.cpp) o caminho do VHDL/top/standard
    // são fechados por referência no lambda em vez de passados via properties (produção real usa
    // os campos estruturados de ComponentParams, Step 6 -- fora de escopo aqui). `compile()`+
    // `start()` acontecem AQUI DENTRO, antes de devolver a instância, e `fpgaComponentPtr` é
    // capturado pra o corpo do teste conseguir logs/controller sem precisar de um accessor que
    // SimulationSession não expõe publicamente.
    FpgaComponent* fpgaComponentPtr = nullptr;
    session.components().registerFactory(
        "digital.generic_fpga", [&session, &vpiModulePath, &cacheDir, &vhdlFile, &fpgaComponentPtr](
                                    const registry::ComponentParams&) {
            FpgaComponentConfig config;
            config.ports = {
                PortSpec{"clk", true, 1, true},      PortSpec{"sw0", true, 1, true}, PortSpec{"sw1", true, 1, true},
                PortSpec{"led_and", false, 1, true}, PortSpec{"count", false, 4, true},
            };
            config.sources = {vhdlFile.string()};
            config.topEntity = "component_test";
            config.standard = "08";
            config.vcc = 3.3;

            GhdlBackendOptions options;
            options.ghdlBinary = "ghdl";
            options.vpiModulePath = vpiModulePath;
            options.cacheRootDir = cacheDir.string();
            auto backend = std::make_unique<GhdlBackend>(options);

            auto component = std::make_unique<FpgaComponent>(session.scheduler(), std::move(backend), config);
            fpgaComponentPtr = component.get();
            component->start(); // lança se compile() falhar -- propaga por addComponent()

            return component;
        });

    const uint32_t fpga = session.addComponent("digital.generic_fpga", {});
    TEST_CHECK(fpgaComponentPtr != nullptr);
    FpgaComponent& fpgaComponent = *fpgaComponentPtr;

    registry::ComponentParams railHigh;
    railHigh.properties["voltage"] = 3.3;
    const uint32_t clock = session.addComponent("sources.clock", {});
    const uint32_t sw0 = session.addComponent("sources.rail", railHigh);
    const uint32_t sw1 = session.addComponent("sources.rail", railHigh);

    session.connectWire(clock, "out", fpga, "clk");
    session.connectWire(sw0, "out", fpga, "sw0");
    session.connectWire(sw1, "out", fpga, "sw1");
    // Sem componente Ground: todo pino aqui (Clock/Rail/FpgaComponent) crava via
    // addConductanceToGround/addCurrentToGround, já referenciado à terra global diretamente --
    // não existe malha de dois terminais precisando de um retorno físico explícito neste circuito
    // (diferente do teste de bateria+resistor em simulide_sources_meters_test.cpp).

    try {
        // Assenta a rodada inicial (aplica sw0/sw1 no FPGA, delta cycle resolve led_and) --
        // Caso A: combinacional, sw0=sw1=3.3V (One) -> led_and deveria virar One.
        for (int i = 0; i < 20 && session.settleStep(); ++i) {
        }
        session.scheduler().runUntil(1); // primeiro avanco real de tempo -- dispara advanceLockstep

        const double ledVoltage = session.nodeVoltageOfPin(fpga, "led_and");
        TEST_CHECK(ledVoltage > 1.65); // > metade de 3.3V -- lido como One
        std::printf("OK: Caso A (combinacional) -- sw0=sw1=3.3V produz led_and alto via Scheduler real\n");

        // Caso B: contador avancando por clock REAL do Scheduler (1MHz, half-period=500ns) --
        // roda tempo suficiente pra varias bordas de subida, confere que o contador saiu de zero.
        session.scheduler().runUntil(5500); // 5.5 periodos -- pelo menos 5 bordas de subida
        for (int i = 0; i < 20 && session.settleStep(); ++i) {
        }

        double countValue = 0.0;
        for (int bit = 0; bit < 4; ++bit) {
            const std::string pinId = "count(" + std::to_string(bit) + ")";
            const double bitVoltage = session.nodeVoltageOfPin(fpga, pinId);
            if (bitVoltage > 1.65) countValue += (1 << bit);
        }
        TEST_CHECK(countValue > 0.0);
        std::printf("OK: Caso B (sequencial) -- contador avancou via clock real do Scheduler (count=%.0f)\n", countValue);
    } catch (const std::exception& e) {
        const std::string logs = fpgaComponent.controller().logs();
        fpgaComponent.stop();
        throw std::runtime_error(std::string(e.what()) + "\n--- logs do processo GHDL ---\n" + logs);
    }

    fpgaComponent.stop();
    std::error_code ec;
    fs::remove_all(workDir, ec);
}

/** Duas instâncias `digital.generic_fpga` compilando a MESMA entity/fontes/cacheRootDir ao mesmo
 * tempo -- a segunda instância bate cache (Cache vNext, `.spec/features/fpga-ghdl.md`), e por isso
 * `start()` das duas precisa materializar diretórios de execução PRÓPRIOS a partir da MESMA entrada
 * publicada (`GhdlBackend::materializeRunDir`) -- sem isso, os dois processos GHDL disputariam os
 * mesmos arquivos `work-obj08.cf`/artefatos de biblioteca no mesmo diretório de trabalho. Prova que
 * as duas rodam de forma independente (entradas diferentes -> saídas diferentes, cada uma
 * observada só na sua própria instância) e que `stop()` de uma não afeta a outra. */
void testMultipleFpgaInstancesOfSameCompilation(const std::string& vpiModulePath) {
    const fs::path workDir = fs::temp_directory_path() / ("lasecsimul-fpga-multi-" + uniqueSuffix());
    const fs::path cacheDir = workDir / "cache"; // MESMO cacheRootDir pras duas instâncias -- de propósito
    const fs::path vhdlFile = workDir / "multi_test.vhd";
    fs::create_directories(workDir);
    {
        std::ofstream out(vhdlFile);
        out << "library ieee;\n"
               "use ieee.std_logic_1164.all;\n"
               "entity multi_test is\n"
               "    port (a : in std_logic; y : out std_logic);\n"
               "end entity;\n"
               "architecture rtl of multi_test is\n"
               "begin\n"
               "    y <= a;\n"
               "end architecture;\n";
    }

    plugins::GlobalPluginCache cache;
    session::SimulationSession session(cache);

    std::vector<FpgaComponent*> instances;
    session.components().registerFactory(
        "digital.generic_fpga", [&session, &vpiModulePath, &cacheDir, &vhdlFile, &instances](const registry::ComponentParams&) {
            FpgaComponentConfig config;
            config.ports = {PortSpec{"a", true, 1, true}, PortSpec{"y", false, 1, true}};
            config.sources = {vhdlFile.string()};
            config.topEntity = "multi_test";
            config.standard = "08";
            config.vcc = 3.3;

            GhdlBackendOptions options;
            options.ghdlBinary = "ghdl";
            options.vpiModulePath = vpiModulePath;
            options.cacheRootDir = cacheDir.string(); // MESMO cache pras duas -- ver comentário acima
            auto backend = std::make_unique<GhdlBackend>(options);

            auto component = std::make_unique<FpgaComponent>(session.scheduler(), std::move(backend), config);
            instances.push_back(component.get());
            component->start(); // 1a: cache miss (compila de verdade); 2a: cache hit (ver Cache vNext)
            return component;
        });

    const uint32_t fpgaA = session.addComponent("digital.generic_fpga", {});
    const uint32_t fpgaB = session.addComponent("digital.generic_fpga", {});
    TEST_CHECK(instances.size() == 2);

    registry::ComponentParams railHigh, railLow;
    railHigh.properties["voltage"] = 3.3;
    railLow.properties["voltage"] = 0.0;
    registerCommon(session.components());
    const uint32_t sourceHigh = session.addComponent("sources.rail", railHigh);
    const uint32_t sourceLow = session.addComponent("sources.rail", railLow);

    // Entradas DIFERENTES pras duas instâncias -- se elas estivessem compartilhando estado por
    // engano (arena/processo cruzado), as saídas colidiriam.
    session.connectWire(sourceHigh, "out", fpgaA, "a");
    session.connectWire(sourceLow, "out", fpgaB, "a");

    try {
        for (int i = 0; i < 20 && session.settleStep(); ++i) {
        }
        session.scheduler().runUntil(1);
        for (int i = 0; i < 20 && session.settleStep(); ++i) {
        }

        const double yA = session.nodeVoltageOfPin(fpgaA, "y");
        const double yB = session.nodeVoltageOfPin(fpgaB, "y");
        TEST_CHECK(yA > 1.65); // a=1 -> y=1
        TEST_CHECK(yB < 1.65); // a=0 -> y=0
        std::printf("OK: duas instancias FPGA da MESMA compilacao (cache vNext) rodam de forma independente\n");
    } catch (const std::exception& e) {
        const std::string logsA = instances[0]->controller().logs();
        const std::string logsB = instances[1]->controller().logs();
        instances[0]->stop();
        instances[1]->stop();
        throw std::runtime_error(std::string(e.what()) + "\n--- logs A ---\n" + logsA + "\n--- logs B ---\n" + logsB);
    }

    // stop() de UMA não pode afetar a outra -- confere que B continua respondendo depois de A parar.
    instances[0]->stop();
    TEST_CHECK(!instances[0]->controller().isRunning());
    TEST_CHECK(instances[1]->controller().isRunning());
    session.stopSimulation();
    TEST_CHECK(!instances[1]->controller().isRunning());
    std::printf("OK: stop() de uma instancia nao afeta a outra; Stop global encerra a remanescente\n");

    std::error_code ec;
    fs::remove_all(workDir, ec);
}

} // namespace

int main() {
    if (!ghdlAvailable()) {
        std::printf("PULADO: GHDL nao encontrado no PATH -- ver docs/fpga-vhdl.md pra instalar.\n");
        return 0;
    }

    const fs::path repoRoot = fs::path(__FILE__).parent_path().parent_path().parent_path().parent_path().parent_path();
    const fs::path vpiModule = fs::path(repoRoot.string() + kVpiModuleRelativePath);
    if (!fs::exists(vpiModule)) {
        std::printf("PULADO: modulo VPI nao encontrado em %s -- rode 'npm run build:fpga-vpi' primeiro.\n",
                   vpiModule.string().c_str());
        return 0;
    }

    try {
        testCombinationalAndSequentialAgainstRealScheduler(vpiModule.string());
        testMultipleFpgaInstancesOfSameCompilation(vpiModule.string());
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: %s\n", e.what());
        return 1;
    }

    std::printf("\nOK: FpgaComponent + Scheduler real + GHDL real (Casos A e B) passou.\n");
    return 0;
}
