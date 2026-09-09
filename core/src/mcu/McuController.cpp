#include "McuController.hpp"
#include "qemu/VnextBCapacityGuard.hpp"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iomanip>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <thread>

#if defined(_WIN32)
#include <winsock2.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace lasecsimul::mcu {

namespace {

uint32_t fnv1a(std::string_view text) {
    uint32_t hash = 2166136261u;
    for (const unsigned char ch : text) {
        hash ^= ch;
        hash *= 16777619u;
    }
    return hash;
}

std::optional<unsigned> configuredNetworkNamespace() {
    const char* value = std::getenv("LASECSIMUL_NETWORK_NAMESPACE");
    if (!value || !*value) return std::nullopt;
    unsigned parsed = 0;
    const std::string_view text(value);
    const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (result.ec != std::errc{} || result.ptr != text.data() + text.size() || parsed > 255) {
        return std::nullopt;
    }
    return parsed;
}

unsigned componentNetworkSlot(std::string_view arenaName) {
    const size_t separator = arenaName.rfind('-');
    if (separator != std::string_view::npos && separator + 1 < arenaName.size()) {
        unsigned parsed = 0;
        const std::string_view suffix = arenaName.substr(separator + 1);
        const auto result = std::from_chars(suffix.data(), suffix.data() + suffix.size(), parsed);
        if (result.ec == std::errc{} && result.ptr == suffix.data() + suffix.size()) return parsed & 0xffu;
    }
    return fnv1a(arenaName) & 0xffu;
}

unsigned automaticNetworkNamespace(std::string_view arenaName) {
    const size_t separator = arenaName.rfind('-');
    const std::string_view hostPart = separator == std::string_view::npos
        ? arenaName
        : arenaName.substr(0, separator);
    return fnv1a(hostPart) & 0xffu;
}

std::string openEthMacAddress(unsigned networkNamespace, unsigned componentSlot,
                              std::string_view arenaName) {
    const std::string stableIdentity = configuredNetworkNamespace().has_value()
        ? std::to_string(networkNamespace) + ":" + std::to_string(componentSlot)
        : std::string(arenaName);
    const uint32_t identityHash = fnv1a(stableIdentity);
    std::ostringstream mac;
    mac << std::hex << std::setfill('0')
        << "02:4c:" << std::setw(2) << ((identityHash >> 24u) & 0xffu)
        << ':' << std::setw(2) << ((identityHash >> 16u) & 0xffu)
        << ':' << std::setw(2) << ((identityHash >> 8u) & 0xffu)
        << ':' << std::setw(2) << (identityHash & 0xffu);
    return mac.str();
}

std::string isolatedOpenEthArgument(std::string_view arenaName) {
    const unsigned networkNamespace = configuredNetworkNamespace().value_or(
        automaticNetworkNamespace(arenaName));
    const unsigned componentSlot = componentNetworkSlot(arenaName);
    const std::string prefix = "10." + std::to_string(networkNamespace) + "." +
                               std::to_string(componentSlot);
    return "user,model=open_eth,mac=" + openEthMacAddress(networkNamespace, componentSlot, arenaName) +
           ",net=" + prefix + ".0/24,host=" + prefix +
           ".2,dhcpstart=" + prefix + ".15,dns=" + prefix + ".3";
}

std::string environmentValue(const char* name, std::string_view fallback) {
    const char* value = std::getenv(name);
    return value && *value ? std::string(value) : std::string(fallback);
}

unsigned configuredGatewayPort() {
    unsigned gatewayPort = 9011;
    if (const char* configured = std::getenv("LASECSIMUL_GATEWAY_PORT")) {
        unsigned parsed = 0;
        const std::string_view text(configured);
        const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
        if (result.ec == std::errc{} && result.ptr == text.data() + text.size() &&
            parsed > 0 && parsed <= 65535) {
            gatewayPort = parsed;
        }
    }
    return gatewayPort;
}

bool gatewayAcceptingConnections(unsigned port) {
#if defined(_WIN32)
    WSADATA winsock{};
    if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) return false;
    const SOCKET socketHandle = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    const bool socketCreated = socketHandle != INVALID_SOCKET;
#else
    const int socketHandle = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    const bool socketCreated = socketHandle >= 0;
#endif
    if (!socketCreated) {
#if defined(_WIN32)
        WSACleanup();
#endif
        return false;
    }
    sockaddr_in endpoint{};
    endpoint.sin_family = AF_INET;
    endpoint.sin_port = htons(static_cast<uint16_t>(port));
    endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    const bool connected = ::connect(socketHandle, reinterpret_cast<const sockaddr*>(&endpoint),
                                     sizeof(endpoint)) == 0;
#if defined(_WIN32)
    closesocket(socketHandle);
    WSACleanup();
#else
    ::close(socketHandle);
#endif
    return connected;
}

