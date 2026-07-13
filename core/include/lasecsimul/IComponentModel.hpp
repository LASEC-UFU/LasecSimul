#pragma once

#include <cstdint>
#include <cstddef>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>
#include "Types.hpp"
#include "Transient.hpp"

namespace lasecsimul {

/** Condutância de fuga que `SimulationSession::settleStep()` aplica a todo pino listado por
 * `IComponentModel::leakagePinIndices()`, logo depois de `stamp()` -- fisicamente insignificante
 * (corrente na casa de picoampère mesmo em tensão alta), só evita que `Netlist::rebuildTopology`'s
 * regra "mesmo componente => mesmo grupo topológico" deixe o grupo inteiro singular quando um pino
 * "decorativo"/opcionalmente flutuante do componente não tem NENHUMA equação própria. Centralizado
 * aqui (achado de auditoria arquitetural 2026-07-09, D9/LeakageGuard) -- antes cada componente
 * (OpAmp/AnalogMux/ResistorArray/DiodeLegArray) repetia a mesma constante e o mesmo
 * `matrix.addConductanceToGround(pin, 1e-9)` manual dentro do próprio `stamp()`. */
inline constexpr double kLeakageGuardConductance = 1e-9;

/**
 * Descritor de UMA propriedade editável em runtime — padrão equivalente ao `ComProperty`/`StrProp<T>`
 * do SimulIDE-dev (`gui/properties/`), adaptado pra `std::function` em vez de ponteiro-pra-membro
 * porque já é o estilo usado no resto do projeto (`ComponentRegistry::Factory`,
 * `Scheduler::SettleStepFn`) — custo de chamada é irrelevante aqui (edição via UI, não caminho
 * crítico do solver), então a escolha é por consistência, não desempenho.
 *
 * Sem isto, o painel de propriedades não tinha como editar um componente já existente de forma
 * genérica — `ComponentParams` só cobria propriedade NA CRIAÇÃO. Ver .spec/lasecsimul.spec, seção 6.1.
 */
struct PropertyDescriptor {
    std::string name;
    std::string unit; // pode ser vazio
    std::function<PropertyValue()> get;
    std::function<void(const PropertyValue&)> set;
    PropertySchema schema;
};

/** Visao da matriz MNA usada por componentes nativos (built-in ou NativeDeviceProxy). */
class MnaMatrixView {
public:
    virtual ~MnaMatrixView() = default;
    virtual void addConductance(const Pin& a, const Pin& b, double siemens) = 0;

    /** Fonte de corrente ideal de a para b. Convenção MNA: corrente positiva sai de a e entra em b,
     * logo subtrai do RHS de a e soma no RHS de b. */
    virtual void addCurrent(const Pin& a, const Pin& b, double amperes) = 0;

    /** Fonte de tensão ideal a-b. Usa a variável extra (corrente do ramo) que este componente
     * reservou via `extraVariableCount()` — ver .spec/lasecsimul.spec, seção 7.3. */
    virtual void addVoltageSource(const Pin& a, const Pin& b, double volts) = 0;

    /** Pino fixado à referência (terra) com admitância alta — convenção deliberadamente simples
     * (não elimina linha/coluna como MNA "de livro"); ver .spec, seção 7.3, sobre a troca feita.
     * Só built-ins (ex: Ground) chamam isto — não exposto na ABI C de plugins (device_abi.h). */
    virtual void addConductanceToGround(const Pin& pin, double siemens) = 0;

    /** Fonte de corrente ideal referenciada à terra global — `amperes` positivo entra no pino.
     * Combinada com `addConductanceToGround` de admitância grande, fixa `pin` em
     * `amperes / siemens` Volts sem precisar de um segundo pino (ex: Rail/FixedVolt/Clock, que só
     * têm 1 terminal no SimulIDE — o "retorno" é implícito, resolvido pela referência de terra que
     * já existir em algum outro lugar do circuito). Ver .spec/lasecsimul.spec, seção 7.3. */
    virtual void addCurrentToGround(const Pin& pin, double amperes) = 0;

    virtual double getNodeVoltage(const Pin& pin) const = 0;

    /** Valor (na ÚLTIMA `solve()`) da variável extra de corrente de ramo que este componente
     * reservou via `extraVariableCount() > 0` (ex: fonte de tensão ideal) — leitura grátis, já é
     * uma incógnita resolvida, não um cálculo novo. Lança se o componente não reservou nenhuma
     * variável extra. Ver plano de leitura de corrente em `.spec/lasecsimul.spec`, seção 7.3. */
    virtual double getBranchCurrent() const = 0;
};

/**
 * Implementada por todo componente eletrico: built-in (compilado no Core) ou NativeDeviceProxy
 * (plugin DLL/SO). O MnaSolver nunca diferencia os dois caminhos — mesmo custo de chamada.
 * Ver .spec/lasecsimul.spec, secao 6.
 */
class IComponentModel {
public:
    virtual ~IComponentModel() = default;

    virtual const char* typeId() const = 0;
    virtual std::span<Pin> pins() = 0;

    /** Um endpoint visual pode representar mais de um pino elétrico (barramento). A ordem do
     * vetor é a ordem canônica dos bits, do menos significativo para o mais significativo.
     * Componentes escalares mantêm o default vazio. */
    virtual std::optional<std::vector<std::string>> busEndpointPinIds(std::string_view) const {
        return std::nullopt;
    }
    /** Notificação de reconstrução topológica; permite que instrumentos tratem um terminal
     * opcional desconectado sem inferir conectividade a partir de tensão. */
    virtual void onPinConnectionChanged(size_t, bool) {}

