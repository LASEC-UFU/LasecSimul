// Sinks: blocos só de leitura -- a leitura é amostrada pela sessão (relay da porta de entrada), sem
// kernel. O builder valida os parâmetros como o diálogo do Simulink (Display/Scope); o desenho e o
// comportamento visual (formato, decimação, janela de tempo, eixos) são da interface.
#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {
namespace {

double integerIn(const BuildContext& c, const char* name, double minimum, double maximum) {
    const double value = c.scalar(name);
    if (!(value >= minimum && value <= maximum) || value != std::floor(value))
        c.fail(std::string(name) + " precisa ser inteiro em [" + std::to_string(static_cast<long long>(minimum)) + ", " +
               std::to_string(static_cast<long long>(maximum)) + "]");
    return value;
}

void requireOption(const BuildContext& c, const char* name) {
    const ParamSpec* param = c.spec.param(name);
    const std::string value = c.text(name);
    if (param && std::find(param->options.begin(), param->options.end(), value) == param->options.end())
        c.fail(std::string(name) + " desconhecido: " + value);
}

void buildDisplay(BuildContext& c) {
    requireOption(c, "Format");
    integerIn(c, "Decimation", 1, 1e9);
    c.outputWidths = {};
}

void buildScope(BuildContext& c) {
    integerIn(c, "NumInputPorts", 1, 96);
    const lib::ParamValue layout = c.value("LayoutDimensions");
    if (layout.numel() != 2) c.fail("LayoutDimensions deve ser [linhas colunas]");
    for (double d : layout.data)
        if (!(d >= 1.0 && d <= 16.0) || d != std::floor(d)) c.fail("LayoutDimensions: cada dimensao inteira em [1, 16]");
    const double displays = layout.data[0] * layout.data[1];
    const double active = integerIn(c, "ActiveDisplay", 1, 256);
    if (active > displays) c.fail("ActiveDisplay maior que o numero de displays da grade");
    const std::string span = c.text("TimeSpan");
    if (span != "Auto" && span != "One frame period") {
        const lib::ParamValue value = c.value("TimeSpan");
        if (!value.isScalar() || !(value.data[0] > 0.0) || !std::isfinite(value.data[0])) c.fail("TimeSpan deve ser Auto, One frame period ou um numero > 0");
    }
    const lib::ParamValue limits = c.value("YLimits");
    if (limits.numel() != 2 || !(limits.data[0] < limits.data[1])) c.fail("YLimits deve ser [ymin ymax] com ymin < ymax");
    for (double offset : c.value("TimeDisplayOffset").data) if (!std::isfinite(offset)) c.fail("TimeDisplayOffset precisa ser finito");
    for (const char* name : {"MaximizeAxes", "AxesScaling", "TimeSpanOverrunAction", "TimeUnits", "TimeAxisLabels"}) requireOption(c, name);
    if (c.text("AxesScaling") == "Updates") integerIn(c, "AxesScalingNumUpdates", 1, 1e9);
    if (c.flag("DataLoggingLimitDataPoints")) integerIn(c, "DataLoggingMaxPoints", 1, 1e9);
    if (c.flag("DataLoggingDecimateData")) integerIn(c, "DataLoggingDecimation", 1, 1e9);
    c.outputWidths = {};
}

void buildTerminator(BuildContext& c) { c.outputWidths = {}; }

} // namespace

void registerSinkBuilders(BuilderTable& table) {
    table.add("display", buildDisplay);
    table.add("scope", buildScope);
    table.add("terminator", buildTerminator);
}

} // namespace lasecsimul::components::blocks::builders