std::string labBridgeOpenEthArgument(std::string_view arenaName) {
    const unsigned networkNamespace = configuredNetworkNamespace().value_or(
        automaticNetworkNamespace(arenaName));
    const unsigned componentSlot = componentNetworkSlot(arenaName);
    const unsigned gatewayPort = configuredGatewayPort();
    return "socket,model=open_eth,mac=" + openEthMacAddress(networkNamespace, componentSlot, arenaName) +
           ",connect=127.0.0.1:" + std::to_string(gatewayPort);
}

void configureNetwork(QemuLaunchSpec& spec, std::string_view arenaName) {
    const std::string mode = environmentValue("LASECSIMUL_NETWORK_MODE", "disabled");
    if (mode != "disabled" && mode != "lab-bridge" && mode != "isolated") {
        throw std::invalid_argument(
            "LASECSIMUL_NETWORK_MODE must be 'disabled', 'lab-bridge' or 'isolated'");
    }

    // Rede e' opt-in. O adapter descreve apenas CPU/maquina/flash; assim um Blink sem rede
    // chega ao QEMU sem -nic, sem OpenETH, sem thread/socket e com o mesmo mapa MMIO do caminho
    // historico. Nao se tenta inferir CONFIG_ETH_USE_OPENETH inspecionando o .bin: esse simbolo
    // de compilacao nao faz parte de uma imagem merged e a heuristica seria instavel.
    if (mode == "disabled") {
        spec.diagnostics += "[LasecSimul] network=disabled; no NIC/backend will be created\n";
        return;
    }

    spec.args.push_back("-nic");
    spec.args.push_back(mode == "lab-bridge" ? labBridgeOpenEthArgument(arenaName)
                                               : isolatedOpenEthArgument(arenaName));
    spec.diagnostics += "[LasecSimul] network=" + mode + "; OpenETH backend enabled\n";
}

void setAccelProperty(QemuLaunchSpec& spec, std::string_view key, std::string value) {
    const std::string prefix = std::string(key) + "=";
    for (size_t index = 0; index + 1 < spec.args.size(); ++index) {
        if (spec.args[index] != "-accel") continue;

        std::string& accel = spec.args[index + 1];
        size_t tokenStart = 0;
        while (tokenStart <= accel.size()) {
            const size_t tokenEnd = accel.find(',', tokenStart);
            const size_t tokenSize = (tokenEnd == std::string::npos ? accel.size() : tokenEnd) - tokenStart;
            if (accel.compare(tokenStart, prefix.size(), prefix) == 0) {
                accel.replace(tokenStart, tokenSize, prefix + value);
                return;
            }
            if (tokenEnd == std::string::npos) break;
            tokenStart = tokenEnd + 1;
        }
        accel += "," + prefix + value;
        return;
    }
}

bool accelHasProperty(const QemuLaunchSpec& spec, std::string_view key, std::string_view value) {
    const std::string property = std::string(key) + "=" + std::string(value);
    for (size_t index = 0; index + 1 < spec.args.size(); ++index) {
        if (spec.args[index] != "-accel") continue;
        const std::string& accel = spec.args[index + 1];
        size_t tokenStart = 0;
        while (tokenStart <= accel.size()) {
            const size_t tokenEnd = accel.find(',', tokenStart);
            const size_t tokenSize = (tokenEnd == std::string::npos ? accel.size() : tokenEnd) - tokenStart;
            if (accel.compare(tokenStart, tokenSize, property) == 0) return true;
            if (tokenEnd == std::string::npos) break;
            tokenStart = tokenEnd + 1;
        }
    }
    return false;
}

} // namespace

