#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "SignalEngine.hpp"

namespace lasecsimul::simulation {

/** Canal pedido por quem assina: uma porta de sinal (e um elemento, se vetorial) de um componente. */
struct SeriesChannelRequest {
    uint32_t componentIndex = 0;
    std::string port = "out";
    uint16_t element = 0;
};

struct SeriesSubscriptionRequest {
    std::vector<SeriesChannelRequest> channels;
    /** Grade de amostragem em tempo simulado. 0 = uma linha por passo estável em que algum valor mudou. */
    uint64_t periodNs = 0;
    uint32_t capacityRows = 65536;
};

struct SeriesEvent {
    uint64_t seq = 0;
    uint64_t timestampNs = 0;
    /** "start" (nova geração) ou "parameter" (propriedade aplicada no Core). */
    std::string kind;
    uint32_t componentIndex = std::numeric_limits<uint32_t>::max();
    std::string name;
    double value = std::numeric_limits<double>::quiet_NaN();
};

/** Fatia escoada por um tick de telemetria. `toSeq` é exclusivo; `lost` conta linhas sobrescritas no
 * anel antes de serem lidas (o leitor sabe exatamente onde há lacuna). */
struct SeriesChunk {
    uint32_t subscriptionId = 0;
    uint64_t generation = 0;
    uint64_t fromSeq = 0;
    uint64_t toSeq = 0;
    uint64_t lost = 0;
    bool more = false;
    std::vector<uint64_t> timestampsNs;
    std::vector<std::vector<double>> columns;
    std::vector<SeriesEvent> events;
    uint64_t nextEventSeq = 0;
    /** Por canal: 1 se a porta existe no plano em execução (0 = coluna NaN). */
    std::vector<uint8_t> resolved;
};

/**
 * Gravador de séries de sinais (ADR 0012). Escrito pela thread do Scheduler depois de
 * `SignalRuntime::executeUntil(t)` em cada passo estável; lido pela thread de IPC no tick de
 * telemetria. Os anéis são alocados na assinatura -- `record()` não aloca.
 *
 * Regras de gravação:
 *  - primeira linha de cada geração sempre;
 *  - `periodNs > 0`: uma linha no primeiro passo estável em ou depois de cada ponto da grade;
 *  - `periodNs == 0`: uma linha quando algum valor muda;
 *  - mesmo instante com valor diferente (descontinuidade): segunda linha no mesmo t (até 4 por t);
 *  - evento de parâmetro: linha no instante exato em que o Core aplicou a mudança.
 * Uma nova execução (id diferente) ou um relógio que volta (stop/reset) inicia uma nova geração.
 */
class SignalRecorder {
public:
    using Resolver = std::function<std::optional<SignalSlotHandle>(const SeriesChannelRequest&)>;

    static constexpr uint32_t kMaxChannels = 64;
    static constexpr uint32_t kMaxCapacityRows = 1u << 20;
    static constexpr uint64_t kMaxCells = 1ull << 22;
    static constexpr uint32_t kEventCapacity = 1024;
    static constexpr uint32_t kMaxRowsPerInstant = 4;

    uint32_t subscribe(SeriesSubscriptionRequest request) {
        if (request.channels.empty()) throw std::invalid_argument("assinatura de série sem canais");
        if (request.channels.size() > kMaxChannels) throw std::invalid_argument("assinatura de série excede 64 canais");
        if (request.capacityRows < 2 || request.capacityRows > kMaxCapacityRows)
            throw std::invalid_argument("capacidade de série fora de [2, 1048576] linhas");
        if (static_cast<uint64_t>(request.capacityRows) * (request.channels.size() + 1) > kMaxCells)
            throw std::invalid_argument("assinatura de série excede o orçamento de memória");
        Subscription sub;
        sub.request = std::move(request);
        const size_t channels = sub.request.channels.size();
        sub.times.assign(sub.request.capacityRows, 0);
        sub.columns.assign(channels, std::vector<double>(sub.request.capacityRows, 0.0));
        sub.handles.assign(channels, std::nullopt);
        sub.scratch.assign(channels, 0.0);
        sub.last.assign(channels, 0.0);
        sub.events.resize(kEventCapacity);
        std::lock_guard<std::mutex> lock(m_mutex);
        const uint32_t id = ++m_nextId;
        sub.generation = ++m_generationCounter;
        m_subscriptions.emplace(id, std::move(sub));
        m_active.store(true, std::memory_order_release);
        return id;
    }

    bool unsubscribe(uint32_t id) {
        std::lock_guard<std::mutex> lock(m_mutex);
        const bool removed = m_subscriptions.erase(id) != 0;
        m_active.store(!m_subscriptions.empty(), std::memory_order_release);
        return removed;
    }

