// Signal Routing: parâmetros oficiais -> kernels de `RoutingKernels.cpp` (concat, slice, switch,
// multiport_switch, index_vector, manual_switch, selector, merge, passthrough). Blocos de
// roteamento que dependem de infraestrutura de compilação (Goto/From, Data Store, State
// Reader/Writer, barramentos, variantes) não estão aqui -- ver o relatório da família.
#include <algorithm>
#include <cctype>
#include <cmath>
#include <map>
#include <optional>

#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {

// Definidas em AttributeBuilders.cpp (tipo de dado de saída emulado no domínio do valor).
bool isIdentityDataType(const BuildContext& c, const std::string& text);
void emitDataTypeConversion(BuildContext& c, const std::string& id, const std::string& source, uint16_t width, const std::string& text,
                            const std::string& rounding, bool saturate, bool storedInteger);
std::optional<double> optionalLimit(const BuildContext& c, const char* name);
int64_t roundingMode(const BuildContext& c, const std::string& text);

namespace {

std::string trimmed(const std::string& text) {
    size_t begin = 0, end = text.size();
    while (begin < end && std::isspace(static_cast<unsigned char>(text[begin]))) ++begin;
    while (end > begin && std::isspace(static_cast<unsigned char>(text[end - 1]))) --end;
    return text.substr(begin, end - begin);
}

/** Inteiro exato (índices, contagens). */
bool isInteger(double value) { return std::isfinite(value) && value == std::floor(value); }

/** Kernel principal publicando a saída 1, com a conversão de `OutDataTypeStr` no fim quando o tipo
 * não é herança/double (Switch, Multiport Switch). */
void emitWithOutputType(BuildContext& c, const char* kernelId, std::vector<uint16_t> inputs, uint16_t width, std::vector<double> rp,
                        std::vector<int64_t> ip) {
    const std::string type = c.text("OutDataTypeStr");
    const bool identity = isIdentityDataType(c, type);
    (void)roundingMode(c, c.text("RndMeth"));
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    const std::string core = identity ? c.outputBlock(0) : c.outputBlock(0) + "::sel";
    c.kernel(core, kernelId, std::move(inputs), width, std::move(rp), std::move(ip));
    c.connectInputs(core);
    if (!identity) emitDataTypeConversion(c, c.outputBlock(0), core, width, type, c.text("RndMeth"), c.flag("SaturateOnIntegerOverflow"), false);
}

// ------------------------------------------------------------------------------- Mux / Demux

/** Mux: concatena as entradas. `Inputs` = N (qualquer largura por porta) ou vetor de larguras
 * ([2 3]; -1 aceita qualquer largura). Célula ({...}) e lista de nomes de sinal são formatos oficiais
 * que as regras de porta compartilhadas ainda não contam (resultam em zero portas). */
void buildMux(BuildContext& c) {
    if (c.inputPorts.empty())
        c.fail("Number of inputs sem portas: use um inteiro ou um vetor de larguras (celula e lista de nomes ainda nao suportadas)");
    std::vector<double> declared;
    try {
        const lib::ParamValue value = lib::evaluateParam(c.text("Inputs"), c.resolution.workspace);
        if (value.numel() > 1) declared = value.data;
    } catch (const std::exception&) {
    }
    size_t total = 0;
    for (size_t port = 0; port < c.inputPorts.size(); ++port) {
        const uint16_t width = c.inputWidth(port);
        if (port < declared.size()) {
            const double expected = declared[port];
            if (!isInteger(expected) || (expected < 1.0 && expected != -1.0)) c.fail("Number of inputs: largura invalida no vetor");
            if (expected != -1.0 && expected != width)
                c.fail("largura da entrada " + std::to_string(port + 1) + " (" + std::to_string(width) + ") difere da declarada em Number of inputs (" +
                       std::to_string(static_cast<int>(expected)) + ")");
        }
        total += width;
    }
    if (total == 0 || total > 4096) c.fail("largura do Mux invalida");
    simpleKernel(c, "concat", static_cast<uint16_t>(total));
}

/** Larguras das saídas do Demux para a entrada de largura `n` (tabela da documentação); vazio =
 * combinação recusada (mensagem em `error`). */
std::vector<uint16_t> demuxWidths(const lib::ParamValue& outputs, size_t n, size_t ports, std::string& error) {
    std::vector<uint16_t> widths;
    if (outputs.numel() > 1) {
        size_t fixed = 0, inferred = 0;
        for (double w : outputs.data) {
            if (!isInteger(w) || (w < 1.0 && w != -1.0)) { error = "Number of outputs: larguras de saida invalidas"; return {}; }
            if (w == -1.0) ++inferred; else fixed += static_cast<size_t>(w);
        }
        if (inferred == 0 && fixed != n) {
            error = "soma das larguras (" + std::to_string(fixed) + ") difere da largura da entrada (" + std::to_string(n) + ")";
            return {};
        }
        if (inferred > 0 && (fixed > n || n - fixed < inferred)) {
            error = "larguras fixas (" + std::to_string(fixed) + ") nao deixam ao menos 1 elemento por saida -1 (largura da entrada " + std::to_string(n) + ")";
            return {};
        }
        // As saídas -1 dividem o restante o mais igualmente possível (as primeiras recebem a sobra).
        const size_t rest = inferred > 0 ? n - fixed : 0;
        size_t index = 0;
        for (double w : outputs.data) {
            if (w != -1.0) { widths.push_back(static_cast<uint16_t>(w)); continue; }
            widths.push_back(static_cast<uint16_t>(rest / inferred + (index < rest % inferred ? 1 : 0)));
            ++index;
        }
        return widths;
    }
    const size_t p = ports;
    if (p == 0) { error = "Number of outputs invalido"; return {}; }
    if (p > n) {
        error = "Number of outputs (" + std::to_string(p) + ") maior que a largura da entrada (" + std::to_string(n) + ")";
        return {};
    }
    // n mod p = m: m saídas com floor(n/p)+1 elementos e p-m com floor(n/p).
    for (size_t i = 0; i < p; ++i) widths.push_back(static_cast<uint16_t>(n / p + (i < n % p ? 1 : 0)));
    return widths;
}

void buildDemux(BuildContext& c) {
    const lib::ParamValue outputs = c.value("Outputs");
    const size_t input = c.inputWidth(0);
    std::string error;
    std::vector<uint16_t> widths = demuxWidths(outputs, input, c.outputPorts.size(), error);
    if (widths.empty()) {
        // Durante a propagação a largura da entrada ainda pode ser provisória: saídas escalares.
        if (c.widthsOnly) { c.outputWidths.assign(c.outputPorts.size(), 1); return; }
        c.fail(error);
    }
    c.outputWidths = widths;
    if (c.widthsOnly) return;
    int64_t offset = 0;
    for (size_t port = 0; port < widths.size() && port < c.outputPorts.size(); ++port) {
        c.kernel(c.outputBlock(port), "slice", {static_cast<uint16_t>(input)}, widths[port], {}, {offset});
        c.connect(c.inputBlock(0), c.outputBlock(port), 1);
        offset += widths[port];
    }
}

// ------------------------------------------------------------------------------------ Switch

/** Largura comum de entradas de dados com expansão escalar; `AllowDiffInputSizes` ligado com
 * larguras diferentes exigiria sinal de tamanho variável (não existe aqui). */
size_t dataWidth(const BuildContext& c, const std::vector<size_t>& ports, bool allowDifferent) {
    size_t width = 1;
    for (size_t port : ports) width = std::max<size_t>(width, c.inputWidth(port));
    for (size_t port : ports) {
        const size_t w = c.inputWidth(port);
        if (w == width) continue;
        if (allowDifferent) c.fail("entradas de dados com larguras diferentes geram sinal de tamanho variavel, que nao existe no LasecSimul");
        if (w != 1) c.fail("largura de entrada " + std::to_string(w) + " incompativel com " + std::to_string(width));
    }
    return width;
}

void buildSwitch(BuildContext& c) {
    const std::string criteria = c.text("Criteria");
    const int64_t code = criteria == "u2 >= Threshold" ? 0 : criteria == "u2 > Threshold" ? 1 : criteria == "u2 ~= 0" ? 2 : -1;
    if (code < 0) c.fail("Criteria for passing first input invalido: " + criteria);
    std::vector<double> threshold{0.0};
    if (code != 2) {
        threshold = c.value("Threshold").linear();
        if (threshold.empty()) c.fail("Threshold vazio");
        const std::optional<double> lower = optionalLimit(c, "OutMin"), upper = optionalLimit(c, "OutMax");
        for (double t : threshold) {
            if (std::isnan(t)) c.fail("Threshold NaN");
            if ((lower && t < *lower) || (upper && t > *upper)) c.fail("Threshold precisa ficar entre Output minimum e Output maximum");
        }
    }
    const size_t data = dataWidth(c, {0, 2}, c.flag("AllowDiffInputSizes"));
    size_t width = std::max({data, static_cast<size_t>(c.inputWidth(1)), threshold.size()});
    if (width > 4096) c.fail("largura de sinal grande demais");
    if (c.inputWidth(1) != 1 && c.inputWidth(1) != width) c.fail("largura do controle incompativel com a saida");
    if (threshold.size() != 1 && threshold.size() != width) c.fail("Threshold com largura incompativel com a saida");
    if (data != 1 && data != width) c.fail("largura das entradas de dados incompativel com a saida");
    emitWithOutputType(c, "switch", inputWidths(c), static_cast<uint16_t>(width), threshold, {code, c.flag("ZeroCross") ? 1 : 0});
}

// --------------------------------------------------------------------------- Multiport Switch

/** `Data port indices`: célula `{1,[2 3],4}` (uma porta por célula) ou vetor `[1 2 3]` (uma porta por
 * elemento). Enumerações não existem aqui. */
std::vector<std::vector<double>> dataPortIndices(const BuildContext& c) {
    const std::string text = trimmed(c.text("DataPortIndices"));
    if (text.rfind("enumeration", 0) == 0) c.fail("Data port indices com enumeracao: tipos enumerados nao existem no LasecSimul");
    std::vector<std::vector<double>> ports;
    const auto evaluate = [&](const std::string& item) {
        try {
            return lib::evaluateParam(item, c.resolution.workspace);
        } catch (const std::exception& error) {
            c.fail(std::string("Data port indices: ") + error.what());
        }
    };
    if (text.size() >= 2 && text.front() == '{' && text.back() == '}') {
        int depth = 0;
        std::string current;
        const std::string inner = text.substr(1, text.size() - 2);
        for (size_t i = 0; i <= inner.size(); ++i) {
            const char ch = i < inner.size() ? inner[i] : ',';
            if (ch == '(' || ch == '[') ++depth;
            if (ch == ')' || ch == ']') --depth;
            if (ch == ',' && depth == 0) {
                if (trimmed(current).empty()) c.fail("Data port indices: celula vazia");
                ports.push_back(evaluate(current).linear());
                current.clear();
                continue;
            }
            current += ch;
        }
    } else {
        for (double index : evaluate(text).linear()) ports.push_back({index});
    }
    if (ports.empty()) c.fail("Data port indices vazio");
    return ports;
}

void buildMultiportSwitch(BuildContext& c) {
    const std::string order = c.text("DataPortOrder");
    const bool additional = c.text("DataPortForDefault") == "Additional data port";
    const std::string diagnostic = c.text("DiagnosticForDefault");
    const int64_t diagnosticCode = diagnostic == "None" ? 0 : diagnostic == "Warning" ? 1 : diagnostic == "Error" ? 2 : -1;
    if (diagnosticCode < 0) c.fail("Diagnostic for default case invalido: " + diagnostic);
    (void)optionalLimit(c, "OutMin");
    (void)optionalLimit(c, "OutMax");
    std::vector<std::vector<double>> indices;
    bool indexVector = false;
    int64_t base = 1;
    if (order == "One-based contiguous" || order == "Zero-based contiguous") {
        base = order == "Zero-based contiguous" ? 0 : 1;
        const double n = c.scalar("Inputs");
        if (!isInteger(n) || n < 1.0 || n > 65535.0) c.fail("Number of data ports precisa ser inteiro entre 1 e 65535");
        for (int64_t j = 0; j < static_cast<int64_t>(n); ++j) indices.push_back({static_cast<double>(base + j)});
        indexVector = n == 1.0;
    } else if (order == "Specify indices") {
        indices = dataPortIndices(c);
    } else {
        c.fail("Data port order invalido: " + order);
    }
    const size_t n = indices.size();
    if (c.inputPorts.size() != 1 + n + (additional ? 1 : 0))
        c.fail("Data port indices define " + std::to_string(n) + " portas de dados, mas o bloco tem " + std::to_string(c.inputPorts.size() - 1 - (additional ? 1 : 0)) +
               " (a regra de portas conta elementos de vetor; use [1 2 3] em vez de celula)");
    if (c.inputWidth(0) != 1) c.fail("largura do controle (" + std::to_string(c.inputWidth(0)) + ") precisa ser 1");
    std::vector<int64_t> ip;
    if (indexVector) {
        // Index Vector: o controle escolhe o ELEMENTO do único vetor de dados; saída escalar.
        emitWithOutputType(c, "index_vector", inputWidths(c), 1, {}, {base, additional ? 1 : 0, diagnosticCode});
        return;
    }
    std::map<int64_t, int64_t> owner;
    std::vector<int64_t> pairs;
    for (size_t port = 0; port < n; ++port) {
        if (indices[port].empty()) c.fail("Data port indices: celula vazia");
        for (double index : indices[port]) {
            if (!isInteger(index)) c.fail("Data port indices precisam ser inteiros");
            if (!owner.emplace(static_cast<int64_t>(index), static_cast<int64_t>(port)).second)
                c.fail("Data port indices repetido: " + std::to_string(static_cast<int64_t>(index)));
            pairs.push_back(static_cast<int64_t>(index));
            pairs.push_back(static_cast<int64_t>(port));
        }
    }
    std::vector<size_t> dataPorts;
    for (size_t port = 1; port < c.inputPorts.size(); ++port) dataPorts.push_back(port);
    const size_t width = dataWidth(c, dataPorts, c.flag("AllowDiffInputSizes"));
    if (width > 4096) c.fail("largura de sinal grande demais");
    ip = {static_cast<int64_t>(n), additional ? 1 : 0, diagnosticCode, static_cast<int64_t>(pairs.size() / 2)};
    ip.insert(ip.end(), pairs.begin(), pairs.end());
    emitWithOutputType(c, "multiport_switch", inputWidths(c), static_cast<uint16_t>(width), {}, ip);
}

// ----------------------------------------------------------------------------- Manual Switch

void buildManualSwitch(BuildContext& c) {
    const std::string position = trimmed(c.text("sw"));
    if (position != "0" && position != "1") c.fail("sw precisa ser '1' (entrada de cima) ou '0' (entrada de baixo)");
    const size_t width = dataWidth(c, {0, 1}, c.flag("varsize"));
    if (width > 4096) c.fail("largura de sinal grande demais");
    simpleKernel(c, "manual_switch", static_cast<uint16_t>(width), {position == "1" ? 1.0 : 0.0});
}

// ---------------------------------------------------------------------------------- Selector

void buildSelector(BuildContext& c) {
    if (c.scalar("NumberOfDimensions") != 1.0)
        c.fail("Number of input dimensions diferente de 1: sinais do LasecSimul sao vetores (1-D)");
    const std::string indexMode = c.text("IndexMode");
    if (indexMode != "One-based" && indexMode != "Zero-based") c.fail("Index mode invalido: " + indexMode);
    const int64_t base = indexMode == "Zero-based" ? 0 : 1;
    const std::string option = c.text("IndexOptions");
    const uint16_t input = c.inputWidth(0);
    const double declared = c.scalar("InputPortWidth");
    if (declared != -1.0 && (!isInteger(declared) || declared < 1.0)) c.fail("Input port size precisa ser -1 ou inteiro positivo");
    if (!c.widthsOnly && declared != -1.0 && declared != input)
        c.fail("largura da entrada (" + std::to_string(input) + ") difere de Input port size (" + std::to_string(static_cast<int>(declared)) + ")");
    const auto outputSize = [&]() {
        const double size = c.scalar("OutputSizes");
        if (!isInteger(size) || size < 1.0 || size > 4096.0) c.fail("Output Size precisa ser inteiro positivo");
        return static_cast<uint16_t>(size);
    };
    int64_t mode = 0;
    uint16_t width = input;
    std::vector<double> rp;
    if (option == "Select all") {
        mode = 0;
    } else if (option == "Index vector (dialog)") {
        mode = 1;
        const std::vector<double> indices = c.value("Indices").linear();
        if (indices.empty() || indices.size() > 4096) c.fail("Index vazio");
        for (double index : indices) {
            if (!isInteger(index)) c.fail("Index precisa ter inteiros");
            if (!c.widthsOnly && (index - base < 0.0 || index - base >= input))
                c.fail("indice " + std::to_string(static_cast<int64_t>(index)) + " faixa fora do vetor de entrada (largura " + std::to_string(input) + ")");
            rp.push_back(index - static_cast<double>(base));
        }
        width = static_cast<uint16_t>(indices.size());
    } else if (option == "Index vector (port)") {
        mode = 2;
        width = c.inputPorts.size() > 1 ? c.inputWidth(1) : 1;
    } else if (option == "Starting index (dialog)") {
        mode = 3;
        const double start = c.scalar("Indices");
        if (!isInteger(start)) c.fail("Index (indice inicial) precisa ser inteiro");
        width = outputSize();
        if (!c.widthsOnly && (start - base < 0.0 || start - base + width > input))
            c.fail("faixa fora do vetor de entrada: inicio " + std::to_string(static_cast<int64_t>(start)) + ", Output Size " + std::to_string(width) +
                   ", largura " + std::to_string(input));
        rp = {start - static_cast<double>(base)};
    } else if (option == "Starting index (port)") {
        mode = 4;
        width = outputSize();
    } else if (option == "Starting and ending indices (port)") {
        c.fail("'Starting and ending indices (port)' gera sinal de tamanho variavel, que nao existe no LasecSimul");
    } else {
        c.fail("Index Option invalida: " + option);
    }
    simpleKernel(c, "selector", width, rp, {mode, base});
}

// ------------------------------------------------------------------------------------- Merge

void buildMerge(BuildContext& c) {
    const size_t n = c.inputPorts.size();
    if (n == 0) c.fail("Number of inputs precisa ser inteiro positivo");
    const bool unequal = c.flag("AllowUnequalInputPortWidths");
    std::vector<int64_t> offsets(n, 0);
    size_t width = 0;
    if (unequal) {
        const std::vector<double> given = c.value("InputPortOffsets").linear();
        if (!given.empty() && given.size() != n) c.fail("Input port offsets precisa ter um deslocamento por entrada");
        for (size_t port = 0; port < n; ++port) {
            const double offset = given.empty() ? 0.0 : given[port];
            if (!isInteger(offset) || offset < 0.0) c.fail("Input port offsets precisam ser inteiros >= 0");
            offsets[port] = static_cast<int64_t>(offset);
            width = std::max<size_t>(width, static_cast<size_t>(offset) + c.inputWidth(port));
        }
    } else {
        width = c.inputWidth(0);
        for (size_t port = 1; port < n; ++port)
            if (c.inputWidth(port) != width)
                c.fail("entradas com larguras diferentes (" + std::to_string(width) + " e " + std::to_string(c.inputWidth(port)) +
                       ") exigem Allow unequal port widths");
    }
    if (width == 0 || width > 4096) c.fail("largura de sinal invalida");
    std::vector<double> initial = c.value("InitialOutput").linear();
    if (initial.empty()) initial = {0.0}; // [] no modo de inicialização simplificado: valor padrão do tipo (0)
    initial = expandTo(c, initial, width, "Initial output");
    std::vector<int64_t> ip{static_cast<int64_t>(n)};
    ip.insert(ip.end(), offsets.begin(), offsets.end());
    simpleKernel(c, "merge", static_cast<uint16_t>(width), initial, ip);
}

// --------------------------------------------------------------------- Environment Controller

/** Bloco removido do Simulink que ainda aparece em modelos antigos: em simulação a saída é a entrada
 * Sim (a entrada Coder só vale em geração de código). */
void buildEnvironmentController(BuildContext& c) {
    const uint16_t width = c.inputWidth(0);
    if (c.inputWidth(1) != width)
        c.fail("largura de Sim (" + std::to_string(width) + ") difere da largura de Coder (" + std::to_string(c.inputWidth(1)) + ")");
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    c.kernel("", "passthrough", {width}, width);
    c.connect(c.inputBlock(0), c.outputBlock(0), 1);
}

} // namespace

void registerRoutingBuilders(BuilderTable& table) {
    table.add("mux", buildMux);
    table.add("demux", buildDemux);
    table.add("switch", buildSwitch);
    table.add("multiport_switch", buildMultiportSwitch);
    table.add("manual_switch", buildManualSwitch);
    table.add("selector", buildSelector);
    table.add("merge", buildMerge);
    table.add("environment_controller", buildEnvironmentController);
}

} // namespace lasecsimul::components::blocks::builders