McuController::McuController(const IMcuAdapter& adapter, std::string qemuBinaryOverride)
    : m_adapter(adapter), m_qemuBinaryOverride(std::move(qemuBinaryOverride)) {
    m_arenaBridge.setMemoryRegions(m_adapter.memoryRegions());
}

QemuLaunchSpec McuController::buildLaunchSpec(const std::filesystem::path& firmwarePath,
                                               const std::string& arenaName,
                                               const std::string& callSiteBinaryOverride,
                                               McuDebugOptions debug,
                                               RuntimeLaunchIdentity identity) const {
    QemuLaunchSpec spec = m_adapter.buildLaunchArgs(firmwarePath.string());
    spec.runtimeIdentity = identity;
    // Test-only host sizing for multi-process scale campaigns. QEMU's tb-size unit is MiB;
    // absent this opt-in the production launch is byte-for-byte unchanged.
    if (const char* tbSize = std::getenv("LASECSIMUL_QEMU_TB_SIZE"); tbSize && *tbSize) {
        char* end = nullptr;
        const long mib = std::strtol(tbSize, &end, 10);
        if (end && *end == '\0' && mib >= 16 && mib <= 1024) {
            setAccelProperty(spec, "tb-size", std::to_string(mib));
        }
    }
    // Host-only TCG scheduling experiment for high session counts. The normal VNEXT launch
    // remains MTTCG; this opt-in serializes each QEMU's vCPUs without changing the wire ABI.
    if (const char* tcgThread = std::getenv("LASECSIMUL_QEMU_TCG_THREAD");
        tcgThread && std::string_view(tcgThread) == "single") {
        setAccelProperty(spec, "thread", "single");
    }
    const bool mttcg = accelHasProperty(spec, "thread", "multi");
    const auto icountArgIt = std::find(spec.args.begin(), spec.args.end(), "-icount");
    const bool icount = icountArgIt != spec.args.end();
    if (mttcg) {
        spec.diagnostics +=
            "[LasecSimul] execution=mttcg-realtime "
            "(default, one TCG thread per vCPU; rollback: "
            "LASECSIMUL_ESP32_EXECUTION_MODE=deterministic)\n";
    } else if (icount) {
        // The shift value sits in the argument right after "-icount" (e.g.
        // "shift=4,align=off,sleep=off"); parse it out for the diagnostic line
        // rather than re-deriving it, since configuredIcountShift() lives in
        // the adapter DLL and isn't directly callable from here.
        std::string shift = "?";
        if (const auto next = std::next(icountArgIt); next != spec.args.end()) {
            const std::string& arg = *next;
            const auto pos = arg.find("shift=");
            if (pos != std::string::npos) {
                const auto start = pos + std::string("shift=").size();
                const auto end = arg.find(',', start);
                shift = arg.substr(start, end == std::string::npos ? std::string::npos : end - start);
            }
        }
        spec.diagnostics += "[LasecSimul] execution=deterministic-icount shift=" + shift + "\n";
    } else {
        // Neither tcg,thread=multi nor -icount: this is the LASECSIMUL_QEMU_TCG_THREAD=single
        // override on top of MTTCG's default config -- single TCG thread, still real-time
        // virtual clock. See McuController.cpp's tcgThread override above.
        spec.diagnostics +=
            "[LasecSimul] execution=single-realtime "
            "(LASECSIMUL_QEMU_TCG_THREAD=single override, no -icount)\n";
    }
    const qemu::QemuArenaProtocol arenaProtocol =
        qemu::QemuArenaBridge::configuredProtocol();
    spec.diagnostics +=
        arenaProtocol == qemu::QemuArenaProtocol::V5
            ? "[LasecSimul] arena=v5 negotiated (default; rollback: "
              "LASECSIMUL_QEMU_ARENA_VERSION=3)\n"
            : "[LasecSimul] arena=v3 legacy rollback\n";
    // Every launch must declare which transport it will use, unambiguously -- see
    // PLAN_MTTCG_VNEXT_B_CAUSALITY.md section 7.2. Read here (not just in start()) so this is
    // visible from buildLaunchSpec() alone, without starting real QEMU.
    const char* selectedTransportForDiag = std::getenv("LASECSIMUL_MCU_TRANSPORT");
    spec.diagnostics +=
        (selectedTransportForDiag && std::string_view(selectedTransportForDiag) == "VNEXT_B")
            ? "[LasecSimul] transport=vnext_b\n"
            : "[LasecSimul] transport=legacy\n";
    configureNetwork(spec, arenaName);
    if (std::getenv("LASECSIMUL_TEST_ELF_BOOT")) {
        for (size_t i = 0; i + 1 < spec.args.size(); ++i) {
            if (spec.args[i] == "-drive") {
                spec.args[i] = "-kernel";
                spec.args[i + 1] = firmwarePath.string();
                break;
            }
        }
    }
    const std::string& overridePath = !callSiteBinaryOverride.empty() ? callSiteBinaryOverride : m_qemuBinaryOverride;
    if (!overridePath.empty()) spec.binary = overridePath;
    if (debug.enabled()) {
        if (debug.startPaused) spec.args.push_back("-S");
        spec.args.push_back("-gdb");
        spec.args.push_back("tcp:127.0.0.1:" + std::to_string(debug.gdbPort));
    }
    // O fork consome a chave da arena como argv[1], antes dos argumentos normais do QEMU.
    spec.args.insert(spec.args.begin(), arenaName);
    return spec;
}