    /** Quantas incógnitas extras (correntes de ramo) este componente precisa no CircuitGroup —
     * 0 para tudo que não seja fonte de tensão ideal/dependente. Resolvido uma vez por rebuild de
     * topologia, nunca durante stamp() — ver .spec/lasecsimul.spec, seção 7.3. */
    virtual uint32_t extraVariableCount() const { return 0; }

    /** Só chamado quando o componente está "dirty" (topologia/propriedade mudou) — nunca a cada passo.
     * Para não-linear (isNonlinear()==true), stamp() lineariza em torno do ponto de operação atual
     * — lê via matrix.getNodeVoltage() o resultado da ÚLTIMA solve(), igual a qualquer outro
     * componente. É isso que torna a iteração de Newton-Raphson um fixed-point natural: cada
     * round de stamp+solve refina a linearização, sem mecanismo especial de "passar a estimativa". */
    virtual void stamp(MnaMatrixView& matrix) = 0;

    /** true para diodo/transistor/qualquer elemento cuja stamp() dependa do ponto de operação
     * (não pode ser resolvido num stamp+solve só). Default false — só quem precisa declara.
     * Contrato fixado agora; nenhum componente não-linear real existe ainda (sem diodo/transistor
     * implementado) — ver .spec/lasecsimul.spec, seção 7.4. */
    virtual bool isNonlinear() const { return false; }

    /** Só chamado (pelo settle-loop) para componentes com isNonlinear()==true, depois de cada
     * solve() em que participaram. Devolve true quando o ponto de operação não mudou o bastante
     * pra precisar de outra iteração — default true (componente linear "já convergiu" trivialmente,
     * nunca é nem consultado de fato). Critério de convergência real (tolerância de tensão, etc) é
     * decisão de cada componente não-linear concreto, não do Scheduler. */
    virtual bool hasConverged() const { return true; }

    /** Hot path por passo — só chamado para componentes registrados como dinâmicos (ver Scheduler). */
    virtual void postStep(uint64_t timeNs) = 0;

    /** Contrato transiente em duas fases. begin nunca confirma historico; commit so ocorre depois
     * de o passo MNA convergir. rollback descarta o candidato quando o passo for rejeitado. */
    virtual bool isReactive() const { return false; }
    virtual void beginTransientStep(const TransientStepContext&) {}
    virtual void commitTransientStep() {}
    virtual void rollbackTransientStep() {}
    virtual double transientErrorRatio(double, double) const { return 0.0; }

    virtual void onEvent(const ComponentEvent&) {}

    virtual size_t getState(uint8_t* out, size_t cap) const = 0;
    virtual void setState(const uint8_t* in, size_t len) = 0;

    /** Propriedades editáveis em runtime (painel de propriedades), separado de getState/setState
     * (serialização opaca de TODO o estado interno, não editável campo a campo). Default vazio —
     * só quem tem algo editável depois da criação declara. Não-const de propósito: o `set` de cada
     * descritor precisa poder mutar `this`. Ver .spec/lasecsimul.spec, seção 6.1. */
    virtual std::vector<PropertyDescriptor> propertyDescriptors() { return {}; }

    /** Default `Ok` -- só `NativeDeviceProxy` (plugins, via watchdog/CrashGuard) reporta outra
     * coisa. Ver .spec/lasecsimul-native-devices.spec, seção 13. */
    virtual PluginHealthStatus health() const { return PluginHealthStatus::Ok; }

    /** Chamado uma vez por `SimulationSession::addComponent()`, logo depois do `componentIndex`
     * ser decidido -- só quem precisa se auto-agendar no `Scheduler` (ex: `Clock`/`WaveGen`, que
     * recebem a referência do `Scheduler` no construtor mas só sabem o próprio índice depois de
     * criados) sobrescreve isto; default no-op pra todo o resto. */
    virtual void onAssignedIndex(uint32_t) {}

    /** Corrente elétrica no "ramo principal" deste componente, calculada a partir de estado já
     * cacheado durante a ÚLTIMA `stamp()` (sem incógnita nova na matriz, sem solve extra — opção
     * de baixo custo do plano de leitura de corrente). Convenção de sinal: positiva quando a
     * corrente flui do primeiro terminal "principal" pro segundo, mesma ordem usada no `stamp()`
     * de cada componente (ex: p1->p2 num Resistor). `std::nullopt` pra componente sem essa noção
     * (Ground, Tunnel) ou que ainda não implementa isto -- default. */
    virtual std::optional<double> current() const { return std::nullopt; }

    /** Índices locais (dentro de `pins()`) que `SimulationSession::settleStep()` deve garantir uma
     * condutância mínima até a terra (`kLeakageGuardConductance`), aplicada pelo FRAMEWORK logo
     * depois de `stamp()` retornar -- nunca dentro dele. Ver `kLeakageGuardConductance` acima pro
     * raciocínio completo (LeakageGuard, D9 do relatório de auditoria arquitetural 2026-07-09).
     * Default vazio -- só quem tem pino genuinamente opcional/decorativo declara (ex: pinos de
     * alimentação de um opamp, endereço de um mux, pernas independentes de um array). Deliberadamente
     * opt-in (não detecção automática de "diagonal zero"): um pino sem estampa nenhuma que o
     * componente NÃO declarou aqui continua produzindo "sistema singular" de verdade -- não mascara
     * erro de fiação real do usuário em componentes que nunca pediram essa rede de segurança. */
    virtual std::span<const uint32_t> leakagePinIndices() const { return {}; }
};

} // namespace lasecsimul
