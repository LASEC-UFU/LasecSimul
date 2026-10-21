// PID Controller / PID Controller (2DOF) e as variantes discretas: parâmetros oficiais -> kernel
// `pid` de `simulation/library/kernels/PidKernels.cpp` (layout de ip/rp documentado lá; os índices
// abaixo precisam ficar idênticos aos de lá -- os testes da família cobrem cada papel de porta).
//
// Tempo de amostragem: o parâmetro `SampleTime` só vale com `TimeDomain = Discrete-time` (como no
// diálogo do Simulink). Com `Continuous-time` o kernel e as fatias de saída são emitidos com taxa
// contínua. PID Controller/(2DOF) declaram taxa contínua na especificação (o caso padrão fica
// coerente para quem herda a taxa a jusante); Discrete PID Controller/(2DOF) declaram `SampleTime`.
#include <limits>

#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {
namespace {

// Espelho de PidIp/PidRole/PidRp de PidKernels.cpp.
enum PidIp : size_t {
    PidWidth = 0, PidTwoDof, PidTerms, PidIdeal, PidDiscrete, PidIntMethod, PidFiltMethod, PidUseFilter, PidUseKiTs,
    PidResetMode, PidIcOutput, PidIcExternal, PidLimit, PidAntiWindup, PidTracking, PidLimitIntegrator, PidPreInt,
    PidPortBase
};
enum PidRole : size_t {
    RoleU = 0, RoleY, RoleP, RoleI, RoleD, RoleN, RoleB, RoleC, RoleReset, RoleI0, RoleD0, RoleUp, RoleLo, RoleTr, RoleExtAw,
    PidRoleCount
};
enum PidRp : size_t { RpP = 0, RpI, RpD, RpN, RpB, RpC, RpIcI, RpIcF, RpUpper, RpLower, RpIntUpper, RpIntLower, RpVectorCount };

int64_t methodCode(const BuildContext& c, const char* name) {
    const std::string method = c.text(name);
    if (method == "Forward Euler") return 0;
    if (method == "Backward Euler") return 1;
    if (method == "Trapezoidal") return 2;
    c.fail(std::string(name) + " invalido: '" + method + "' (Forward Euler, Backward Euler ou Trapezoidal)");
}

int64_t roleOfPort(const std::string& id) {
    if (id == "in1") return RoleU;
    if (id == "in2") return RoleY;
    if (id == "p") return RoleP;
    if (id == "i") return RoleI;
    if (id == "d") return RoleD;
    if (id == "n") return RoleN;
    if (id == "b") return RoleB;
    if (id == "c") return RoleC;
    if (id == "reset") return RoleReset;
    if (id == "i0") return RoleI0;
    if (id == "d0") return RoleD0;
    if (id == "up") return RoleUp;
    if (id == "lo") return RoleLo;
    if (id == "tr") return RoleTr;
    if (id == "extaw") return RoleExtAw;
    return -1;
}

void buildPid(BuildContext& c, bool twoDof) {
    const std::string controller = c.text("Controller");
    int64_t terms = 0;
    if (controller == "PID") terms = 7;
    else if (controller == "PI") terms = 3;
    else if (controller == "PD") terms = 5;
    else if (controller == "P" && !twoDof) terms = 1;
    else if (controller == "I" && !twoDof) terms = 2;
    else c.fail("Controller invalido: '" + controller + (twoDof ? "' (PID, PI ou PD)" : "' (PID, PI, PD, P ou I)"));
    const bool hasP = (terms & 1) != 0, hasI = (terms & 2) != 0, hasD = (terms & 4) != 0;

    const std::string form = c.text("Form");
    if (form != "Parallel" && form != "Ideal") c.fail("Form invalido: '" + form + "' (Parallel ou Ideal)");
    const std::string domain = c.text("TimeDomain");
    if (domain != "Continuous-time" && domain != "Discrete-time") c.fail("Time domain invalido: '" + domain + "'");
    const bool discrete = domain == "Discrete-time";
    // Taxa do kernel. Contínuo: sempre contínua. Discreto: a resolvida pela sessão (Sample time
    // explícito ou herdado das entradas) nos blocos da biblioteca Discrete; nos blocos da biblioteca
    // Continuous a taxa declarada é contínua (o caso padrão, Time domain contínuo), então o período
    // vem do Sample time explícito.
    simulation::SignalRate kernelRate{0, 0, 0};
    if (discrete) {
        if (c.flag("UseExternalTs"))
            c.fail("'PID Controller is inside a conditionally executed subsystem' (porta TDTI) exige subsistema condicionalmente "
                   "executado, que o LasecSimul nao tem");
        if (c.spec.sampleTime == SampleTimeKind::Continuous) {
            const std::vector<double> sampleTime = c.value("SampleTime").linear();
            if (sampleTime.empty() || sampleTime.size() > 2) c.fail("Sample time deve ser Ts ou [Ts, offset]");
            const double period = sampleTime[0], offset = sampleTime.size() == 2 ? sampleTime[1] : 0.0;
            if (period == -1.0)
                c.fail("Discrete-time exige tempo de amostragem discreto: neste bloco (biblioteca Continuous) defina Sample time > 0 "
                       "(heranca -1 so no Discrete PID Controller)");
            if (!(period > 0.0) || !std::isfinite(period) || !(offset >= 0.0) || offset >= period)
                c.fail("Discrete-time exige tempo de amostragem discreto (Ts > 0 e 0 <= offset < Ts)");
            kernelRate = {static_cast<uint64_t>(nanoseconds(c, period, "Sample time")), static_cast<uint64_t>(nanoseconds(c, offset, "Sample time offset")), 0};
            if (kernelRate.periodNs == 0) c.fail("Sample time menor que 1 ns");
        } else {
            kernelRate = c.resolution.rate;
            if (kernelRate.continuous() || kernelRate.periodNs >= simulation::kConstantSamplePeriodNs)
                c.fail("Discrete-time exige tempo de amostragem discreto (defina Sample time > 0 ou ligue a um sinal discreto)");
        }
    }
    const bool filtered = !discrete || c.flag("UseFilter");
    const bool parametersExternal = c.text("ControllerParametersSource") == "external";
    const bool icExternal = c.text("InitialConditionSource") == "external";
    const bool limit = c.flag("LimitOutput");
    const bool limitsExternal = limit && c.text("SatLimitsSource") == "external";
    const bool tracking = hasI && c.flag("TrackingMode");
    const bool limitIntegrator = hasI && c.flag("LimitIntegratorOutput");
    int64_t antiWindup = 0;
    if (limit && hasI) {
        const std::string mode = c.text("AntiWindupMode");
        if (mode == "back-calculation") antiWindup = 1;
        else if (mode == "clamping") antiWindup = 2;
        else if (mode == "external") antiWindup = 3;
        else if (mode != "none") c.fail("Anti-windup method invalido: '" + mode + "'");
    }
    const std::string icSetting = c.text("InitialConditionSetting");
    if (icSetting != "Auto" && icSetting != "Output") c.fail("Initial condition setting invalido: '" + icSetting + "' (Auto ou Output)");
    const std::string resetText = c.text("ExternalReset");
    const int64_t reset = resetMode(resetText);
    if (reset == 0 && resetText != "none") c.fail("External reset invalido: '" + resetText + "'");
    if (reset == 5) c.fail("External reset 'level hold' nao existe neste bloco (none, rising, falling, either, level)");

    // Parâmetros vetoriais usados (os demais ficam com um valor neutro).
    struct Vector { size_t slot; const char* name; bool used; double neutral; };
    const Vector vectors[] = {
        {RpP, "P", hasP && !parametersExternal, 0.0},
        {RpI, "I", hasI && !parametersExternal, 0.0},
        {RpD, "D", hasD && !parametersExternal, 0.0},
        {RpN, "N", hasD && filtered && !parametersExternal, 0.0},
        {RpB, "b", twoDof && !parametersExternal, 1.0},
        {RpC, "c", twoDof && hasD && !parametersExternal, 1.0},
        {RpIcI, "InitialConditionForIntegrator", hasI && !icExternal, 0.0},
        {RpIcF, filtered ? "InitialConditionForFilter" : "DifferentiatorICPrevScaledInput", hasD && !icExternal, 0.0},
        {RpUpper, "UpperSaturationLimit", limit && !limitsExternal, std::numeric_limits<double>::infinity()},
        {RpLower, "LowerSaturationLimit", limit && !limitsExternal, -std::numeric_limits<double>::infinity()},
        {RpIntUpper, "UpperIntegratorSaturationLimit", limitIntegrator, std::numeric_limits<double>::infinity()},
        {RpIntLower, "LowerIntegratorSaturationLimit", limitIntegrator, -std::numeric_limits<double>::infinity()},
    };
    std::vector<std::vector<double>> values(RpVectorCount);
    size_t n = 1;
    for (size_t port = 0; port < c.inputPorts.size(); ++port) n = std::max<size_t>(n, c.inputWidth(port));
    for (const Vector& v : vectors) {
        if (!v.used) { values[v.slot] = {v.neutral}; continue; }
        values[v.slot] = c.value(v.name).linear();
        if (values[v.slot].empty()) c.fail(std::string(v.name) + " vazio");
        n = std::max(n, values[v.slot].size());
    }
    if (n > 4096) c.fail("largura de sinal grande demais");
    for (const Vector& v : vectors) values[v.slot] = expandTo(c, values[v.slot], n, v.name);

    // Validação (como o Simulink recusa).
    for (size_t i = 0; i < n; ++i) {
        if (hasD && filtered && !parametersExternal && !std::isfinite(values[RpN][i]))
            c.fail("N = Inf nao e suportado (derivada ideal sem filtro); use um coeficiente de filtro finito");
        if (!std::isfinite(values[RpIcI][i])) c.fail("a condicao inicial do integrador nao pode ser NaN ou Inf");
        if (!std::isfinite(values[RpIcF][i])) c.fail(std::string(filtered ? "a condicao inicial do filtro" : "a condicao inicial do diferenciador") + " nao pode ser NaN ou Inf");
        if (limit && !limitsExternal) {
            const double up = values[RpUpper][i], lo = values[RpLower][i];
            if (lo > up) c.fail("Lower limit maior que Upper limit");
            // Desde o R2022b: condição inicial do integrador/filtro fora dos limites da saída é erro.
            if (hasI && !icExternal && (values[RpIcI][i] > up || values[RpIcI][i] < lo))
                c.fail("a condicao inicial do integrador esta fora dos limites de saturacao da saida");
            if (hasD && filtered && !icExternal && (values[RpIcF][i] > up || values[RpIcF][i] < lo))
                c.fail("a condicao inicial do filtro esta fora dos limites de saturacao da saida");
        }
        if (limitIntegrator && values[RpIntLower][i] > values[RpIntUpper][i]) c.fail("limite inferior do integrador maior que o superior");
    }
    const double kb = antiWindup == 1 ? c.scalar("Kb") : 0.0;
    const double kt = tracking ? c.scalar("Kt") : 0.0;
    if (!std::isfinite(kb) || !std::isfinite(kt)) c.fail("Kb e Kt precisam ser finitos");

    std::vector<double> rp;
    rp.reserve(RpVectorCount * n + 2);
    for (const auto& vector : values) rp.insert(rp.end(), vector.begin(), vector.end());
    rp.push_back(kb);
    rp.push_back(kt);

    std::vector<int64_t> ip(PidPortBase + PidRoleCount, -1);
    ip[PidWidth] = static_cast<int64_t>(n);
    ip[PidTwoDof] = twoDof ? 1 : 0;
    ip[PidTerms] = terms;
    ip[PidIdeal] = form == "Ideal" ? 1 : 0;
    ip[PidDiscrete] = discrete ? 1 : 0;
    ip[PidIntMethod] = discrete && hasI ? methodCode(c, "IntegratorMethod") : 0;
    ip[PidFiltMethod] = discrete && hasD && filtered ? methodCode(c, "FilterMethod") : 0;
    ip[PidUseFilter] = filtered ? 1 : 0;
    ip[PidUseKiTs] = discrete && hasI && c.flag("UseKiTs") ? 1 : 0;
    ip[PidResetMode] = reset;
    ip[PidIcOutput] = icSetting == "Output" ? 1 : 0;
    ip[PidIcExternal] = icExternal ? 1 : 0;
    ip[PidLimit] = limit ? 1 : 0;
    ip[PidAntiWindup] = antiWindup;
    ip[PidTracking] = tracking ? 1 : 0;
    ip[PidLimitIntegrator] = limitIntegrator ? 1 : 0;
    const bool preInt = std::find(c.outputPorts.begin(), c.outputPorts.end(), "preint") != c.outputPorts.end();
    ip[PidPreInt] = preInt ? 1 : 0;
    for (size_t port = 0; port < c.inputPorts.size(); ++port) {
        const int64_t role = roleOfPort(c.inputPorts[port]);
        if (role < 0) c.fail("porta desconhecida: " + c.inputPorts[port]);
        ip[PidPortBase + static_cast<size_t>(role)] = static_cast<int64_t>(port);
    }
    for (size_t port = 0; port < c.inputPorts.size(); ++port)
        if (c.inputWidth(port) != 1 && c.inputWidth(port) != n)
            c.fail("largura de entrada " + std::to_string(c.inputWidth(port)) + " incompativel com " + std::to_string(n));

    std::vector<uint16_t> ports{static_cast<uint16_t>(n)};
    if (preInt) ports.push_back(static_cast<uint16_t>(n));
    const size_t first = c.graph.blocks.size();
    emitWithSlices(c, "pid", inputWidths(c), ports, rp, ip);
    for (size_t index = first; index < c.graph.blocks.size(); ++index) c.graph.blocks[index].rate = kernelRate;
}

void buildPidController(BuildContext& c) { buildPid(c, false); }
void buildPidController2Dof(BuildContext& c) { buildPid(c, true); }

} // namespace

void registerPidBuilders(BuilderTable& table) {
    table.add("pid_controller", buildPidController);
    table.add("pid_controller_2dof", buildPidController2Dof);
    table.add("discrete_pid_controller", buildPidController);
    table.add("discrete_pid_controller_2dof", buildPidController2Dof);
}

} // namespace lasecsimul::components::blocks::builders