void McuController::start(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                          const std::string& callSiteBinaryOverride, McuDebugOptions debug,
                          RuntimeLaunchIdentity identity, std::function<void()> notificationWake) {
    // Achado 2026-07-22 (DESATIVADO -- ver achado seguinte): esta chamada calibrava o `-icount
    // shift` medindo a sonda de `QemuIcountCalibrator` (boot ROM genérico, sem firmware real, cada
    // registrador confirmado instantaneamente por um laço síntético -- ver `pumpArenaFor` em
    // QemuIcountCalibrator.cpp). Verificado ao vivo com firmware real: o shift medido por essa
    // sonda (3, neste host) faz uma sessão REAL (que passa por todo o dispatch elétrico/Scheduler
    // por acesso a registrador, custo MUITO maior que o laço síntético da sonda) rodar mais devagar
    // que o shift=4 fixo antigo (0,57s simulados em 15s reais, contra 2,69s com shift=4) e ainda
    // disparou um reset inesperado do firmware (GPIO nunca chegou a alternar) -- a sonda mede um
    // teto de throughput otimista que não existe numa sessão real, então "calibrar" contra ela piora
    // o problema em vez de corrigir. Desligado até uma metodologia de medição que reflita o custo
    // real do dispatch (ou outra abordagem) existir -- `QemuIcountCalibrator`/`Esp32Adapter.cpp::
    // configuredIcountShift()` continuam prontos (e testados) pra quando isso for retomado, só não
    // chamados aqui. `Esp32Adapter.cpp` mantém o fallback `shift=4` de sempre.
    m_runtimeIdentity = identity;
    QemuLaunchSpec spec = buildLaunchSpec(
        firmwarePath, arenaName, callSiteBinaryOverride, debug, identity);
    const char* selectedTransport = std::getenv("LASECSIMUL_MCU_TRANSPORT");
    const bool useVnextBTransport =
        selectedTransport && std::string_view(selectedTransport) == "VNEXT_B";
    if (useVnextBTransport) {
        if (!identity.sessionExecutionId || !identity.runtimeInstanceId || !identity.launchGeneration) {
            throw std::runtime_error("VNEXT_B requires a managed runtime identity");
        }
        // E117 (EVIDENCE.md, 2026-09-04): two-phase startup, replacing the old single start()
        // call that used to write RUNNING and signal coreEvent *before* the wait dispatcher was
        // registered and before m_vnextBAttached became true -- QEMU could then produce past the
        // lane's small ring before Core was able to consume a single event (proven with a
        // deterministic RED reproduction in VnextBAttachmentTest.cpp before this fix landed).
        //
        // 1. prepare(): launches QEMU, completes the READY handshake, registers the dispatcher --
        //    all while QEMU remains PRELAUNCH-blocked and cannot produce anything yet.
        // 2. Only on success, m_vnextBAttached becomes true -- the poll path
        //    (McuComponent::pollAndDispatchPendingEvents(), gated on vnextBActive()) can already
        //    reach m_vnextB safely at this point (the object and its mapping are fully valid),
        //    it just has nothing to drain yet.
        // 3. activate(): only now writes core_state=RUNNING and signals coreEvent -- the
        //    dispatcher is already registered and the attachment is already marked usable, so
        //    QEMU cannot get ahead of the consumer by construction, not by timing luck.
        // 4. If activate() throws, roll back m_vnextBAttached and stop() -- never leave the
        //    controller believing an attachment is usable when QEMU was never actually released.
        // The accessor lambda below deliberately reads m_vnextBAttached without synchronization --
        // it is called from the dispatcher's worker thread (a different thread than the one
        // writing m_vnextBAttached here); a torn read of a single-byte bool is not a practical
        // concern on any real target this project builds for.
        // E145/E146 (EVIDENCE.md, 2026-09-09; DECISION-010): fail-closed host-capacity admission,
        // BEFORE any QEMU process is created -- a project with enough MCU components could
        // otherwise reproduce the same host freeze DECISION-010 documents for test runners,
        // entirely inside ordinary product usage, with no test harness involved at all. The
        // admitted ceiling is min(topology-computed safe capacity, this release's certified
        // limit) -- E146 (EVIDENCE.md, 2026-09-09): the topology number alone is a theoretical
        // CPU-oversubscription bound, never validated end-to-end at N=13 on this host, and must
        // not be treated as a certified capacity by itself (see VnextBCapacityGuard.hpp's own
        // comment on kVnextBCertifiedReleaseSessionLimit). The escape hatch is opt-in-only and
        // never set by any gate/runner/config in this codebase -- see VnextBCapacityGuard.hpp.
        //
        // Count strictly on the false->true transition of m_vnextBAttached (mirrored by stop()'s
        // true->false decrement below): prepare() tears down any previous attachment on this
        // same controller internally, so a re-entrant start() without an intervening stop() must
        // not double-count a session this controller already held.
        const bool wasAlreadyAttached = m_vnextBAttached;
        bool reservedCapacitySlot = false;
        if (!wasAlreadyAttached && !qemu::vnextBCapacityOverrideRequested()) {
            // E146 (EVIDENCE.md, 2026-09-09): a real-firmware N=9 negative test caught this exact
            // guard letting ALL requested sessions through under a parallel-start caller (multiple
            // threads calling McuController::start() concurrently, as
            // VnextBProductionScaleTest.cpp's parallelStart path does). The original form did a
            // plain load() of the counter, checked it, and only THEN incremented -- classic
            // check-then-act: every thread can observe the same stale pre-increment count and all
            // decide they are admissible before any of them actually increments. Fixed by making
            // reservation ITSELF the atomic operation (fetch_add first, unconditionally), then
            // validating the value that specific call reserved; a rejected caller rolls its own
            // reservation back with fetch_sub before throwing. No other thread's decision is ever
            // based on a value that could still change before it acts on it.
            const uint32_t reservedCount =
                qemu::activeVnextBSessionCount().fetch_add(1, std::memory_order_acq_rel) + 1;
            reservedCapacitySlot = true;
            const uint32_t topologySafeSessions = qemu::vnextBSafeSessionsForThisHost();
            const uint32_t certifiedLimit = qemu::kVnextBCertifiedReleaseSessionLimit;
            const uint32_t allowedSessions =
                qemu::computeAllowedVnextBSessions(topologySafeSessions, certifiedLimit);
            if (reservedCount > allowedSessions) {
                qemu::activeVnextBSessionCount().fetch_sub(1, std::memory_order_acq_rel);
                throw std::runtime_error(
                    "VNEXT_B capacity guard (DECISION-010): starting session " +
                    std::to_string(reservedCount) + " would exceed this release's effective "
                    "MTTCG session limit. requested_sessions=" + std::to_string(reservedCount) +
                    " host_calculated_capacity=" + std::to_string(topologySafeSessions) + " (" +
                    std::to_string(std::thread::hardware_concurrency()) + " logical processors, " +
                    std::to_string(qemu::kVnextBReservedProcessors) + " reserved, " +
                    std::to_string(qemu::kVnextBVcpusPerSession) + " vCPUs/session) "
                    "certified_release_limit=" + std::to_string(certifiedLimit) +
                    " effective_allowed_limit=" + std::to_string(allowedSessions) + ". Refusing to "
                    "start a new QEMU process rather than risk an unresponsive host or run beyond "
                    "this release's validated envelope. Set "
                    "LASECSIMUL_VNEXT_B_CAPACITY_OVERRIDE=1 only for a deliberate, understood, "
                    "human-supervised experiment -- never in production or automated gates.");
            }
        }
        // A rollback is owed to the counter whenever, at this point, a slot is credited to THIS
        // controller: either this call itself just reserved a fresh one (reservedCapacitySlot),
        // or it was already counted from a prior successful start() and prepare()'s own internal
        // stop()-of-the-previous-attachment (VnextBAttachment::prepare() always tears down any
        // existing attachment first) is about to make that no longer true.
        const bool capacityRollbackOwed = reservedCapacitySlot || wasAlreadyAttached;
        try {
            m_vnextB.prepare(std::move(spec), identity.sessionExecutionId, arenaName, m_adapter.chipId(),
                             std::move(notificationWake), [this] { return m_vnextBAttached; });
        } catch (...) {
            if (capacityRollbackOwed) qemu::activeVnextBSessionCount().fetch_sub(1, std::memory_order_acq_rel);
            throw;
        }
        m_vnextBAttached = true;
        try {
            m_vnextB.activate();
        } catch (...) {
            m_vnextBAttached = false;
            if (capacityRollbackOwed) qemu::activeVnextBSessionCount().fetch_sub(1, std::memory_order_acq_rel);
            m_vnextB.stop();
            throw;
        }
        return;
    }
    // O backend socket legado do QEMU encerra qemu_init() quando connect() recebe ECONNREFUSED.
    // Detecte antes de criar a CPU e degrade para SLIRP: firmware OpenETH continua tendo a mesma
    // NIC/MMIO, enquanto um gateway/TAP ausente nunca derruba GPIO, timers ou o processo inteiro.
    if (environmentValue("LASECSIMUL_NETWORK_MODE", "disabled") == "lab-bridge" &&
        !gatewayAcceptingConnections(configuredGatewayPort())) {
        for (std::string& arg : spec.args) {
            if (arg.find("socket,model=open_eth") != std::string::npos) {
                arg = isolatedOpenEthArgument(arenaName);
                spec.diagnostics +=
                    "[LasecSimul] warning: lab gateway unavailable; falling back to isolated SLIRP\n";
                break;
            }
        }
    }
    m_arenaBridge.open(qemu::QemuArenaOpenOptions{arenaName, true});
    m_processManager.start(spec);
    if (m_arenaBridge.protocolMajor() == LSDN_QEMU_ARENA_ABI_MAJOR) {
        const auto deadline =
            std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (m_processManager.isRunning() &&
               !m_arenaBridge.peerReady() &&
               std::chrono::steady_clock::now() < deadline) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (!m_arenaBridge.peerReady()) {
            const std::string logs = m_processManager.logs();
            m_processManager.stop();
            m_arenaBridge.close();
            throw std::runtime_error(
                "QEMU arena ABI v5 handshake failed; verify that Core and "
                "qemu-system-xtensa use the same arena ABI. QEMU logs: " +
                logs);
        }
    }
}

void McuController::stop() {
    if (m_vnextBAttached) {
        m_vnextB.stop();
        m_vnextBAttached = false;
        qemu::activeVnextBSessionCount().fetch_sub(1, std::memory_order_acq_rel);
    }
    m_processManager.stop();
    m_arenaBridge.close();
}
bool McuController::isRunning() const {
    return m_vnextBAttached ? m_vnextB.running() : m_processManager.isRunning();
}
std::string McuController::qemuLogs() const {
    std::string result = m_processManager.logs();
    const std::string vnextLogs = m_vnextB.logs();
    if (!vnextLogs.empty()) {
        if (!result.empty()) result += "\n";
        result += vnextLogs;
    }
    return result;
}

} // namespace lasecsimul::mcu
