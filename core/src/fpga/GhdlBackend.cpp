#include "GhdlBackend.hpp"

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <thread>

#include "lasecsimul/Sha256.hpp"
#include "lasecsimul/fpga_arena_abi.h"

namespace lasecsimul::fpga {

namespace fs = std::filesystem;

namespace {

std::string uniqueArenaName(const std::string& topEntity) {
    return "lasecsimul-fpga-" + topEntity + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

constexpr const char* kCacheMarkerName = ".lasecsimul-fpga-cache-ok";

// Espelha exatamente os subdiretórios de build de fpga/ghdl-vpi (ver build-fpga-vpi.js e
// GhdlBackendRealGhdlTest.cpp) -- entra na chave de cache (Cache vNext) como parte de "plataforma".
std::string platformId() {
#if defined(_WIN32)
    return "windows-x64";
#elif defined(__APPLE__)
    return "macos-universal";
#else
    return "linux-x64";
#endif
}

// Entradas publicadas ganham o atributo read-only (ver compile()) -- no Windows, `DeleteFile`
// recusa remover um arquivo com esse atributo mesmo com permissão de escrita no diretório pai
// (diferente de Unix, onde deleção é regida pelo diretório, não pelo arquivo). Sem isto,
// `fs::remove_all` numa entrada publicada (republicação após corrupção, ou evictIfOverBudget())
// falharia silenciosamente (`ec` setado, nada removido).
void clearReadOnlyRecursive(const fs::path& root) {
    std::error_code existsEc;
    if (!fs::exists(root, existsEc)) return;
    std::error_code rootPermEc;
    fs::permissions(root, fs::perms::owner_write | fs::perms::group_write | fs::perms::others_write,
                     fs::perm_options::add, rootPermEc);
    std::error_code walkEc;
    for (const auto& entry : fs::recursive_directory_iterator(root, walkEc)) {
        std::error_code entryPermEc;
        fs::permissions(entry.path(), fs::perms::owner_write | fs::perms::group_write | fs::perms::others_write,
                         fs::perm_options::add, entryPermEc);
    }
}

} // namespace

GhdlBackend::GhdlBackend(GhdlBackendOptions options) : m_options(std::move(options)) {}
GhdlBackend::~GhdlBackend() { stop(); }

std::string GhdlBackend::ghdlFingerprint() const {
    if (!m_ghdlFingerprintCache.empty()) return m_ghdlFingerprintCache;
    GhdlProcessManager probe;
    try {
        probe.start(GhdlLaunchSpec{m_options.ghdlBinary, {"--version"}, {}, {}, {}});
        probe.waitForExit(std::chrono::seconds(5));
    } catch (const std::exception&) {
        m_ghdlFingerprintCache = "unknown";
        return m_ghdlFingerprintCache;
    }
    std::string output = probe.logs();
    while (!output.empty() && (output.back() == '\n' || output.back() == '\r')) output.pop_back();
    m_ghdlFingerprintCache = output.empty() ? "unknown" : output;
    return m_ghdlFingerprintCache;
}

std::string GhdlBackend::computeCacheKey(const RtlCompileRequest& request) const {
    // SHA-256 do conteúdo REAL das fontes (não só o caminho -- um arquivo editado sem mudar de
    // nome precisa invalidar o cache), do nome relativo de cada uma, na ordem dada (ordem importa
    // pra análise -- ver plano seção 24), de top/standard/flags, e da tripla toolchain/plataforma/
    // ABI (versão do GHDL, fingerprint do módulo VPI carregado, plataforma, versão da arena) --
    // Cache vNext, `.spec/features/fpga-ghdl.md`: trocar de instalação de GHDL ou reconstruir o
    // VPI com uma ABI diferente PRECISA invalidar entradas antigas, nunca reusar um
    // `work-obj08.cf`/protocolo de arena incompatível. Nunca versiona o artefato compilado (plano
    // seção 23): a chave só decide o NOME do subdiretório de cache, fora da árvore de fontes do
    // usuário.
    Sha256 hasher;
    auto feed = [&hasher](const std::string& s) {
        hasher.update(reinterpret_cast<const uint8_t*>(s.data()), s.size());
        static constexpr uint8_t kSeparator = 0;
        hasher.update(&kSeparator, 1); // evita colisão "ab"+"c" == "a"+"bc" na concatenação do hash
    };

    for (const std::string& source : request.sources) {
        std::ifstream file(source, std::ios::binary);
        if (!file) throw std::runtime_error("GhdlBackend: não foi possível ler fonte VHDL: " + source);
        std::ostringstream buffer;
        buffer << file.rdbuf();
        feed(fs::path(source).filename().string());
        feed(buffer.str());
    }
    feed(request.topEntity);
    feed(request.standard);
    feed(""); // flags -- reservado; RtlCompileRequest não expõe flags extras de compilação no MVP
    feed(ghdlFingerprint());
    feed(platformId());
    feed(Sha256::hashFile(m_options.vpiModulePath)); // "" se o módulo ainda não existir -- chave própria, não erro aqui
    feed(std::to_string(LSDN_FPGA_ARENA_ABI_MAJOR) + "." + std::to_string(LSDN_FPGA_ARENA_ABI_MINOR));
    return hasher.finalizeHex();
}

void GhdlBackend::evictIfOverBudget() const {
    std::error_code ec;
    struct Entry {
        fs::path path;
        fs::file_time_type mtime;
        uint64_t bytes;
    };
    std::vector<Entry> entries;
    uint64_t total = 0;
    for (const auto& dirEntry : fs::directory_iterator(m_options.cacheRootDir, ec)) {
        if (!dirEntry.is_directory()) continue;
        const std::string name = dirEntry.path().filename().string();
        if (name.rfind(".staging-", 0) == 0 || name == ".run" || dirEntry.path().extension() == ".lock") continue;
        if (!fs::exists(dirEntry.path() / kCacheMarkerName)) continue; // não é uma entrada publicada

        uint64_t bytes = 0;
        std::error_code walkEc;
        for (const auto& file : fs::recursive_directory_iterator(dirEntry.path(), walkEc)) {
            if (!file.is_regular_file()) continue;
            std::error_code sizeEc;
            bytes += fs::file_size(file.path(), sizeEc);
        }
        std::error_code mtimeEc;
        entries.push_back({dirEntry.path(), fs::last_write_time(dirEntry.path(), mtimeEc), bytes});
        total += bytes;
    }
    if (total <= m_options.cacheBudgetBytes) return;

    std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) { return a.mtime < b.mtime; });
    for (const Entry& entry : entries) {
        if (total <= m_options.cacheBudgetBytes) break;
        if (entry.path == fs::path(m_cacheDir)) continue; // nunca evita a entrada recém-publicada desta compilação
        clearReadOnlyRecursive(entry.path);
        std::error_code removeEc;
        fs::remove_all(entry.path, removeEc);
        if (!removeEc) total -= entry.bytes;
    }
}

