// Lookup Tables: parâmetros oficiais -> kernels de `simulation/library/kernels/LookupKernels.cpp`.
// Tabelas vão para o kernel na ordem linear do MATLAB (por coluna). O avaliador de parâmetros é 2-D
// (docs/66 §5); tabela N-D (N >= 3) vem de `reshape(dados, [n1 n2 ... nN])` -- reshape não altera a
// ordem linear, então os dados são `dados(:)` e as dimensões vêm dos argumentos -- ou, com
// breakpoints explícitos, de qualquer matriz com n1 linhas e prod(n) elementos.
#include <cctype>
#include <initializer_list>

#include "BuilderCommon.hpp"
#include "simulation/library/ParamExpr.hpp"

namespace lasecsimul::components::blocks::builders {
namespace {

constexpr size_t kMaxDims = 30;

int64_t optionIndex(const BuildContext& c, const std::string& value, std::initializer_list<const char*> options, const char* what) {
    int64_t index = 0;
    for (const char* option : options) {
        if (value == option) return index;
        ++index;
    }
    c.fail(std::string(what) + " invalido: '" + value + "'");
}

size_t dimensionCount(const BuildContext& c, const char* name) {
    const double value = c.scalar(name);
    if (!(value >= 1.0) || value > static_cast<double>(kMaxDims) || value != std::floor(value))
        c.fail(std::string(name) + " precisa ser inteiro entre 1 e 30");
    return static_cast<size_t>(value);
}

std::string trim(const std::string& text) {
    size_t begin = 0, end = text.size();
    while (begin < end && std::isspace(static_cast<unsigned char>(text[begin]))) ++begin;
    while (end > begin && std::isspace(static_cast<unsigned char>(text[end - 1]))) --end;
    return text.substr(begin, end - begin);
}

/** Argumentos de nível zero de `inner` (vírgulas fora de (), [] e {}); vazio se desbalanceado. */
std::vector<std::string> topLevelArguments(const std::string& inner) {
    std::vector<std::string> arguments;
    int depth = 0;
    size_t start = 0;
    for (size_t i = 0; i < inner.size(); ++i) {
        const char ch = inner[i];
        if (ch == '(' || ch == '[' || ch == '{') ++depth;
        else if (ch == ')' || ch == ']' || ch == '}') { if (--depth < 0) return {}; }
        else if (ch == ',' && depth == 0) { arguments.push_back(trim(inner.substr(start, i - start))); start = i + 1; }
    }
    if (depth != 0) return {};
    arguments.push_back(trim(inner.substr(start)));
    return arguments;
}

struct TableData { std::vector<double> data; std::vector<size_t> dims; bool fromReshape = false; };

lib::ParamValue evaluate(const BuildContext& c, const char* name, const std::string& text) {
    try {
        return lib::evaluateParam(text, c.resolution.workspace);
    } catch (const std::exception& error) {
        c.fail(std::string(name) + ": " + error.what());
    }
}

/** Tabela do parâmetro `name`; `reshape(X, dims)` com mais de 2 dimensões é tratado aqui. */
TableData evaluateTable(const BuildContext& c, const char* name) {
    const std::string text = trim(c.text(name));
    if (text.rfind("reshape", 0) == 0) {
        const size_t open = text.find('(');
        if (open != std::string::npos && text.back() == ')' && trim(text.substr(7, open - 7)).empty()) {
            const std::vector<std::string> arguments = topLevelArguments(text.substr(open + 1, text.size() - open - 2));
            if (arguments.size() >= 2) {
                std::vector<double> dims;
                if (arguments.size() == 2) dims = evaluate(c, name, arguments[1]).linear();
                else for (size_t i = 1; i < arguments.size(); ++i) dims.push_back(evaluate(c, name, arguments[i]).asScalar("dimensao"));
                if (dims.size() > 2) {
                    const lib::ParamValue data = evaluate(c, name, arguments[0]);
                    TableData table{data.linear(), {}, true};
                    size_t product = 1;
                    for (double d : dims) {
                        if (!(d >= 1.0) || d != std::floor(d)) c.fail(std::string(name) + ": dimensoes de reshape invalidas");
                        table.dims.push_back(static_cast<size_t>(d));
                        product *= static_cast<size_t>(d);
                    }
                    if (product != table.data.size()) c.fail(std::string(name) + ": reshape com numero de elementos diferente");
                    return table;
                }
            }
        }
    }
    const lib::ParamValue value = c.value(name);
    return {value.linear(), {value.rows, value.cols}, false};
}

/** Dimensões da tabela vistas como N-D (unitárias à direita completadas, como no MATLAB). */
std::vector<size_t> tableDims(const BuildContext& c, const TableData& table, size_t dims, const char* name) {
    if (table.data.empty()) c.fail(std::string(name) + " vazia");
    std::vector<size_t> shape = table.dims;
    while (shape.size() > 2 && shape.back() == 1) shape.pop_back();
    if (dims == 1) {
        if (shape.size() > 2 || (shape[0] != 1 && shape[1] != 1)) c.fail(std::string(name) + ": tabela 1-D precisa ser um vetor");
        return {table.data.size()};
    }
    if (shape.size() > dims) c.fail(std::string(name) + " tem mais dimensoes que o numero de dimensoes da tabela");
    while (shape.size() < dims) shape.push_back(1);
    return shape;
}

std::string shapeText(const std::vector<size_t>& shape) {
    std::string text = "[";
    for (size_t i = 0; i < shape.size(); ++i) text += (i ? " " : "") + std::to_string(shape[i]);
    return text + "]";
}

void validateBreakpoints(const BuildContext& c, const std::vector<double>& bp, const std::string& name) {
    if (bp.size() < 2) c.fail(name + " precisa ter 2 ou mais elementos");
    for (size_t i = 0; i < bp.size(); ++i) {
        if (!std::isfinite(bp[i])) c.fail(name + " precisa ser finito");
        if (i > 0 && !(bp[i] > bp[i - 1])) c.fail(name + " precisa ser estritamente crescente");
    }
}

/** `Evenly spaced points` usa só os dois primeiros breakpoints para achar o índice: aqui exigimos que
 * os breakpoints sejam de fato igualmente espaçados (então o resultado é o da busca binária). */
void requireEvenlySpaced(const BuildContext& c, const std::vector<double>& bp, const std::string& name) {
    const double spacing = bp[1] - bp[0];
    const double scale = std::max(std::abs(bp.front()), std::abs(bp.back())) + std::abs(bp.back() - bp.front());
    for (size_t i = 2; i < bp.size(); ++i)
        if (std::abs(bp[i] - (bp[0] + static_cast<double>(i) * spacing)) > 1e-9 * scale)
            c.fail("Index search method 'Evenly spaced points' exige " + name + " igualmente espacado");
}

std::vector<double> evenSpacing(const BuildContext& c, const std::string& prefix, size_t points) {
    const double first = c.scalar(prefix + "FirstPoint"), spacing = c.scalar(prefix + "Spacing");
    if (!std::isfinite(first)) c.fail(prefix + "FirstPoint precisa ser finito");
    if (!(spacing > 0.0) || !std::isfinite(spacing)) c.fail(prefix + "Spacing precisa ser positivo e finito");
    std::vector<double> bp(points);
    for (size_t j = 0; j < points; ++j) bp[j] = first + static_cast<double>(j) * spacing;
    return bp;
}

uint16_t coordinateWidth(const BuildContext& c, size_t ports) {
    size_t width = 1;
    for (size_t port = 0; port < ports; ++port) width = std::max<size_t>(width, c.inputWidth(port));
    for (size_t port = 0; port < ports; ++port)
        if (c.inputWidth(port) != 1 && c.inputWidth(port) != width)
            c.fail("largura de entrada " + std::to_string(c.inputWidth(port)) + " incompativel com " + std::to_string(width));
    if (width > 4096) c.fail("largura de sinal grande demais");
    return static_cast<uint16_t>(width);
}

constexpr std::initializer_list<const char*> kInterp = {"Flat", "Nearest", "Linear point-slope", "Linear Lagrange", "Cubic spline", "Akima spline"};
constexpr std::initializer_list<const char*> kExtrap = {"Clip", "Linear", "Cubic spline", "Akima spline"};

void buildLookupNd(BuildContext& c) {
    const size_t dims = dimensionCount(c, "NumberOfTableDimensions");
    if (c.text("DataSpecification") != "Table and breakpoints")
        c.fail("Data specification 'Lookup table object' (Simulink.LookupTable) nao suportado: use 'Table and breakpoints'");
    const int64_t interp = optionIndex(c, c.text("InterpMethod"), kInterp, "Interpolation method");
    const int64_t extrap = optionIndex(c, c.text("ExtrapMethod"), kExtrap, "Extrapolation method");
    if (extrap == 2 && interp != 4) c.fail("Extrapolation method 'Cubic spline' exige Interpolation method 'Cubic spline'");
    if (extrap == 3 && interp != 5) c.fail("Extrapolation method 'Akima spline' exige Interpolation method 'Akima spline'");
    if (interp == 5 && extrap != 3) c.fail("Interpolation method 'Akima spline' so aceita Extrapolation method 'Akima spline'");
    const bool even = c.text("BreakpointsSpecification") == "Even spacing";
    const bool tablePort = c.text("TableSource") == "Input port";
    const bool single = c.flag("UseOneInputPortForAllInputData");
    const bool evenSearch = c.text("IndexSearchMethod") == "Evenly spaced points";
    const size_t coordinatePorts = single ? 1 : dims;
    TableData table;
    std::vector<size_t> shape;
    if (!tablePort) {
        table = evaluateTable(c, "Table");
        shape = tableDims(c, table, dims, "Table");
    }
    std::vector<double> rp;
    std::vector<int64_t> counts, bpPorts;
    size_t port = coordinatePorts + (tablePort ? 1 : 0);
    for (size_t d = 0; d < dims; ++d) {
        const std::string name = "BreakpointsForDimension" + std::to_string(d + 1);
        std::vector<double> bp;
        bool fromPort = false;
        if (even) {
            size_t points = 0;
            if (!tablePort) points = shape[d];
            else if (dims == 1) points = c.inputWidth(coordinatePorts);
            else c.fail("Even spacing com tabela por porta exige 1 dimensao (sinais sao vetores 1-D)");
            if (points < 2) c.fail("tabela precisa de 2 ou mais pontos em cada dimensao (dimensao " + std::to_string(d + 1) + ")");
            bp = evenSpacing(c, name, points);
        } else if (c.text(name + "Source") == "Input port") {
            fromPort = true;
            const size_t points = c.inputWidth(port++);
            if (points < 2) c.fail("largura da porta bp" + std::to_string(d + 1) + " precisa ser >= 2");
            bp.assign(points, 0.0);
        } else {
            const lib::ParamValue value = c.value(name);
            if (!value.isVector()) c.fail(name + " precisa ser vetor");
            bp = value.linear();
            validateBreakpoints(c, bp, name);
            if (evenSearch) requireEvenlySpaced(c, bp, name);
        }
        counts.push_back(static_cast<int64_t>(bp.size()));
        bpPorts.push_back(fromPort ? 1 : 0);
        rp.insert(rp.end(), bp.begin(), bp.end());
    }
    size_t total = 1;
    std::vector<size_t> expected;
    for (int64_t n : counts) { total *= static_cast<size_t>(n); expected.push_back(static_cast<size_t>(n)); }
    if (total > (size_t{1} << 22)) c.fail("tabela grande demais (" + std::to_string(total) + " elementos)");
    if (!tablePort) {
        const bool flattened = dims >= 3 && !table.fromReshape && table.dims.size() == 2 && table.dims[0] == expected[0] && table.data.size() == total;
        if (shape != expected && !flattened)
            c.fail("Table com dimensoes " + shapeText(shape) + " difere dos breakpoints " + shapeText(expected));
        rp.insert(rp.end(), table.data.begin(), table.data.end());
    } else if (c.inputWidth(coordinatePorts) != total) {
        c.fail("largura da porta T (" + std::to_string(c.inputWidth(coordinatePorts)) + ") difere do tamanho da tabela (" + std::to_string(total) + ")");
    }
    uint16_t width = 1;
    if (single) {
        if (c.inputWidth(0) != dims) c.fail("com uma unica porta, a largura da entrada u precisa ser " + std::to_string(dims));
    } else {
        width = coordinateWidth(c, dims);
    }
    if (interp == 4 && width != 1) c.fail("Cubic spline so aceita sinais escalares (largura " + std::to_string(width) + ")");
    std::vector<int64_t> ip{static_cast<int64_t>(dims), interp, extrap, single ? 1 : 0, tablePort ? 1 : 0};
    ip.insert(ip.end(), counts.begin(), counts.end());
    ip.insert(ip.end(), bpPorts.begin(), bpPorts.end());
    simpleKernel(c, "lookup_nd", width, rp, ip);
}

void buildPrelookup(BuildContext& c) {
    const std::string specification = c.text("BreakpointsSpecification");
    if (specification == "Breakpoint object") c.fail("Specification 'Breakpoint object' (Simulink.Breakpoint) nao suportado");
    const std::string selection = c.text("OutputSelection");
    if (selection == "Index and fraction as bus") c.fail("Output selection 'Index and fraction as bus' nao suportado (sem barramentos)");
    const bool indexOnly = selection == "Index only";
    const bool linear = optionIndex(c, c.text("ExtrapMethod"), {"Clip", "Linear"}, "Extrapolation method") == 1;
    const bool bpPort = specification == "Explicit values" && c.text("BreakpointsDataSource") == "Input port";
    std::vector<double> bp;
    if (bpPort) {
        if (c.inputWidth(1) < 2) c.fail("largura da porta bp precisa ser >= 2");
        bp.assign(c.inputWidth(1), 0.0);
    } else if (specification == "Even spacing") {
        const double points = c.scalar("BreakpointsNumPoints");
        if (!(points >= 2.0) || points != std::floor(points) || points > 1e6) c.fail("Number of points precisa ser inteiro >= 2");
        const double first = c.scalar("BreakpointsFirstPoint"), spacing = c.scalar("BreakpointsSpacing");
        if (!std::isfinite(first) || !(spacing > 0.0) || !std::isfinite(spacing)) c.fail("First point finito e Spacing positivo");
        for (size_t j = 0; j < static_cast<size_t>(points); ++j) bp.push_back(first + static_cast<double>(j) * spacing);
    } else {
        const lib::ParamValue value = c.value("BreakpointsData");
        if (!value.isVector()) c.fail("Breakpoints precisa ser vetor");
        bp = value.linear();
        validateBreakpoints(c, bp, "Breakpoints");
        if (c.text("IndexSearchMethod") == "Evenly spaced points") requireEvenlySpaced(c, bp, "Breakpoints");
    }
    const uint16_t width = c.inputWidth(0);
    const int64_t useLast = !linear && c.flag("UseLastBreakpoint") ? 1 : 0;
    const std::vector<uint16_t> ports = indexOnly ? std::vector<uint16_t>{width} : std::vector<uint16_t>{width, width};
    emitWithSlices(c, "prelookup", inputWidths(c), ports, bp,
                   {linear ? 1 : 0, useLast, indexOnly ? 1 : 0, bpPort ? 1 : 0, static_cast<int64_t>(bp.size())});
}

/** Dimensões de uma tabela sem breakpoints (Interpolation Using Prelookup, Direct Lookup). */
std::vector<size_t> standaloneDims(const BuildContext& c, const TableData& table, size_t dims) {
    if (dims >= 3 && !table.fromReshape)
        c.fail("tabela com " + std::to_string(dims) + " dimensoes: escreva Table como reshape(dados, [n1 n2 ... nN])");
    return tableDims(c, table, dims, "Table");
}

void buildInterpolationUsingPrelookup(BuildContext& c) {
    const size_t dims = dimensionCount(c, "NumberOfTableDimensions");
    if (c.flag("RequireIndexFractionAsBus")) c.fail("indice e fracao como barramento nao suportado (sem barramentos)");
    if (c.text("TableSpecification") != "Explicit values") c.fail("Specification 'Lookup table object' (Simulink.LookupTable) nao suportado");
    const double selection = c.scalar("NumSelectionDims");
    if (selection != 0.0) c.fail("Number of sub-table selection dimensions diferente de 0 nao suportado");
    const int64_t interp = optionIndex(c, c.text("InterpMethod"), {"Flat", "Nearest", "Linear point-slope", "Linear Lagrange"}, "Interpolation method");
    const bool linearExtrap = optionIndex(c, c.text("ExtrapMethod"), {"Clip", "Linear"}, "Extrapolation method") == 1;
    const bool tablePort = c.text("TableSource") == "Input port";
    std::vector<size_t> shape;
    std::vector<double> data;
    if (tablePort) {
        if (dims != 1) c.fail("tabela por porta exige 1 dimensao (sinais sao vetores 1-D)");
        shape = {c.inputWidth(2 * dims)};
    } else {
        const TableData table = evaluateTable(c, "Table");
        shape = standaloneDims(c, table, dims);
        data = table.data;
    }
    for (size_t d = 0; d < dims; ++d)
        if (shape[d] < 2) c.fail("tabela precisa de 2 ou mais pontos em cada dimensao (dimensao " + std::to_string(d + 1) + ", largura " + std::to_string(shape[d]) + ")");
    const uint16_t width = coordinateWidth(c, 2 * dims);
    std::vector<int64_t> ip{static_cast<int64_t>(dims), interp, linearExtrap ? 1 : 0, tablePort ? 1 : 0};
    for (size_t n : shape) ip.push_back(static_cast<int64_t>(n));
    simpleKernel(c, "interpolation_prelookup", width, data, ip);
}

void buildDirectLookup(BuildContext& c) {
    const size_t dims = dimensionCount(c, "NumberOfTableDimensions");
    const auto mode = static_cast<size_t>(optionIndex(c, c.text("InputsSelectThisObjectFromTable"), {"Element", "Vector", "2-D Matrix"}, "Inputs select this object from table"));
    if (mode > dims) c.fail("selecionar " + std::string(mode == 1 ? "vetor" : "matriz") + " exige tabela com " + std::to_string(mode) + " ou mais dimensoes");
    const bool tablePort = c.flag("TableIsInput");
    const size_t indices = dims - mode;
    std::vector<size_t> shape;
    std::vector<double> data;
    if (tablePort) {
        if (dims != 1) c.fail("tabela por porta exige 1 dimensao (sinais sao vetores 1-D)");
        shape = {c.inputWidth(indices)};
    } else {
        const TableData table = evaluateTable(c, "Table");
        shape = standaloneDims(c, table, dims);
        data = table.data;
    }
    uint16_t width = 1;
    if (mode == 0) {
        width = coordinateWidth(c, indices);
    } else {
        for (size_t port = 0; port < indices; ++port)
            if (c.inputWidth(port) != 1) c.fail("indices precisam ser escalares ao selecionar vetor/matriz (largura " + std::to_string(c.inputWidth(port)) + ")");
        const size_t selected = mode == 1 ? shape[0] : shape[0] * shape[1];
        if (selected > 4096) c.fail("largura de saida grande demais");
        width = static_cast<uint16_t>(selected);
    }
    std::vector<int64_t> ip{static_cast<int64_t>(dims), static_cast<int64_t>(mode), tablePort ? 1 : 0};
    for (size_t n : shape) ip.push_back(static_cast<int64_t>(n));
    simpleKernel(c, "direct_lookup_nd", width, data, ip);
}

void buildLookupTableDynamic(BuildContext& c) {
    const int64_t method = optionIndex(c, c.text("LookUpMeth"),
                                       {"Interpolation-Extrapolation", "Interpolation-Use End Values", "Use Input Nearest", "Use Input Below", "Use Input Above"},
                                       "Lookup Method");
    if (c.inputWidth(1) < 2 || c.inputWidth(2) != c.inputWidth(1))
        c.fail("xdat e ydat precisam ter a mesma largura, >= 2 (xdat " + std::to_string(c.inputWidth(1)) + ", ydat " + std::to_string(c.inputWidth(2)) + ")");
    simpleKernel(c, "lookup_table_dynamic", c.inputWidth(0), {}, {method});
}

} // namespace

void registerLookupBuilders(BuilderTable& table) {
    table.add("lookup_nd", buildLookupNd);
    table.add("prelookup", buildPrelookup);
    table.add("interpolation_using_prelookup", buildInterpolationUsingPrelookup);
    table.add("direct_lookup_nd", buildDirectLookup);
    table.add("lookup_table_dynamic", buildLookupTableDynamic);
}

} // namespace lasecsimul::components::blocks::builders
