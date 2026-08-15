#include "GhdlBackend.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>

#include "lasecsimul/Sha256.hpp"

namespace lasecsimul::fpga {

namespace fs = std::filesystem;

namespace {

std::string uniqueArenaName(const std::string& topEntity) {
    return "lasecsimul-fpga-" + topEntity + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

} // namespace

GhdlBackend::GhdlBackend(GhdlBackendOptions options) : m_options(std::move(options)) {}
GhdlBackend::~GhdlBackend() { stop(); }

std::string GhdlBackend::computeCacheKey(const RtlCompileRequest& request) const {
    // SHA-256 do conteúdo REAL das fontes (não só o caminho -- um arquivo editado sem mudar de
    // nome precisa invalidar o cache) + top + standard, na ordem dada (ordem importa pra análise
    // -- ver plano seção 24). Nunca versiona o artefato compilado (plano seção 23): a chave só
    // decide o NOME do subdiretório de cache, que fica fora da árvore de fontes do usuário.
    Sha256 hasher;
    for (const std::string& source : request.sources) {
        std::ifstream file(source, std::ios::binary);
        if (!file) throw std::runtime_error("GhdlBackend: não foi possível ler fonte VHDL: " + source);
        std::ostringstream buffer;
        buffer << file.rdbuf();
        const std::string content = buffer.str();
        hasher.update(reinterpret_cast<const uint8_t*>(content.data()), content.size());
        static constexpr uint8_t kSeparator = 0;
        hasher.update(&kSeparator, 1); // evita colisão "ab"+"c" == "a"+"bc" na concatenação do hash
    }
    hasher.update(reinterpret_cast<const uint8_t*>(request.topEntity.data()), request.topEntity.size());
    hasher.update(reinterpret_cast<const uint8_t*>(request.standard.data()), request.standard.size());
    return hasher.finalizeHex();
}

RtlCompileResult GhdlBackend::compile(const RtlCompileRequest& request) {
    RtlCompileResult result;
    const std::string cacheKey = computeCacheKey(request);
    const fs::path cacheDir = fs::path(m_options.cacheRootDir) / cacheKey;
    const fs::path markerPath = cacheDir / ".lasecsimul-fpga-cache-ok";

    if (fs::exists(markerPath)) {
        result.ok = true;
        result.log = "(cache hit -- " + cacheDir.string() + ")";
        m_cacheDir = cacheDir.string();
        m_compiledRequest = request;
        m_compiled = true;
        return result;
    }

    std::error_code ec;
    fs::remove_all(cacheDir, ec); // build anterior parcial/falho -- não confiar em restos
    fs::create_directories(cacheDir, ec);
    if (ec) {
        result.ok = false;
        result.log = "GhdlBackend: não foi possível criar diretório de cache: " + cacheDir.string();
        return result;
    }

    std::ostringstream combinedLog;
    for (const std::string& source : request.sources) {
        GhdlProcessManager analyze;
        analyze.start(GhdlLaunchSpec{m_options.ghdlBinary, {"-a", "--std=" + request.standard, source}, {},
                                     cacheDir.string(), {}});
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
        cacheDir.string(), {}});
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

    std::ofstream marker(markerPath);
    marker << request.topEntity << "\n" << request.standard << "\n";
    marker.close();

    result.ok = true;
    result.log = combinedLog.str();
    m_cacheDir = cacheDir.string();
    m_compiledRequest = request;
    m_compiled = true;
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

    // Processo PRÓPRIO, independente de `m_process`/`start()`/`stop()` -- discover é uma rodada
    // curta e autocontida (sem arena, sem lockstep), não o processo de simulação de longa duração.
    GhdlProcessManager discover;
    GhdlLaunchSpec spec{
        m_options.ghdlBinary,
        {"-r", "--std=" + m_compiledRequest.standard, m_compiledRequest.topEntity, "--vpi=" + m_options.vpiModulePath},
        {},
        m_cacheDir,
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

    GhdlLaunchSpec spec{
        m_options.ghdlBinary,
        {"-r", "--std=" + m_compiledRequest.standard, m_compiledRequest.topEntity, "--vpi=" + m_options.vpiModulePath},
        {},
        m_cacheDir,
        {{"LASECSIMUL_FPGA_MODE", "run"}, {"LASECSIMUL_FPGA_ARENA_NAME", arenaName}, {"PATH", pathOverride}}};
    m_process.start(spec);
}

void GhdlBackend::stop() {
    if (!m_process.isRunning()) return;
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
}

bool GhdlBackend::isRunning() const { return m_process.isRunning(); }
bool GhdlBackend::peerReady() const { return m_arena.peerReady(); }

void GhdlBackend::requestAdvanceTo(uint64_t targetNs, std::span<const GhdlChangeEntry> inputs) {
    m_arena.requestAdvanceTo(targetNs, inputs);
}

GhdlAdvanceReply GhdlBackend::pollReply() { return m_arena.pollReply(); }

std::string GhdlBackend::logs() const { return m_process.logs(); }

} // namespace lasecsimul::fpga