    bool hasSubscriptions() const noexcept { return m_active.load(std::memory_order_acquire); }

    size_t subscriptionCount() const {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_subscriptions.size();
    }

    /** Thread do Scheduler, depois de `executeUntil(timestampNs)` no passo estável. */
    void record(uint64_t timestampNs, uint64_t executionId, const SignalRuntime& runtime, const Resolver& resolve) {
        if (!hasSubscriptions()) return;
        std::lock_guard<std::mutex> lock(m_mutex);
        beginExecutionLocked(executionId, timestampNs);
        for (auto& [id, sub] : m_subscriptions) {
            (void)id;
            prepareLocked(sub, timestampNs, runtime, resolve);
            if (!sub.started) { startGenerationLocked(sub, timestampNs, false); appendRowLocked(sub, timestampNs); continue; }
            const bool changed = differsFromLast(sub);
            if (timestampNs == sub.lastTimeNs) {
                if (changed && sub.rowsAtInstant < kMaxRowsPerInstant) appendRowLocked(sub, timestampNs);
                continue;
            }
            const uint64_t period = sub.request.periodNs;
            if (period == 0 ? changed : timestampNs >= sub.nextGridNs) appendRowLocked(sub, timestampNs);
        }
    }

    /** Thread do Scheduler, dentro do comando que aplicou a propriedade: evento com o tempo exato e
     * uma linha nesse instante com os valores vigentes. */
    void noteParameter(uint64_t timestampNs, uint64_t executionId, uint32_t componentIndex, const std::string& name,
                       double value, const SignalRuntime& runtime, const Resolver& resolve) {
        if (!hasSubscriptions()) return;
        std::lock_guard<std::mutex> lock(m_mutex);
        beginExecutionLocked(executionId, timestampNs);
        for (auto& [id, sub] : m_subscriptions) {
            (void)id;
            prepareLocked(sub, timestampNs, runtime, resolve);
            if (!sub.started) startGenerationLocked(sub, timestampNs, false);
            if (sub.count == 0 || timestampNs > sub.lastTimeNs ||
                (differsFromLast(sub) && sub.rowsAtInstant < kMaxRowsPerInstant))
                appendRowLocked(sub, timestampNs);
            pushEventLocked(sub, {0, timestampNs, "parameter", componentIndex, name, value});
        }
    }

    /** Thread de IPC. `generation` diferente da atual (ou ausente com `sinceSeq` 0) recomeça do início. */
    std::optional<SeriesChunk> drain(uint32_t id, std::optional<uint64_t> generation, uint64_t sinceSeq,
                                     uint64_t sinceEventSeq, uint32_t maxRows) const {
        std::lock_guard<std::mutex> lock(m_mutex);
        const auto found = m_subscriptions.find(id);
        if (found == m_subscriptions.end()) return std::nullopt;
        const Subscription& sub = found->second;
        SeriesChunk chunk;
        chunk.subscriptionId = id;
        chunk.generation = sub.generation;
        if (generation && *generation != sub.generation) { sinceSeq = 0; sinceEventSeq = 0; }
        const uint64_t capacity = sub.request.capacityRows;
        const uint64_t oldest = sub.count > capacity ? sub.count - capacity : 0;
        const uint64_t from = std::max(std::min(sinceSeq, sub.count), oldest);
        chunk.lost = from > sinceSeq ? from - sinceSeq : 0;
        const uint64_t to = std::min<uint64_t>(sub.count, from + std::max<uint32_t>(maxRows, 1));
        chunk.fromSeq = from;
        chunk.toSeq = to;
        chunk.more = to < sub.count;
        chunk.timestampsNs.reserve(to - from);
        chunk.columns.assign(sub.columns.size(), {});
        for (auto& column : chunk.columns) column.reserve(to - from);
        for (uint64_t seq = from; seq < to; ++seq) {
            const size_t slot = static_cast<size_t>(seq % capacity);
            chunk.timestampsNs.push_back(sub.times[slot]);
            for (size_t c = 0; c < sub.columns.size(); ++c) chunk.columns[c].push_back(sub.columns[c][slot]);
        }
        const uint64_t oldestEvent = sub.eventCount > kEventCapacity ? sub.eventCount - kEventCapacity : 0;
        for (uint64_t seq = std::max(sinceEventSeq, oldestEvent); seq < sub.eventCount; ++seq)
            chunk.events.push_back(sub.events[static_cast<size_t>(seq % kEventCapacity)]);
        chunk.nextEventSeq = sub.eventCount;
        chunk.resolved.reserve(sub.handles.size());
        for (const auto& handle : sub.handles) chunk.resolved.push_back(handle ? 1 : 0);
        return chunk;
    }

private:
    struct Subscription {
        SeriesSubscriptionRequest request;
        uint64_t generation = 0;
        bool started = false;
        uint64_t count = 0;
        uint64_t lastTimeNs = 0;
        uint64_t nextGridNs = 0;
        uint32_t rowsAtInstant = 0;
        std::vector<uint64_t> times;
        std::vector<std::vector<double>> columns;
        std::vector<std::optional<SignalSlotHandle>> handles;
        const void* resolvedGraph = nullptr;
        std::vector<double> scratch;
        std::vector<double> last;
        std::vector<SeriesEvent> events;
        uint64_t eventCount = 0;
    };

