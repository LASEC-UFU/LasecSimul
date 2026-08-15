// Carrega o DLL/SO REAL compilado de devices/example-blinker (não vtable sintética como em
// PluginLoaderTest.cpp) através do PluginLoader de produção, publica no GlobalPluginCache e
// confirma que uma SimulationSession real passa a conhecer o typeId via registerKnownPluginTypes().
//
// Não chama session.addComponent("example.blinker", ...) de propósito: PluginRuntime::createDeviceInstance
// hoje chama vt->create(nullptr, nullptr) (ver PluginRuntime.cpp) — o host_ctx/LsdnHostApi real que
// ligaria pin_declare/pin_write ao Netlist/Scheduler desta sessão ainda não existe (lacuna conhecida
// e documentada, ver .spec/archive/legacy-v2/lasecsimul.spec, seção 6, e docs/mvp-limitacoes.md). lib.c do blinker
// desreferencia esse `api` em init() — instanciar de fato derrubaria o processo. Este teste valida
// exatamente o que está pronto hoje: carregar e registrar um binário nativo real, não instanciá-lo
// num circuito.
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;

namespace {

int failures = 0;

#define TEST_ASSERT(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

} // namespace

int main() {
    std::fprintf(stderr, "=== PluginLoaderRealDllTest ===\n");

#ifndef EXAMPLE_BLINKER_DLL_PATH
#error "EXAMPLE_BLINKER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do device.dll real)"
#endif
    const std::filesystem::path dllPath = EXAMPLE_BLINKER_DLL_PATH;

    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr,
                      "PULADO: %s não existe -- rode 'npm run build:devices' antes deste teste "
                      "(devices/example-blinker é um projeto CMake separado do Core).\n",
                      dllPath.string().c_str());
        return 0;
    }

    GlobalPluginCache cache;

    std::shared_ptr<PluginModule> module;
    try {
        module = cache.loader().loadDevicePlugin(dllPath);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: loadDevicePlugin lançou: %s\n", e.what());
        return 1;
    }

    TEST_ASSERT(module != nullptr, "loadDevicePlugin devolve um PluginModule real");
    TEST_ASSERT(module->kind() == PluginKind::Device, "módulo carregado é do tipo Device");

    const LsdnDeviceVTable* vt = module->deviceVTable();
    TEST_ASSERT(vt != nullptr, "vtable real exposta pelo binário");
    if (vt) {
        TEST_ASSERT(vt->create != nullptr, "vtable real: create() resolvido");
        TEST_ASSERT(vt->init != nullptr, "vtable real: init() resolvido");
        TEST_ASSERT(vt->stamp != nullptr, "vtable real: stamp() resolvido");
        TEST_ASSERT(vt->post_step != nullptr, "vtable real: post_step() resolvido");
        TEST_ASSERT(vt->destroy != nullptr, "vtable real: destroy() resolvido");
    }

    cache.setActiveDeviceModule("example.blinker", module);
    TEST_ASSERT(cache.activeDeviceModule("example.blinker") == module,
                "GlobalPluginCache publica o módulo ativo para o typeId");

    SimulationSession session(cache);
    session.registerKnownPluginTypes();
    const auto knownTypes = cache.knownDeviceTypeIds();
    const bool hasBlinker = std::find(knownTypes.begin(), knownTypes.end(), "example.blinker") != knownTypes.end();
    TEST_ASSERT(hasBlinker, "knownDeviceTypeIds() inclui example.blinker após carregar o plugin real");

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