RtlCompileResult GhdlBackend::compile(const RtlCompileRequest& request) {
    RtlCompileResult result;
    const std::string cacheKey = computeCacheKey(request);
    const fs::path finalDir = fs::path(m_options.cacheRootDir) / cacheKey;
    const fs::path markerPath = finalDir / kCacheMarkerName;

    std::error_code ec;
    fs::create_directories(m_options.cacheRootDir, ec);

    auto reportHit = [&]() {
        std::error_code touchEc;
        fs::last_write_time(finalDir, fs::file_time_type::clock::now(), touchEc); // pra LRU em evictIfOverBudget()
        result.ok = true;
        result.log = "(cache hit -- " + finalDir.string() + ")";
        m_cacheDir = finalDir.string();
        m_compiledRequest = request;
        m_compiled = true;
    };

    if (fs::exists(markerPath)) {
        reportHit();
        return result;
    }

    // Lock por chave (Cache vNext, aceitação "duas compilações concorrentes da mesma chave não
    // corrompem cache") -- diretório de lock criado de forma atômica: `fs::create_directory`
    // devolve `false` SEM setar `ec` quando o diretório já existe (contrato do padrão), e só seta
    // `ec` num erro real (permissão, disco, etc.), o que distinguimos abaixo pra não girar pra
    // sempre num erro de verdade.
    const fs::path lockDir = fs::path(m_options.cacheRootDir) / (cacheKey + ".lock");
    const auto lockDeadline = std::chrono::steady_clock::now() + m_options.compileTimeout;
    for (;;) {
        ec.clear();
        if (fs::create_directory(lockDir, ec)) break;
        if (ec) {
            result.ok = false;
            result.log = "GhdlBackend: erro criando lock de compilação (" + lockDir.string() + "): " + ec.message();
            return result;
        }
        if (fs::exists(markerPath)) {
            // outra instância publicou enquanto esperávamos o lock -- hit direto, sem competir por ele.
            reportHit();
            return result;
        }
        if (std::chrono::steady_clock::now() >= lockDeadline) {
            result.ok = false;
            result.log = "GhdlBackend: timeout esperando lock de compilação para " + cacheKey;
            return result;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    struct LockGuard {
        fs::path dir;
        ~LockGuard() {
            std::error_code removeEc;
            fs::remove(dir, removeEc);
        }
    } lockGuard{lockDir};

    // Diretório de staging PRÓPRIO desta compilação -- nunca escreve na entrada final diretamente.
    // Publica por rename atômico só em sucesso total (Cache vNext: "falha ou timeout nunca publica
    // hit").
    const fs::path stagingDir = fs::path(m_options.cacheRootDir) /
                                 (".staging-" + cacheKey + "-" +
                                  std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::remove_all(stagingDir, ec);
    fs::create_directories(stagingDir, ec);
    if (ec) {
        result.ok = false;
        result.log = "GhdlBackend: não foi possível criar diretório de staging: " + stagingDir.string();
        return result;
    }
    struct StagingGuard {
        fs::path dir;
        bool published = false;
        ~StagingGuard() {
            if (!published) {
                std::error_code removeEc;
                fs::remove_all(dir, removeEc);
            }
        }
    } stagingGuard{stagingDir};

    std::ostringstream combinedLog;
    for (const std::string& source : request.sources) {
        GhdlProcessManager analyze;
        analyze.start(GhdlLaunchSpec{m_options.ghdlBinary, {"-a", "--std=" + request.standard, source}, {},
                                     stagingDir.string(), {}});
        const std::optional<int> exitCode = analyze.waitForExit(m_options.compileTimeout);
        combinedLog << analyze.logs();
        if (!exitCode) {
            analyze.kill();
            result.ok = false;
            result.log = combinedLog.str() + "\n[GhdlBackend] timeout em 'ghdl -a " + source + "'";
            return result;
        }
        if (*exitCode != 0) {
            result.ok = false;
            result.log = combinedLog.str();
            return result;
        }
    }

    GhdlProcessManager elaborate;
    // --time-resolution=ns: opção de elaborate (não de run, apesar de listada em `ghdl help run`
    // também -- achado empírico do Step 4). Fixa o domínio de tempo do GHDL em ns, batendo
    // exatamente com o protocolo da arena (fpga_arena_abi.h) -- nunca precisa de conversão
    // fs/ps em lugar nenhum.
    elaborate.start(GhdlLaunchSpec{
        m_options.ghdlBinary, {"-e", "--std=" + request.standard, "--time-resolution=ns", request.topEntity}, {},
        stagingDir.string(), {}});
    const std::optional<int> elaborateExitCode = elaborate.waitForExit(m_options.compileTimeout);
    combinedLog << elaborate.logs();
    if (!elaborateExitCode) {
        elaborate.kill();
        result.ok = false;
        result.log = combinedLog.str() + "\n[GhdlBackend] timeout em 'ghdl -e " + request.topEntity + "'";
        return result;
    }
    if (*elaborateExitCode != 0) {
        result.ok = false;
        result.log = combinedLog.str();
        return result;
    }

    {
        std::ofstream marker(stagingDir / kCacheMarkerName);
        marker << request.topEntity << "\n" << request.standard << "\n" << ghdlFingerprint() << "\n";
    }

    clearReadOnlyRecursive(finalDir); // resto de uma publicação anterior corrompida/parcial pode estar read-only
    fs::remove_all(finalDir, ec);
    fs::rename(stagingDir, finalDir, ec);
    if (ec) {
        result.ok = false;
        result.log = combinedLog.str() + "\n[GhdlBackend] falha ao publicar cache (rename): " + ec.message();
        return result;
    }
    stagingGuard.published = true;

    // Entrada publicada é read-only por contrato (Cache vNext) -- start() nunca roda GHDL aqui
    // diretamente, sempre via materializeRunDir(). Best-effort: falha ao marcar read-only não
    // impede o uso do cache, só reduz a proteção contra mutação acidental.
    std::error_code walkEc;
    for (const auto& entry : fs::recursive_directory_iterator(finalDir, walkEc)) {
        std::error_code permEc;
        fs::permissions(entry.path(), fs::perms::owner_write | fs::perms::group_write | fs::perms::others_write,
                         fs::perm_options::remove, permEc);
    }

    result.ok = true;
    result.log = combinedLog.str();
    m_cacheDir = finalDir.string();
    m_compiledRequest = request;
    m_compiled = true;

    evictIfOverBudget();
    return result;
}

std::string GhdlBackend::resolveVpiLibraryDir() const {
    // ghdl --vpi-library-dir: descobre onde `libghdlvpi.dll`/`.so` mora nesta instalação (achado
    // do Spike 0/Step 4 -- o processo `ghdl -r` precisa dela no PATH pra carregar o NOSSO módulo
    // VPI, que por sua vez importa `libghdlvpi`). Consultado uma vez por start(), não cacheado
    // entre instâncias -- custo desprezível (spawn+wait de um comando instantâneo) comparado ao
    // resto do ciclo de vida de uma simulação FPGA.
    GhdlProcessManager query;
    query.start(GhdlLaunchSpec{m_options.ghdlBinary, {"--vpi-library-dir"}, {}, {}, {}});
    query.waitForExit(std::chrono::seconds(5));
    std::string output = query.logs();
    while (!output.empty() && (output.back() == '\n' || output.back() == '\r')) output.pop_back();
    return output;
}

std::vector<PortSpec> GhdlBackend::discoverPorts() {
    if (!m_compiled) throw std::runtime_error("GhdlBackend::discoverPorts() chamado antes de compile() ter sucesso");

    std::string pathOverride = resolveVpiLibraryDir();
    if (const char* existingPath = std::getenv("PATH")) {
        pathOverride += ";";
        pathOverride += existingPath;
    }

    // Roda num diretório de execução materializado (hardlinks a partir da entrada publicada), não
    // em m_cacheDir diretamente -- a entrada publicada é read-only por contrato (Cache vNext), e
    // `ghdl -r` (mesmo em modo discover) é tratado como qualquer outra execução: nunca escreve na
    // entrada de cache. Processo PRÓPRIO, independente de `m_process`/`start()`/`stop()` -- discover
    // é uma rodada curta e autocontida (sem arena, sem lockstep).
    const fs::path runDir = materializeRunDir("discover-" +
                                               std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    struct RunDirGuard {
        fs::path dir;
        ~RunDirGuard() {
            std::error_code ec;
            fs::remove_all(dir, ec);
        }
    } runDirGuard{runDir};

    GhdlProcessManager discover;
    GhdlLaunchSpec spec{
        m_options.ghdlBinary,
        {"-r", "--std=" + m_compiledRequest.standard, m_compiledRequest.topEntity, "--vpi=" + m_options.vpiModulePath},
        {},
        runDir.string(),
        {{"LASECSIMUL_FPGA_MODE", "discover"}, {"PATH", pathOverride}}};
    discover.start(spec);
    const std::optional<int> exitCode = discover.waitForExit(m_options.compileTimeout);
    if (!exitCode) {
        discover.kill();
        throw std::runtime_error("GhdlBackend::discoverPorts(): timeout rodando GHDL em modo discover");
    }
    return parseDiscoveredPorts(discover.logs());
}

void GhdlBackend::start() {
    if (!m_compiled) throw std::runtime_error("GhdlBackend::start() chamado antes de compile() ter sucesso");
    if (m_process.isRunning()) throw std::runtime_error("GhdlBackend já está rodando");

    const uint32_t inputCapacity = m_compiledRequest.inputBitCount > 0 ? m_compiledRequest.inputBitCount : 1;
    const uint32_t outputCapacity = m_compiledRequest.outputBitCount > 0 ? m_compiledRequest.outputBitCount : 1;
    const std::string arenaName = uniqueArenaName(m_compiledRequest.topEntity);
    // Core sempre cria a arena ANTES de spawnar o processo GHDL -- mesma disciplina de
    // McuController/QemuArenaBridge (ver GhdlArenaBridge.hpp).
    m_arena.open(GhdlArenaOpenOptions{arenaName, true, inputCapacity, outputCapacity});

    std::string pathOverride = resolveVpiLibraryDir();
    if (const char* existingPath = std::getenv("PATH")) {
        pathOverride += ";";
        pathOverride += existingPath;
    }

    // Materializa um diretório de execução PRÓPRIO desta instância (hardlinks a partir da entrada
    // publicada) -- nunca roda em m_cacheDir diretamente (read-only por contrato, Cache vNext).
    // Também é o que permite duas instâncias FPGA da MESMA compilação rodarem ao mesmo tempo sem
    // disputar os mesmos arquivos de biblioteca GHDL.
    m_runDir = materializeRunDir(arenaName).string();

    GhdlLaunchSpec spec{
        m_options.ghdlBinary,
        {"-r", "--std=" + m_compiledRequest.standard, m_compiledRequest.topEntity, "--vpi=" + m_options.vpiModulePath},
        {},
        m_runDir,
        {{"LASECSIMUL_FPGA_MODE", "run"}, {"LASECSIMUL_FPGA_ARENA_NAME", arenaName}, {"PATH", pathOverride}}};
    m_process.start(spec);
}

void GhdlBackend::stop() {
    if (!m_process.isRunning()) {
        cleanupRunDir();
        return;
    }
    if (m_arena.isOpen()) {
        try {
            m_arena.requestStop();
        } catch (const std::exception&) {
            // arena já pode estar num estado ruim (processo travado/morto) -- kill() abaixo cobre.
        }
    }
    m_process.stop(std::chrono::seconds(5));
    m_process.kill(); // no-op se já parou -- rede de segurança se requestStop()/stop() não foram suficientes
    m_arena.close();
    cleanupRunDir();
}

std::filesystem::path GhdlBackend::materializeRunDir(const std::string& runName) const {
    const fs::path runDir = fs::path(m_options.cacheRootDir) / ".run" / runName;
    std::error_code ec;
    fs::remove_all(runDir, ec);
    fs::create_directories(runDir, ec);
    if (ec) throw std::runtime_error("GhdlBackend: não foi possível criar diretório de execução: " + runDir.string());

    // Cópia (não hardlink) de propósito -- um hardlink compartilha o MESMO registro de arquivo
    // (inode/MFT) da entrada publicada, o que inclui o atributo read-only aplicado em compile()
    // (read-only vive no arquivo, não por nome de link): destravar um hardlink pra poder apagar o
    // diretório de execução destravaria a entrada de cache compartilhada junto. Cópia dá um
    // arquivo independente, livre pra destravar/remover sem tocar no cache publicado -- artefatos
    // GHDL são tipicamente pequenos (KB-baixos MB), custo de I/O é desprezível aqui.
    std::error_code listEc;
    for (const auto& entry : fs::directory_iterator(m_cacheDir, listEc)) {
        if (!entry.is_regular_file()) continue;
        std::error_code copyEc;
        fs::copy_file(entry.path(), runDir / entry.path().filename(), fs::copy_options::overwrite_existing, copyEc);
    }
    clearReadOnlyRecursive(runDir); // CopyFile/cp preservam o atributo read-only da origem por padrão
    return runDir;
}

void GhdlBackend::cleanupRunDir() {
    if (m_runDir.empty()) return;
    std::error_code ec;
    fs::remove_all(m_runDir, ec);
    m_runDir.clear();
}

bool GhdlBackend::isRunning() const { return m_process.isRunning(); }
bool GhdlBackend::peerReady() const { return m_arena.peerReady(); }

void GhdlBackend::requestAdvanceTo(uint64_t targetNs, std::span<const GhdlChangeEntry> inputs) {
    m_arena.requestAdvanceTo(targetNs, inputs);
}

GhdlAdvanceReply GhdlBackend::pollReply() { return m_arena.pollReply(); }

std::string GhdlBackend::logs() const { return m_process.logs(); }

} // namespace lasecsimul::fpga