    void beginExecutionLocked(uint64_t executionId, uint64_t timestampNs) {
        if (executionId == m_executionId) return;
        m_executionId = executionId;
        for (auto& [id, sub] : m_subscriptions) {
            (void)id;
            if (sub.started) startGenerationLocked(sub, timestampNs, true);
        }
    }

    void startGenerationLocked(Subscription& sub, uint64_t timestampNs, bool newGeneration) {
        if (newGeneration) sub.generation = ++m_generationCounter;
        sub.started = true;
        sub.count = 0;
        sub.eventCount = 0;
        sub.rowsAtInstant = 0;
        sub.lastTimeNs = timestampNs;
        pushEventLocked(sub, {0, timestampNs, "start", std::numeric_limits<uint32_t>::max(), {}, std::numeric_limits<double>::quiet_NaN()});
    }

    /** Resolve os canais quando o plano muda, lê os valores atuais em `scratch` e detecta relógio
     * que voltou (stop/reset sem troca de id de execução). */
    void prepareLocked(Subscription& sub, uint64_t timestampNs, const SignalRuntime& runtime, const Resolver& resolve) {
        const void* graph = runtime.graph().get();
        if (graph != sub.resolvedGraph) {
            sub.resolvedGraph = graph;
            for (size_t c = 0; c < sub.handles.size(); ++c) {
                const SeriesChannelRequest& channel = sub.request.channels[c];
                std::optional<SignalSlotHandle> handle = graph ? resolve(channel) : std::nullopt;
                if (handle && channel.element >= handle->width) handle.reset();
                sub.handles[c] = handle;
            }
        }
        for (size_t c = 0; c < sub.handles.size(); ++c) {
            const auto& handle = sub.handles[c];
            const uint16_t element = sub.request.channels[c].element;
            double value = std::numeric_limits<double>::quiet_NaN();
            if (handle) {
                switch (handle->scalar) {
                case SignalScalarType::Real: value = runtime.real(*handle, element); break;
                case SignalScalarType::Bool: value = runtime.boolean(*handle, element) ? 1.0 : 0.0; break;
                case SignalScalarType::Int64: value = static_cast<double>(runtime.integer(*handle, element)); break;
                }
            }
            sub.scratch[c] = value;
        }
        if (sub.started && sub.count > 0 && timestampNs < sub.lastTimeNs) startGenerationLocked(sub, timestampNs, true);
    }

    static bool differsFromLast(const Subscription& sub) {
        if (sub.count == 0) return true;
        return std::memcmp(sub.scratch.data(), sub.last.data(), sub.scratch.size() * sizeof(double)) != 0;
    }

    void appendRowLocked(Subscription& sub, uint64_t timestampNs) {
        const size_t slot = static_cast<size_t>(sub.count % sub.request.capacityRows);
        sub.times[slot] = timestampNs;
        for (size_t c = 0; c < sub.columns.size(); ++c) sub.columns[c][slot] = sub.scratch[c];
        std::copy(sub.scratch.begin(), sub.scratch.end(), sub.last.begin());
        sub.rowsAtInstant = sub.count > 0 && timestampNs == sub.lastTimeNs ? sub.rowsAtInstant + 1 : 1;
        sub.lastTimeNs = timestampNs;
        ++sub.count;
        const uint64_t period = sub.request.periodNs;
        if (period > 0) {
            const uint64_t periods = timestampNs / period;
            sub.nextGridNs = periods >= std::numeric_limits<uint64_t>::max() / period - 1
                ? std::numeric_limits<uint64_t>::max() : (periods + 1) * period;
        }
    }

    void pushEventLocked(Subscription& sub, SeriesEvent event) {
        event.seq = sub.eventCount;
        sub.events[static_cast<size_t>(sub.eventCount % kEventCapacity)] = std::move(event);
        ++sub.eventCount;
    }

    mutable std::mutex m_mutex;
    std::map<uint32_t, Subscription> m_subscriptions;
    std::atomic<bool> m_active{false};
    uint32_t m_nextId = 0;
    uint64_t m_generationCounter = 0;
    uint64_t m_executionId = 0;
};

} // namespace lasecsimul::simulation
