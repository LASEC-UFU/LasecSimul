#include "QemuIcountCalibrator.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <nlohmann/json.hpp>
#include "QemuArenaBridge.hpp"
#include "QemuProcessManager.hpp"
#include "lasecsimul/Types.hpp"

namespace lasecsimul::mcu::qemu {

namespace {

constexpr const char* kShiftEnvVar = "LASECSIMUL_ESP32_ICOUNT_SHIFT";
constexpr const char* kDataDirEnvVar = "LASECSIMUL_CORE_DATA_DIR";
/** Bump se a lógica de medição mudar de forma que invalide caches antigos gravados por uma versão
 * anterior deste arquivo, mesmo que o binário QEMU não tenha mudado. */
constexpr int kCalibrationLogicVersion = 2;
constexpr int kMinShift = 0;
constexpr int kMaxShift = 10;
/** `shift=0` (1ns virtual/instrução) medido inicialmente, mas `simuliface.c::simuMain` só recalcula
 * o período do heartbeat (`period_ns`, que controla a cadência de `simu_event()`/atualização de
 * `arena->qemuTime`) quando `shift > 0` -- em `shift=0` o heartbeat fica preso no placeholder inicial
 * (50000, calibrado pra shift=4 original) e na prática não observamos progresso dentro da janela de
 * medição (achado 2026-07-22, ao vivo: sonda com shift=0 sempre mediu zero). `shift=1` evita esse
 * caso de borda (fica dentro do `shift > 0` que a lógica de heartbeat já trata normalmente) sem
 * comprometer a precisão -- só divide o resultado por mais uma potência de 2. */
constexpr int kProbeShift = 1;
constexpr auto kWarmupDuration = std::chrono::milliseconds(50);
constexpr auto kMeasurementDuration = std::chrono::milliseconds(300);
constexpr auto kBootTimeout = std::chrono::milliseconds(3000);

std::string environmentValue(const char* name) {
    const char* value = std::getenv(name);
    return value ? std::string(value) : std::string();
}

void setEnvironmentValue(const char* name, const std::string& value) {
#if defined(_WIN32)
    _putenv_s(name, value.c_str());
#else
    setenv(name, value.c_str(), 1);
#endif
}

std::string uniqueArenaName() {
    return "lasecsimul-icount-calib-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

/** Mesma técnica de `McuControllerRealQemuTest.cpp::createBlankFlash()` (já validada: deixa a
 * máquina "viva" -- inicializa e permanece rodando -- sem precisar de firmware real). Reaproveitada
 * aqui porque a calibração precisa que o processo permaneça de fato EXECUTANDO instruções por uma
 * janela de tempo sustentada, não apenas abrir e fechar. */
std::filesystem::path createBlankFlash() {
    const std::filesystem::path path =
        std::filesystem::temp_directory_path() / (uniqueArenaName() + "-flash.bin");
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    const std::vector<char> erasedBlock(64 * 1024, static_cast<char>(0xFF));
    for (int i = 0; i < 64; ++i) out.write(erasedBlock.data(), erasedBlock.size());
    if (!out) throw std::runtime_error("nao foi possivel criar flash vazia de calibracao");
    return path;
}

struct BinaryFingerprint {
    std::string path;
    int64_t mtimeUnixMs = 0;
    uint64_t sizeBytes = 0;
};

std::optional<BinaryFingerprint> fingerprintBinary(const std::string& resolvedBinaryPath) {
    try {
        const std::filesystem::path path(std::filesystem::u8path(resolvedBinaryPath));
        if (!std::filesystem::exists(path)) return std::nullopt;
        const auto size = std::filesystem::file_size(path);
        const auto writeTime = std::filesystem::last_write_time(path);
        // `file_time_type` não tem conversão padronizada pra `system_clock` antes de C++20's
        // `clock_cast` (nem sempre disponível em toda stdlib) -- usamos a diferença em relação ao
        // "agora" de cada relógio, suficiente pra um fingerprint estável entre execuções (não
        // precisa ser um timestamp Unix "de verdade", só precisa mudar quando o arquivo muda).
        const auto sinceEpoch = writeTime.time_since_epoch();
        const int64_t mtimeUnitsRaw = std::chrono::duration_cast<std::chrono::milliseconds>(sinceEpoch).count();
        return BinaryFingerprint{resolvedBinaryPath, mtimeUnitsRaw, static_cast<uint64_t>(size)};
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

std::filesystem::path cacheFilePath(const std::string& dataDir) {
    return std::filesystem::u8path(dataDir) / "qemu-icount-calibration.json";
}

std::optional<int> readCachedShift(const std::string& dataDir, const BinaryFingerprint& current) {
    try {
        const auto path = cacheFilePath(dataDir);
        if (!std::filesystem::exists(path)) return std::nullopt;
        std::ifstream in(path);
        nlohmann::json cached;
        in >> cached;
        if (cached.value("logicVersion", -1) != kCalibrationLogicVersion) return std::nullopt;
        if (cached.value("binaryPath", std::string()) != current.path) return std::nullopt;
        if (cached.value("binaryMtimeUnixMs", int64_t{-1}) != current.mtimeUnixMs) return std::nullopt;
        if (cached.value("binarySizeBytes", uint64_t{0}) != current.sizeBytes) return std::nullopt;
        const int shift = cached.value("shift", -1);
        if (shift < kMinShift || shift > kMaxShift) return std::nullopt;
        return shift;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

void writeCachedShift(const std::string& dataDir, const BinaryFingerprint& fingerprint, int shift,
                       double measuredRealNsPerInstruction) {
    try {
        std::filesystem::create_directories(std::filesystem::u8path(dataDir));
        const nlohmann::json cached{
            {"logicVersion", kCalibrationLogicVersion},
            {"binaryPath", fingerprint.path},
            {"binaryMtimeUnixMs", fingerprint.mtimeUnixMs},
            {"binarySizeBytes", fingerprint.sizeBytes},
            {"shift", shift},
            {"measuredRealNsPerInstruction", measuredRealNsPerInstruction},
        };
        std::ofstream out(cacheFilePath(dataDir), std::ios::trunc);
        out << cached.dump(2);
    } catch (const std::exception&) {
        // Cache é só uma otimização -- falha ao gravar não deveria impedir a calibração de valer
        // pro processo atual (já setamos a env var antes de chamar isto).
    }
}

/** Troca o VALOR do argumento `-icount` (o elemento logo depois) por `newValue` -- espelha o layout
 * exato que `Esp32Adapter.cpp::buildLaunchArgs` produz (`{"-icount", "shift=N,align=off,sleep=off"}`
 * como dois elementos consecutivos). Não encontrar o flag é um erro de programação (o adapter não
 * devolveu o que esperávamos) -- lança em vez de silenciosamente medir o shift errado. */
void replaceIcountValue(std::vector<std::string>& args, const std::string& newValue) {
    for (size_t i = 0; i + 1 < args.size(); ++i) {
        if (args[i] == "-icount") {
            args[i + 1] = newValue;
            return;
        }
    }
    throw std::runtime_error("QemuIcountCalibrator: adapter nao produziu um argumento -icount");
}

} // namespace

void ensureIcountShiftCalibrated(const IMcuAdapter& adapter, const std::string& resolvedBinaryPath,
                                 const QemuIcountCalibratorLogFn& log) {
    // Já calibrado NESTE processo (ou setado externamente por quem está rodando o Core, ex.: um
    // teste que quer um shift fixo conhecido) -- não recalibra.
    if (!environmentValue(kShiftEnvVar).empty()) return;
    // Sem um binário concreto pra medir/cachear, não há o que calibrar -- Esp32Adapter cai no
    // `shift=4` default (ver comentário de `ensureIcountShiftCalibrated` no header).
    if (resolvedBinaryPath.empty()) return;

    const auto fingerprint = fingerprintBinary(resolvedBinaryPath);
    if (!fingerprint) {
        log("[QemuIcountCalibrator] binario nao encontrado em '" + resolvedBinaryPath +
            "' -- pulando calibracao, usando shift=4 default\n");
        return;
    }

    const std::string dataDir = environmentValue(kDataDirEnvVar);
    if (!dataDir.empty()) {
        if (const auto cachedShift = readCachedShift(dataDir, *fingerprint)) {
            setEnvironmentValue(kShiftEnvVar, std::to_string(*cachedShift));
            log("[QemuIcountCalibrator] cache=hit shift=" + std::to_string(*cachedShift) + "\n");
            return;
        }
    }

    try {
        QemuLaunchSpec spec = adapter.buildLaunchArgs("");
        replaceIcountValue(spec.args, "shift=" + std::to_string(kProbeShift) + ",align=off,sleep=off");
        spec.binary = resolvedBinaryPath;
        const std::filesystem::path blankFlash = createBlankFlash();
        // Mesmo `-drive` que o adapter já monta, só que apontando pra flash apagada em vez do
        // firmware real -- acha o par "-drive"/valor e substitui o valor (não insere um novo).
        for (size_t i = 0; i + 1 < spec.args.size(); ++i) {
            if (spec.args[i] == "-drive") {
                spec.args[i + 1] = "file=" + blankFlash.string() + ",if=mtd,format=raw";
                break;
            }
        }
        const std::string arenaName = uniqueArenaName();
        spec.args.insert(spec.args.begin(), arenaName);

        QemuArenaBridge bridge;
        bridge.open(QemuArenaOpenOptions{arenaName, true});
        QemuProcessManager process;
        process.start(spec);

        // Achado 2026-07-22 (ao vivo, depurando esta mesma calibração), duas descobertas:
        // 1. Sem NINGUÉM servindo a fila Core<->QEMU (o papel que `McuComponent::runBackgroundPollLoop`
        //    cumpre numa sessão real), a primeira escrita de registrador que o boot ROM faz enche o
        //    slot da fila e o vCPU fica PERMANENTEMENTE bloqueado em `waitForSynch()` (simuliface.c)
        //    esperando um `acknowledgeWrite()` que nunca vem -- `running` fica 1 (setado antes do
        //    loop principal), mas nada mais avança. Não importa fazer o dispatch elétrico CORRETO
        //    aqui (só queremos o vCPU livre pra continuar retirando instruções) -- confirma leituras
        //    com 0 e reconhece escritas/eventos sem mais nenhum efeito.
        // 2. `arena->qemuTime` NUNCA é escrito pelo lado QEMU real (`grep qemuTime simuliface.c`
        //    confirma: só existe como variável LOCAL dentro de `getQemu_ps()`, nunca atribuído ao
        //    campo do arena) -- não dá pra "amostrar o relógio virtual atual" lendo esse campo
        //    (fica 0 pra sempre). O tempo virtual só chega EMBUTIDO em cada evento individual
        //    (`event->simuTimePs`, escrito tanto pelos heartbeats `SIM_EVENT` quanto por cada
        //    leitura/escrita de registrador) -- por isso rastreamos o MAIOR `simuTimePs` observado
        //    entre os eventos processados, não um "agora" lido sob demanda.
        uint64_t latestVirtualTimePs = 0;
        auto pumpArenaFor = [&](std::chrono::milliseconds duration) {
            const auto deadline = std::chrono::steady_clock::now() + duration;
            while (std::chrono::steady_clock::now() < deadline) {
                const QemuPollResult result = bridge.poll();
                if (!result.hasEvent) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    continue;
                }
                latestVirtualTimePs = std::max(latestVirtualTimePs, result.event->simuTimePs);
                if (result.event->simuAction == LSDN_SIM_READ) bridge.acknowledgeRead(0);
                else bridge.acknowledgeWrite();
            }
        };

        const auto bootDeadline = std::chrono::steady_clock::now() + kBootTimeout;
        while (std::chrono::steady_clock::now() < bootDeadline &&
               (!bridge.arena() || bridge.arena()->running == 0)) {
            pumpArenaFor(std::chrono::milliseconds(20));
        }
        if (!bridge.arena() || bridge.arena()->running == 0) {
            log("[QemuIcountCalibrator] sonda de calibracao nao inicializou em " +
                std::to_string(kBootTimeout.count()) + "ms -- usando shift=4 default\n");
            process.kill();
            bridge.close();
            std::filesystem::remove(blankFlash);
            return;
        }

        pumpArenaFor(kWarmupDuration);
        const auto wallStart = std::chrono::steady_clock::now();
        const uint64_t virtualNsStart = latestVirtualTimePs / 1000u; // ps -> ns
        pumpArenaFor(kMeasurementDuration);
        const auto wallEnd = std::chrono::steady_clock::now();
        const uint64_t virtualNsEnd = latestVirtualTimePs / 1000u;

        process.kill();
        bridge.close();
        std::filesystem::remove(blankFlash);

        // virtualNs foi medido com `-icount shift=kProbeShift` (não shift=0, ver comentário de
        // `kProbeShift`) -- cada instrução credita `2^kProbeShift` ns virtuais, então
        // instructionsRetired = virtualNsElapsed / 2^kProbeShift (checa ANTES do shift-right: um
        // delta pequeno mas não-zero pode virar 0 depois de `>> kProbeShift`, mesma condição de
        // "sonda não avançou").
        if (virtualNsEnd <= virtualNsStart || ((virtualNsEnd - virtualNsStart) >> kProbeShift) == 0) {
            log("[QemuIcountCalibrator] sonda nao avancou tempo virtual nenhum -- usando shift=4 default\n");
            return;
        }
        const uint64_t instructionsRetired = (virtualNsEnd - virtualNsStart) >> kProbeShift;
        const double actualWallNs = static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(wallEnd - wallStart).count());
        const double realNsPerInstruction = actualWallNs / static_cast<double>(instructionsRetired);
        if (!std::isfinite(realNsPerInstruction) || realNsPerInstruction <= 0.0) {
            log("[QemuIcountCalibrator] medicao invalida (ns/instrucao nao finito) -- usando shift=4 default\n");
            return;
        }

        // Arredonda pra BAIXO de propósito: um shift menor credita MENOS tempo virtual por
        // instrução do que o medido, deixando o relógio virtual ligeiramente ATRÁS do relógio de
        // parede na pior das hipóteses -- nunca ADIANTADO. Um firmware que "adianta" o tempo pode
        // mascarar um bug de timing real que nunca ocorreria em hardware de verdade; ficar
        // ligeiramente atrás é a mesma direção do problema já conhecido (só que muito menor em
        // magnitude), nunca um problema NOVO oposto.
        const int shift = std::clamp(static_cast<int>(std::floor(std::log2(realNsPerInstruction))),
                                      kMinShift, kMaxShift);
        setEnvironmentValue(kShiftEnvVar, std::to_string(shift));
        log("[QemuIcountCalibrator] cache=miss medido=" + std::to_string(realNsPerInstruction) +
            "ns/instrucao shift_calibrado=" + std::to_string(shift) + " (default seria 4)\n");

        if (!dataDir.empty()) writeCachedShift(dataDir, *fingerprint, shift, realNsPerInstruction);
    } catch (const std::exception& ex) {
        log(std::string("[QemuIcountCalibrator] falha na calibracao: ") + ex.what() +
            " -- usando shift=4 default\n");
    }
}

} // namespace lasecsimul::mcu::qemu
