#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "simulation/SignalEngine.hpp"
#include "simulation/SignalRecorder.hpp"

using namespace lasecsimul::simulation;

namespace {
int failures = 0;
#define CHECK(expr, message) do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); ++failures; } } while (false)

constexpr uint64_t kMs = 1'000'000ull;

/** Rampa: integrador contínuo de uma fonte 1.0 (x = t) e um ganho discreto a 10 ms (y = 2·x). */
SignalGraphDefinition rampGraph() {
    SignalGraphDefinition graph;
    SignalBlockDefinition one;
    one.id = "one"; one.kind = SignalBlockKind::Source; one.realParameters = {1.0}; one.rate = {10 * kMs, 0, 0};
    SignalBlockDefinition ramp;
    ramp.id = "ramp"; ramp.kind = SignalBlockKind::Integrator; ramp.inputs = {{"in", {SignalScalarType::Real, 1}, ""}};
    ramp.realParameters = {1.0, 0.0}; ramp.rate = {10 * kMs, 0, 0};
    SignalBlockDefinition twice;
    twice.id = "twice"; twice.kind = SignalBlockKind::Gain; twice.inputs = {{"in", {SignalScalarType::Real, 1}, ""}};
    twice.realParameters = {2.0}; twice.rate = {10 * kMs, 0, 0};
    graph.blocks = {one, ramp, twice};
    graph.connections = {{"one", "out", "ramp", "in", false}, {"ramp", "out", "twice", "in", false}};
    return graph;
}

const std::vector<std::string> kBlocks = {"one", "ramp", "twice"};

SignalRecorder::Resolver resolverFor(const SignalRuntime& runtime) {
    return [&runtime](const SeriesChannelRequest& channel) -> std::optional<SignalSlotHandle> {
        if (channel.componentIndex >= kBlocks.size()) return std::nullopt;
        return runtime.output(kBlocks[channel.componentIndex]);
    };
}

/** Avança `steps` passos contínuos de `stepNs` gravando cada passo estável, como a sessão. */
void run(SignalRuntime& runtime, SignalRecorder& recorder, uint64_t& now, uint64_t stepNs, int steps, uint64_t executionId) {
    const auto resolve = resolverFor(runtime);
    for (int i = 0; i < steps; ++i) {
        runtime.beginContinuousStep(now, now + stepNs);
        runtime.commitContinuousStep();
        now += stepNs;
        runtime.executeUntil(now);
        recorder.record(now, executionId, runtime, resolve);
    }
}

std::vector<SeriesChunk> drainAll(const SignalRecorder& recorder, uint32_t id, uint32_t maxRows) {
    std::vector<SeriesChunk> chunks;
    uint64_t since = 0, sinceEvent = 0;
    std::optional<uint64_t> generation;
    for (int guard = 0; guard < 100000; ++guard) {
        auto chunk = recorder.drain(id, generation, since, sinceEvent, maxRows);
        if (!chunk) break;
        generation = chunk->generation;
        since = chunk->toSeq;
        sinceEvent = chunk->nextEventSeq;
        const bool more = chunk->more;
        chunks.push_back(std::move(*chunk));
        if (!more) break;
    }
    return chunks;
}

void gridAtBlockPeriodIsIndependentOfDrainRate() {
    SignalRuntime runtime;
    runtime.bind(SignalCompiler::compile(rampGraph()));
    runtime.executeUntil(0);
    SignalRecorder recorder;
    const uint32_t id = recorder.subscribe({{{1, "out", 0}, {2, "out", 0}}, 10 * kMs, 4096});
    const void* storage = runtime.realStorageAddress();
    uint64_t now = 0;
    recorder.record(0, 7, runtime, resolverFor(runtime));
    // Passos de 1 ms (como o passo máximo do Scheduler), 10 s simulados, grade de 10 ms.
    run(runtime, recorder, now, kMs, 10'000, 7);
    CHECK(runtime.realStorageAddress() == storage, "armazenamento do runtime estável durante a gravação");

    for (uint32_t perTick : {1u, 50u, 1001u, 16384u}) {
        const std::vector<SeriesChunk> chunks = drainAll(recorder, id, perTick);
        uint64_t rows = 0, lost = 0;
        uint64_t previous = 0;
        bool monotonic = true, exact = true;
        for (const SeriesChunk& chunk : chunks) {
            lost += chunk.lost;
            for (size_t r = 0; r < chunk.timestampsNs.size(); ++r) {
                const uint64_t t = chunk.timestampsNs[r];
                if (rows > 0 && t < previous) monotonic = false;
                previous = t;
                const double expected = static_cast<double>(t) * 1e-9;
                if (std::abs(chunk.columns[0][r] - expected) > 1e-9 || std::abs(chunk.columns[1][r] - 2 * expected) > 1e-9) exact = false;
                ++rows;
            }
        }
        CHECK(rows == 1001, "10 s com grade de 10 ms produz 1001 linhas (t = 0 incluído) em qualquer cadência de leitura");
        CHECK(lost == 0, "nenhuma linha perdida com anel suficiente");
        CHECK(monotonic, "tempo nunca decresce");
        CHECK(exact, "valores gravados são os do bloco no instante (x = t, y = 2t)");
    }
}

void ringOverflowReportsLostRows() {
    SignalRuntime runtime;
    runtime.bind(SignalCompiler::compile(rampGraph()));
    runtime.executeUntil(0);
    SignalRecorder recorder;
    const uint32_t id = recorder.subscribe({{{1, "out", 0}}, 10 * kMs, 100});
    uint64_t now = 0;
    run(runtime, recorder, now, 10 * kMs, 250, 1);
    const auto chunk = recorder.drain(id, std::nullopt, 0, 0, 1000);
    CHECK(chunk && chunk->lost == 150, "anel de 100 linhas após 250 gravações informa 150 perdidas");
    CHECK(chunk && chunk->fromSeq == 150 && chunk->toSeq == 250, "entrega exatamente as 100 mais recentes");
    CHECK(chunk && chunk->timestampsNs.front() == 1510 * kMs, "primeira linha retida é a de t = 1,51 s");
}

void generationsAndEvents() {
    SignalRuntime runtime;
    runtime.bind(SignalCompiler::compile(rampGraph()));
    runtime.executeUntil(0);
    SignalRecorder recorder;
    const uint32_t id = recorder.subscribe({{{1, "out", 0}, {9, "out", 0}}, 10 * kMs, 1024});
    uint64_t now = 0;
    run(runtime, recorder, now, 10 * kMs, 10, 1);
    auto first = recorder.drain(id, std::nullopt, 0, 0, 1000);
    CHECK(first && first->resolved.size() == 2 && first->resolved[0] == 1 && first->resolved[1] == 0,
          "canal sem porta no plano fica marcado como não resolvido");
    CHECK(first && std::isnan(first->columns[1].front()), "canal não resolvido grava NaN");
    CHECK(first && !first->events.empty() && first->events.front().kind == "start", "geração começa com evento start");

    // Parâmetro aplicado entre dois passos (fora da grade): linha no instante exato + evento.
    now += 3 * kMs;
    runtime.executeUntil(now);
    recorder.noteParameter(now, 1, 4, "value", 0.25, runtime, resolverFor(runtime));
    auto after = recorder.drain(id, first->generation, first->toSeq, first->nextEventSeq, 1000);
    CHECK(after && after->timestampsNs.size() == 1 && after->timestampsNs.front() == 103 * kMs,
          "evento de parâmetro grava uma linha no tempo aplicado (103 ms)");
    CHECK(after && after->events.size() == 1 && after->events.front().kind == "parameter" &&
          after->events.front().timestampNs == 103 * kMs && after->events.front().value == 0.25 &&
          after->events.front().name == "value", "evento parameter traz tempo, nome e valor");

    // Mesmo instante com valor diferente: segunda linha no mesmo t (descontinuidade).
    SignalRuntime other;
    other.bind(SignalCompiler::compile(rampGraph()));
    other.executeUntil(0);
    for (int i = 0; i < 5; ++i) { other.beginContinuousStep(i * 10 * kMs, (i + 1) * 10 * kMs); other.commitContinuousStep(); other.executeUntil((i + 1) * 10 * kMs); }
    recorder.record(now, 1, other, resolverFor(other));
    auto twin = recorder.drain(id, first->generation, after->toSeq, after->nextEventSeq, 1000);
    CHECK(twin && twin->timestampsNs.size() == 1 && twin->timestampsNs.front() == 103 * kMs,
          "valor diferente no mesmo t gera segunda linha no mesmo instante");

    // Nova execução: nova geração, sequência recomeça, leitor com geração antiga recomeça do zero.
    uint64_t restart = 0;
    SignalRuntime fresh;
    fresh.bind(SignalCompiler::compile(rampGraph()));
    fresh.executeUntil(0);
    recorder.record(0, 2, fresh, resolverFor(fresh));
    run(fresh, recorder, restart, 10 * kMs, 3, 2);
    auto next = recorder.drain(id, first->generation, twin->toSeq, twin->nextEventSeq, 1000);
    CHECK(next && next->generation != first->generation, "nova execução incrementa a geração");
    CHECK(next && next->fromSeq == 0 && next->timestampsNs.size() == 4 && next->timestampsNs.front() == 0,
          "leitor da geração antiga recebe a nova desde a primeira linha");
    CHECK(next && next->lost == 0, "troca de geração não conta como perda");

    CHECK(recorder.unsubscribe(id) && !recorder.hasSubscriptions(), "cancelar a última assinatura desliga o gravador");
    CHECK(!recorder.drain(id, std::nullopt, 0, 0, 10), "assinatura cancelada não escoa");
}

void rejectsInvalidSubscriptions() {
    SignalRecorder recorder;
    bool threw = false;
    try { recorder.subscribe({{}, 0, 100}); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw, "assinatura sem canais é rejeitada");
    threw = false;
    try { recorder.subscribe({{{0, "out", 0}}, 0, 1}); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw, "capacidade abaixo de 2 é rejeitada");
    threw = false;
    try { recorder.subscribe({std::vector<SeriesChannelRequest>(65), 0, 100}); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw, "mais de 64 canais é rejeitado");
}
} // namespace

int main() {
    gridAtBlockPeriodIsIndependentOfDrainRate();
    ringOverflowReportsLostRows();
    generationsAndEvents();
    rejectsInvalidSubscriptions();
    if (failures == 0) std::puts("SignalRecorderTest: OK");
    return failures == 0 ? 0 : 1;
}
