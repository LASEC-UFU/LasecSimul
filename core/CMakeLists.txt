cmake_minimum_required(VERSION 3.20)
project(LasecSimulCore CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(MSVC)
    add_compile_options(/EHsc)
endif()

# GIT_SHALLOW TRUE em todas as dependências via FetchContent: GIT_TAG já fixa um commit exato, então
# o histórico completo do repositório nunca é necessário -- só o objeto da tag. Sem isso, o primeiro
# configure clona o repositório inteiro (anos de histórico do Eigen/nlohmann-json), o que pode demorar
# muito mais do que o checkout do conteúdo em si, especialmente em rede lenta ou disco sincronizado
# (ex: pasta dentro de um cliente de sync de nuvem). Ver agent-01-estrutura-repositorio.md, risco
# "CMake dependente de path absoluto" (este item é o equivalente para tempo de configure).
#
# Mesmo com GIT_SHALLOW, buildar com -B dentro de uma pasta sincronizada por nuvem (Google Drive,
# OneDrive, Dropbox) ainda pode falhar: o gerador Ninja Multi-Config entra em loop de "manifest
# still dirty after 100 tries" e o FetchContent pode dar erro de acesso negado/recurso ocupado ao
# popular milhares de arquivos novos (ex: árvore de teste do Eigen) enquanto o cliente de sync está
# indexando-os. Contorno verificado: apontar -B para um caminho fora da pasta sincronizada (o
# código-fonte em -S pode continuar lá) e usar o gerador Visual Studio (preset "windows-msvc" em
# CMakePresets.json) em vez de Ninja nesse cenário. Ver docs/mvp-limitacoes.md.
#
# Eigen: header-only, MPL2, sem GUI -- usado só pelo MnaSolver/CircuitGroup (LU densa com
# pivoteamento). Ver .spec/lasecsimul.spec, RNF05 e secao 7.1.
include(FetchContent)
FetchContent_Declare(
    eigen
    GIT_REPOSITORY https://gitlab.com/libeigen/eigen.git
    GIT_TAG 3.4.0
    GIT_SHALLOW TRUE
)
set(EIGEN_BUILD_DOC OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(eigen)

# nlohmann/json: header-only, MIT -- usado pelo IpcServer para parse/serialização JSON.
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
    GIT_SHALLOW TRUE
)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
set(JSON_Install OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(nlohmann_json)

set(CORE_SOURCES
    src/main.cpp
    src/app/CoreApplication.cpp
    src/ipc/IpcServer.cpp
    src/plugins/PluginModule.cpp
    src/plugins/PluginLoader.cpp
    src/plugins/PluginRuntime.cpp
    src/plugins/NativeDeviceProxy.cpp
    src/plugins/NativeMcuAdapterProxy.cpp
    src/plugins/CrashGuard.cpp
    src/mcu/qemu/FirmwareWatcher.cpp
    src/mcu/qemu/QemuArenaBridge.cpp
    src/mcu/qemu/QemuProcessManager.cpp
    src/mcu/McuController.cpp
    src/mcu/McuComponent.cpp
    src/simulation/Scheduler.cpp
    src/session/SimulationSession.cpp
    src/session/PauseExpression.cpp
)

add_executable(lasecsimul-core ${CORE_SOURCES})
target_include_directories(lasecsimul-core PRIVATE include src)
target_link_libraries(lasecsimul-core PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)

if(WIN32)
    target_compile_definitions(lasecsimul-core PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
    target_link_libraries(lasecsimul-core PRIVATE dl)
endif()

# ── Testes ──────────────────────────────────────────────────────────────────────
enable_testing()

add_executable(pause_expression_test test/pause_expression_test.cpp src/session/PauseExpression.cpp)
target_include_directories(pause_expression_test PRIVATE include src)
add_test(NAME pause_expression COMMAND pause_expression_test)

add_executable(logic_analyzer_vector_test test/logic_analyzer_vector_test.cpp src/simulation/Scheduler.cpp)
target_include_directories(logic_analyzer_vector_test PRIVATE include src)
target_link_libraries(logic_analyzer_vector_test PRIVATE nlohmann_json::nlohmann_json)
add_test(NAME logic_analyzer_vector COMMAND logic_analyzer_vector_test)

set(TEST_COMMON_SOURCES
    src/app/CoreApplication.cpp
    src/ipc/IpcServer.cpp
    src/plugins/PluginModule.cpp
    src/plugins/PluginLoader.cpp
    src/plugins/PluginRuntime.cpp
    src/plugins/NativeDeviceProxy.cpp
    src/plugins/NativeMcuAdapterProxy.cpp
    src/plugins/CrashGuard.cpp
    src/mcu/qemu/FirmwareWatcher.cpp
    src/mcu/qemu/QemuArenaBridge.cpp
    src/mcu/qemu/QemuProcessManager.cpp
    src/mcu/McuController.cpp
    src/mcu/McuComponent.cpp
    src/simulation/Scheduler.cpp
    src/session/SimulationSession.cpp
    src/session/PauseExpression.cpp
)

# Teste de divisor de tensão (existente)
add_executable(voltage_divider_test
    test/voltage_divider_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(voltage_divider_test PRIVATE include src)
target_link_libraries(voltage_divider_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(voltage_divider_test PRIVATE dl)
endif()
add_test(NAME voltage_divider COMMAND voltage_divider_test)

# Reaproveitamento de CircuitGroup entre rebuilds de topologia (.spec seção 25.5)
add_executable(circuit_group_reuse_test
    test/circuit_group_reuse_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(circuit_group_reuse_test PRIVATE include src)
target_link_libraries(circuit_group_reuse_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(circuit_group_reuse_test PRIVATE dl)
endif()
add_test(NAME circuit_group_reuse COMMAND circuit_group_reuse_test)

# Primeiro componente não linear real (Épico H do roadmap de pendências)
add_executable(diode_test
    test/diode_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(diode_test PRIVATE include src)
target_link_libraries(diode_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(diode_test PRIVATE dl)
endif()
add_test(NAME diode COMMAND diode_test)

# Ruptura reversa (zener) e LED reaproveitando a mesma classe Diode (Convergência não-linear real)
add_executable(zener_led_test
    test/zener_led_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(zener_led_test PRIVATE include src)
target_link_libraries(zener_led_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(zener_led_test PRIVATE dl)
endif()
add_test(NAME zener_led COMMAND zener_led_test)

# Regressão dos 11 componentes eletricamente inertes achados na auditoria "pente fino" 2026-07-08
add_executable(inert_components_fix_test
    test/inert_components_fix_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(inert_components_fix_test PRIVATE include src)
target_link_libraries(inert_components_fix_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(inert_components_fix_test PRIVATE dl)
endif()
add_test(NAME inert_components_fix COMMAND inert_components_fix_test)

# "Pause at state change" do Probe -- achado de auditoria de UI 2026-07-09
add_executable(probe_pause_on_change_test
    test/probe_pause_on_change_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(probe_pause_on_change_test PRIVATE include src)
target_link_libraries(probe_pause_on_change_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(probe_pause_on_change_test PRIVATE dl)
endif()
add_test(NAME probe_pause_on_change COMMAND probe_pause_on_change_test)

# Subcircuitos (Épico F do roadmap de pendências)
add_executable(subcircuit_test
    test/subcircuit_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(subcircuit_test PRIVATE include src)
target_link_libraries(subcircuit_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(subcircuit_test PRIVATE dl)
endif()
add_test(NAME subcircuit COMMAND subcircuit_test)

# Componentes "Fontes"/"Medidores" portados do SimulIDE
add_executable(simulide_sources_meters_test
    test/simulide_sources_meters_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(simulide_sources_meters_test PRIVATE include src)
target_link_libraries(simulide_sources_meters_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(simulide_sources_meters_test PRIVATE dl)
endif()
add_test(NAME simulide_sources_meters COMMAND simulide_sources_meters_test)

# Voltímetro built-in: alta impedância, leitura V(+)−V(−), getState() = 1 double
add_executable(voltmeter_test
    test/voltmeter_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(voltmeter_test PRIVATE include src)
target_link_libraries(voltmeter_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(voltmeter_test PRIVATE dl)
endif()
add_test(NAME voltmeter COMMAND voltmeter_test)

# Teste de remoção de componente (mvp-limitacoes.md: remoção de instância no Core)
add_executable(component_removal_test
    test/component_removal_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(component_removal_test PRIVATE include src)
target_link_libraries(component_removal_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(component_removal_test PRIVATE dl)
endif()
add_test(NAME component_removal COMMAND component_removal_test)

# Testes do Agente 05: Netlist e UnionFind
add_executable(netlist_test ../test/core/simulation/NetlistTest.cpp)
target_include_directories(netlist_test PRIVATE include src)
target_link_libraries(netlist_test PRIVATE Eigen3::Eigen)
add_test(NAME netlist COMMAND netlist_test)

add_executable(union_find_test ../test/core/simulation/UnionFindTest.cpp)
target_include_directories(union_find_test PRIVATE include src)
add_test(NAME union_find COMMAND union_find_test)

# Testes do Agente 06: Scheduler e SparseSet
add_executable(scheduler_test ../test/core/simulation/SchedulerTest.cpp src/simulation/Scheduler.cpp)
target_include_directories(scheduler_test PRIVATE include src)
add_test(NAME scheduler COMMAND scheduler_test)

add_executable(sparse_set_test ../test/core/simulation/SparseSetTest.cpp)
target_include_directories(sparse_set_test PRIVATE include src)
add_test(NAME sparse_set COMMAND sparse_set_test)

# Teste de bootstrap do Core (agente 04)
add_executable(core_bootstrap_test
    test/core/CoreBootstrapTest.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(core_bootstrap_test PRIVATE include src)
target_link_libraries(core_bootstrap_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
target_compile_definitions(core_bootstrap_test PRIVATE
    DEVICES_LIBRARY_JSON_PATH="${CMAKE_CURRENT_SOURCE_DIR}/test/fixtures/bootstrap-test-library.json"
)
if(NOT WIN32)
    target_link_libraries(core_bootstrap_test PRIVATE dl pthread)
else()
    target_compile_definitions(core_bootstrap_test PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
add_test(NAME core_bootstrap COMMAND core_bootstrap_test)

# Testes do Agente 07: MNA, grupos e cache de stamps
add_executable(circuit_group_test
    test/core/simulation/CircuitGroupTest.cpp
)
target_include_directories(circuit_group_test PRIVATE include src)
target_link_libraries(circuit_group_test PRIVATE Eigen3::Eigen)
add_test(NAME circuit_group COMMAND circuit_group_test)

add_executable(mna_solver_test
    test/core/simulation/MnaSolverTest.cpp
)
target_include_directories(mna_solver_test PRIVATE include src)
target_link_libraries(mna_solver_test PRIVATE Eigen3::Eigen)
add_test(NAME mna_solver COMMAND mna_solver_test)

# SHA-256 autocontido (achado de auditoria arquitetural 2026-07-09: verifyChecksum() de
# PluginLoader era um stub sempre-true; contra vetores oficiais NIST antes de confiar nele).
add_executable(sha256_test test/sha256_test.cpp)
target_include_directories(sha256_test PRIVATE include src)
add_test(NAME sha256 COMMAND sha256_test)

# Teste dos passivos built-in (Agente 08)
add_executable(passive_components_test
    ../test/core/components/PassiveComponentsTest.cpp
)
target_include_directories(passive_components_test PRIVATE include src)
target_link_libraries(passive_components_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
add_test(NAME passive_components COMMAND passive_components_test)

add_executable(transient_rc_test
    test/transient_rc_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(transient_rc_test PRIVATE include src)
target_link_libraries(transient_rc_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(transient_rc_test PRIVATE dl)
endif()
add_test(NAME transient_rc COMMAND transient_rc_test)
add_executable(transient_rlc_test test/transient_rlc_test.cpp ${TEST_COMMON_SOURCES})
target_include_directories(transient_rlc_test PRIVATE include src)
target_link_libraries(transient_rlc_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(transient_rlc_test PRIVATE dl)
endif()
add_test(NAME transient_rlc COMMAND transient_rlc_test)

add_executable(solver_benchmark benchmark/solver_benchmark.cpp)
target_include_directories(solver_benchmark PRIVATE include src)
target_link_libraries(solver_benchmark PRIVATE Eigen3::Eigen)
add_executable(transient_benchmark benchmark/transient_benchmark.cpp ${TEST_COMMON_SOURCES})
target_include_directories(transient_benchmark PRIVATE include src)
target_link_libraries(transient_benchmark PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(transient_benchmark PRIVATE dl)
endif()
add_executable(simulation_performance_benchmark benchmark/simulation_performance_benchmark.cpp ${TEST_COMMON_SOURCES})
target_include_directories(simulation_performance_benchmark PRIVATE include src)
target_link_libraries(simulation_performance_benchmark PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(simulation_performance_benchmark PRIVATE dl)
endif()
add_test(NAME simulation_performance_smoke
         COMMAND simulation_performance_benchmark --sim-ns 10000000 --scale 1 --digital-hz 10000 --require-realtime)

# PropertyDefinition/validatePropertyValue/propertyOrDefault (auditoria arquitetural 2026-07-09,
# Fase 1.4/2.1) -- Probe e Resistor migrados como demonstração; prova que get/set casam por ID, não
# por índice (fecha D1/D2), e que construção a partir de ComponentParams agora valida (fecha D4).
add_executable(property_definition_test
    test/property_definition_test.cpp
    src/simulation/Scheduler.cpp
)
target_include_directories(property_definition_test PRIVATE include src)
target_link_libraries(property_definition_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
add_test(NAME property_definition COMMAND property_definition_test)

# Pino dinâmico (rows/columns de switches.keypad/outputs.led_matrix/led_bar, canais de
# active.analog_mux) -- resolveDynamicPins puro, SimulidePassiveState com ComponentPinSpec, e
# integração ponta a ponta via SimulationSession::addComponent/setProperty + Netlist real.
add_executable(dynamic_pins_test
    ../test/core/components/DynamicPinsTest.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(dynamic_pins_test PRIVATE include src)
target_link_libraries(dynamic_pins_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(dynamic_pins_test PRIVATE dl)
endif()
add_test(NAME dynamic_pins COMMAND dynamic_pins_test)

# Teste dos componentes de lógica built-in (catálogo: logic.button)
add_executable(logic_components_test
    ../test/core/components/LogicComponentsTest.cpp
)
target_include_directories(logic_components_test PRIVATE include src)
target_link_libraries(logic_components_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
add_test(NAME logic_components COMMAND logic_components_test)

# Testes de plugins nativos (Agente 13)
add_executable(plugin_loader_test
    test/core/plugins/PluginLoaderTest.cpp
    src/plugins/PluginModule.cpp
    src/plugins/PluginLoader.cpp
)
target_include_directories(plugin_loader_test PRIVATE include src)
target_link_libraries(plugin_loader_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(plugin_loader_test PRIVATE dl)
endif()
add_test(NAME plugin_loader COMMAND plugin_loader_test)

# Carrega o DLL/SO REAL de devices/example-blinker (não vtable sintética) -- requer
# 'npm run build:devices' antes; o teste pula (exit 0) se o artefato ainda não existir.
add_executable(plugin_loader_real_dll_test
    ../test/core/plugins/PluginLoaderRealDllTest.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(plugin_loader_real_dll_test PRIVATE include src)
target_link_libraries(plugin_loader_real_dll_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(WIN32)
    set(EXAMPLE_BLINKER_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../devices/example-blinker/build/win-x64/device.dll")
elseif(APPLE)
    set(EXAMPLE_BLINKER_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../devices/example-blinker/build/macos-universal/device.dylib")
else()
    set(EXAMPLE_BLINKER_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../devices/example-blinker/build/linux-x64/device.so")
endif()
target_compile_definitions(plugin_loader_real_dll_test PRIVATE
    EXAMPLE_BLINKER_DLL_PATH="${EXAMPLE_BLINKER_ARTIFACT}"
)
if(NOT WIN32)
    target_link_libraries(plugin_loader_real_dll_test PRIVATE dl)
endif()
add_test(NAME plugin_loader_real_dll COMMAND plugin_loader_real_dll_test)

# verifyChecksum real (SHA-256) contra os binários REAIS de example-blinker/espressif-esp32 e
# contra devices/library.json + mcu-adapters/library.json de produção -- achado de auditoria
# arquitetural 2026-07-09: nenhum teste existente chamava GlobalPluginCache::loadLibrary() nem
# passava um hash esperado pra loadDevicePlugin/loadMcuPlugin, então essa cobertura não existia.
add_executable(plugin_checksum_test
    test/core/plugins/PluginChecksumTest.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(plugin_checksum_test PRIVATE include src)
target_link_libraries(plugin_checksum_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
target_compile_definitions(plugin_checksum_test PRIVATE
    EXAMPLE_BLINKER_MSVC_DLL_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../devices/example-blinker/build/win-x64/device.dll"
    ESP32_ADAPTER_MSVC_DLL_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../mcu-adapters/espressif-esp32/build/win-x64/adapter.dll"
    REAL_DEVICES_LIBRARY_JSON_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../devices/library.json"
    REAL_MCU_LIBRARY_JSON_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../mcu-adapters/library.json"
)
if(NOT WIN32)
    target_link_libraries(plugin_checksum_test PRIVATE dl)
endif()
add_test(NAME plugin_checksum COMMAND plugin_checksum_test)

# Unicidade global de device ID (plano "single source of truth per device ID"): o mesmo typeId
# declarado por 2 arquivos .lsdevice DIFERENTES deve fazer GlobalPluginCache::loadLibrary lancar,
# nomeando as duas definicoes -- recarregar o MESMO arquivo (idempotente) continua funcionando.
add_executable(plugin_duplicate_device_id_test
    test/core/plugins/PluginDuplicateDeviceIdTest.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(plugin_duplicate_device_id_test PRIVATE include src)
target_link_libraries(plugin_duplicate_device_id_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
target_compile_definitions(plugin_duplicate_device_id_test PRIVATE
    EXAMPLE_BLINKER_MSVC_DLL_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../devices/example-blinker/build/win-x64/device.dll"
)
if(NOT WIN32)
    target_link_libraries(plugin_duplicate_device_id_test PRIVATE dl)
endif()
add_test(NAME plugin_duplicate_device_id COMMAND plugin_duplicate_device_id_test)

add_executable(plugin_runtime_test
    test/core/plugins/PluginRuntimeTest.cpp
    src/plugins/PluginModule.cpp
    src/plugins/PluginLoader.cpp
    src/plugins/PluginRuntime.cpp
    src/plugins/NativeDeviceProxy.cpp
    src/plugins/NativeMcuAdapterProxy.cpp
    src/plugins/CrashGuard.cpp
    src/simulation/Scheduler.cpp
)
target_include_directories(plugin_runtime_test PRIVATE include src)
target_link_libraries(plugin_runtime_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(plugin_runtime_test PRIVATE dl)
endif()
add_test(NAME plugin_runtime COMMAND plugin_runtime_test)

# Resiliência de MCU a crash de plugin (auditoria arquitetural 2026-07-09, Fase 3): prova, com
# vtable sintética que desreferencia ponteiro nulo de propósito, que NativeMcuAdapterProxy/
# QemuModuleProxy agora contêm o crash (CrashGuard/PluginWatchdog) em vez de derrubar o Core --
# mesma proteção que NativeDeviceProxy já tinha, ausente pro lado MCU até esta correção. Só roda de
# verdade no Windows (ver comentário no próprio .cpp); sai com sucesso trivial no POSIX.
add_executable(mcu_crash_resilience_test
    test/core/plugins/McuCrashResilienceTest.cpp
    src/plugins/PluginModule.cpp
    src/plugins/PluginLoader.cpp
    src/plugins/PluginRuntime.cpp
    src/plugins/NativeDeviceProxy.cpp
    src/plugins/NativeMcuAdapterProxy.cpp
    src/plugins/CrashGuard.cpp
    src/simulation/Scheduler.cpp
)
target_include_directories(mcu_crash_resilience_test PRIVATE include src)
target_link_libraries(mcu_crash_resilience_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(mcu_crash_resilience_test PRIVATE dl)
endif()
add_test(NAME mcu_crash_resilience COMMAND mcu_crash_resilience_test)

# Testes da ponte QEMU generica (Agente 11)
add_executable(qemu_process_manager_test
    test/core/mcu/QemuProcessManagerTest.cpp
    src/mcu/qemu/QemuProcessManager.cpp
)
target_include_directories(qemu_process_manager_test PRIVATE include src)
if(WIN32)
    target_compile_definitions(qemu_process_manager_test PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
add_test(NAME qemu_process_manager COMMAND qemu_process_manager_test)

add_executable(mcu_debug_launch_test
    test/core/mcu/McuDebugLaunchTest.cpp
    src/mcu/McuController.cpp
    src/mcu/qemu/QemuProcessManager.cpp
    src/mcu/qemu/QemuArenaBridge.cpp
)
target_include_directories(mcu_debug_launch_test PRIVATE include src)
add_test(NAME mcu_debug_launch COMMAND mcu_debug_launch_test)

add_executable(qemu_arena_bridge_test
    test/core/mcu/QemuArenaBridgeTest.cpp
    src/mcu/qemu/QemuArenaBridge.cpp
)
target_include_directories(qemu_arena_bridge_test PRIVATE include src)
add_test(NAME qemu_arena_bridge COMMAND qemu_arena_bridge_test)

add_executable(firmware_watcher_test
    test/core/mcu/FirmwareWatcherTest.cpp
    src/mcu/qemu/FirmwareWatcher.cpp
)
target_include_directories(firmware_watcher_test PRIVATE include src)
add_test(NAME firmware_watcher COMMAND firmware_watcher_test)

# Teste do adapter ESP32 -- agora via plugin DLL/SO real (mcu_abi.h major 2+), não mais built-in
# (ver mcu-adapters/espressif-esp32/). Carrega o binário real através do PluginLoader de produção,
# mesmo padrão de plugin_loader_real_dll_test para devices.
if(WIN32)
    set(ESP32_ADAPTER_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../mcu-adapters/espressif-esp32/build/win-x64/adapter.dll")
elseif(APPLE)
    set(ESP32_ADAPTER_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../mcu-adapters/espressif-esp32/build/macos-universal/adapter.dylib")
else()
    set(ESP32_ADAPTER_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../mcu-adapters/espressif-esp32/build/linux-x64/adapter.so")
endif()

add_executable(esp32_adapter_test
    test/core/mcu/Esp32AdapterTest.cpp
    src/plugins/PluginModule.cpp
    src/plugins/PluginLoader.cpp
    src/plugins/PluginRuntime.cpp
    src/plugins/NativeDeviceProxy.cpp
    src/plugins/NativeMcuAdapterProxy.cpp
    src/plugins/CrashGuard.cpp
    src/simulation/Scheduler.cpp
)
target_include_directories(esp32_adapter_test PRIVATE include src)
target_link_libraries(esp32_adapter_test PRIVATE nlohmann_json::nlohmann_json)
target_compile_definitions(esp32_adapter_test PRIVATE
    ESP32_ADAPTER_DLL_PATH="${ESP32_ADAPTER_ARTIFACT}"
)
if(NOT WIN32)
    target_link_libraries(esp32_adapter_test PRIVATE dl)
endif()
add_test(NAME esp32_adapter COMMAND esp32_adapter_test)

# Subcircuitos REAIS da ESP32 (não sintéticos) -- prova que os .lssubcircuit reais carregam e
# expandem corretamente contra o plugin ESP32 de verdade (ver mcu-adapters/espressif-esp32/,
# subcircuits/esp32_devkitc_v4.lssubcircuit e subcircuits/esp32_wroom32.lssubcircuit).
add_executable(esp32_devkitc_subcircuit_test
    test/esp32_devkitc_subcircuit_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(esp32_devkitc_subcircuit_test PRIVATE include src)
target_link_libraries(esp32_devkitc_subcircuit_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
target_compile_definitions(esp32_devkitc_subcircuit_test PRIVATE
    ESP32_ADAPTER_DLL_PATH="${ESP32_ADAPTER_ARTIFACT}"
    LSSUB_MANIFEST_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../subcircuits/esp32_devkitc_v4.lssubcircuit"
    WROOM32_LSSUB_MANIFEST_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../subcircuits/esp32_wroom32.lssubcircuit"
)
if(NOT WIN32)
    target_link_libraries(esp32_devkitc_subcircuit_test PRIVATE dl)
endif()
add_test(NAME esp32_devkitc_subcircuit COMMAND esp32_devkitc_subcircuit_test)

add_executable(bus_test test/bus_test.cpp ${TEST_COMMON_SOURCES})
target_include_directories(bus_test PRIVATE include src)
target_link_libraries(bus_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(bus_test PRIVATE dl)
endif()
add_test(NAME bus COMMAND bus_test)

# NAND/NOR/NOT/XNOR via propriedade "inverted" no plugin real (achado de auditoria 2026-07-08) --
# mesmo padrão real-DLL de esp32_devkitc_subcircuit_test, pra devices/simulide-logic/.
if(WIN32)
    set(SIMULIDE_LOGIC_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../devices/simulide-logic/build/win-x64/device.dll")
elseif(APPLE)
    set(SIMULIDE_LOGIC_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../devices/simulide-logic/build/macos-universal/device.dylib")
else()
    set(SIMULIDE_LOGIC_ARTIFACT "${CMAKE_CURRENT_SOURCE_DIR}/../devices/simulide-logic/build/linux-x64/device.so")
endif()
add_executable(logic_gate_plugin_test
    test/logic_gate_plugin_test.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(logic_gate_plugin_test PRIVATE include src)
target_link_libraries(logic_gate_plugin_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
target_compile_definitions(logic_gate_plugin_test PRIVATE
    SIMULIDE_LOGIC_DLL_PATH="${SIMULIDE_LOGIC_ARTIFACT}"
)
if(NOT WIN32)
    target_link_libraries(logic_gate_plugin_test PRIVATE dl)
endif()
add_test(NAME logic_gate_plugin COMMAND logic_gate_plugin_test)

# Orquestrador McuController contra o binário REAL do fork qemu-simulide (não fake) -- pula se o
# binário não existir no caminho esperado (sibling do repositório, ver docs/mvp-limitacoes.md).
# Adapter ESP32 agora vem do plugin real (mesmo binário de esp32_adapter_test acima), não built-in.
add_executable(mcu_controller_real_qemu_test
    test/core/mcu/McuControllerRealQemuTest.cpp
    src/mcu/McuController.cpp
    src/mcu/McuComponent.cpp
    src/mcu/qemu/QemuProcessManager.cpp
    src/mcu/qemu/QemuArenaBridge.cpp
    src/plugins/PluginModule.cpp
    src/plugins/PluginLoader.cpp
    src/plugins/PluginRuntime.cpp
    src/plugins/NativeDeviceProxy.cpp
    src/plugins/NativeMcuAdapterProxy.cpp
    src/plugins/CrashGuard.cpp
    src/simulation/Scheduler.cpp
)
target_include_directories(mcu_controller_real_qemu_test PRIVATE include src)
target_link_libraries(mcu_controller_real_qemu_test PRIVATE nlohmann_json::nlohmann_json)
target_compile_definitions(mcu_controller_real_qemu_test PRIVATE
    QEMU_REAL_BINARY_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../devices/qemu-esp32/bin/qemu-system-xtensa.exe"
    ESP32_ADAPTER_DLL_PATH="${ESP32_ADAPTER_ARTIFACT}"
)
if(WIN32)
    target_compile_definitions(mcu_controller_real_qemu_test PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
    target_link_libraries(mcu_controller_real_qemu_test PRIVATE dl)
endif()
add_test(NAME mcu_controller_real_qemu COMMAND mcu_controller_real_qemu_test)

# McuComponent: ponte registrador<->pino, testada com arena sintética (sem QEMU real/firmware).
add_executable(mcu_component_test
    test/core/mcu/McuComponentTest.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(mcu_component_test PRIVATE include src)
target_link_libraries(mcu_component_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
target_compile_definitions(mcu_component_test PRIVATE
    ESP32_ADAPTER_DLL_PATH="${ESP32_ADAPTER_ARTIFACT}"
)
if(NOT WIN32)
    target_link_libraries(mcu_component_test PRIVATE dl)
endif()
add_test(NAME mcu_component COMMAND mcu_component_test)

# Detecção de borda digital + despacho de ComponentEvent{kPinChangeEventTag} (substitui
# I2cBusModule/SpiBusModule -- removidos por nunca terem sido ligados a um SimulationSession real;
# ver .spec/lasecsimul-native-devices.spec, seção 8, e SimulationSession::settleStep() passo 3b).
add_executable(pin_change_dispatch_test
    test/core/session/PinChangeDispatchTest.cpp
    ${TEST_COMMON_SOURCES}
)
target_include_directories(pin_change_dispatch_test PRIVATE include src)
target_link_libraries(pin_change_dispatch_test PRIVATE Eigen3::Eigen nlohmann_json::nlohmann_json)
if(NOT WIN32)
    target_link_libraries(pin_change_dispatch_test PRIVATE dl)
endif()
add_test(NAME pin_change_dispatch COMMAND pin_change_dispatch_test)

# Watchdog de plugins nativos (Épico D do roadmap de pendências)
add_executable(plugin_watchdog_test test/core/plugins/PluginWatchdogTest.cpp src/plugins/CrashGuard.cpp)
target_include_directories(plugin_watchdog_test PRIVATE include src)
if(NOT WIN32)
    target_link_libraries(plugin_watchdog_test PRIVATE pthread)
endif()
add_test(NAME plugin_watchdog COMMAND plugin_watchdog_test)
