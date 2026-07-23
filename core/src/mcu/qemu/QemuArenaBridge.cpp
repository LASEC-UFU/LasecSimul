#include "QemuArenaBridge.hpp"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <stdexcept>

#if defined(_WIN32)
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace lasecsimul::mcu::qemu {

namespace {

std::string posixSharedMemoryName(const std::string& name) {
    if (!name.empty() && name.front() == '/') return name;
    return "/" + name;
}

QemuArenaEvent copyArenaEvent(const LsdnQemuArena& arena) {
    return QemuArenaEvent{arena.simuTime,    arena.qemuTime,       arena.regData,
                          arena.regAddr,     arena.irqNumber,      arena.irqLevel,
                          arena.simuAction,  arena.loop_timeout_ns, arena.ps_per_inst,
                          arena.running != 0};
}

/** PERF-13 (protocolo v3, ver qemu_arena_abi.h): copia uma entrada da fila de escritas/heartbeat
 * -- irqNumber/irqLevel/qemuTime/loop_timeout_ns/ps_per_inst são estado GLOBAL do chip (não
 * por-entrada, a fila nunca carregou esses campos, ver LsdnQemuQueueEntry), então vêm do arena
 * como um todo, não da entrada -- mesmo valor que copyArenaEvent() já leria pra qualquer evento
 * neste instante. */
QemuArenaEvent copyQueueEntry(const LsdnQemuArena& arena, const LsdnQemuQueueEntry& entry) {
    return QemuArenaEvent{entry.simuTime,  arena.qemuTime,        entry.regData,
                          entry.regAddr,   arena.irqNumber,      arena.irqLevel,
                          entry.simuAction, arena.loop_timeout_ns, arena.ps_per_inst,
                          arena.running != 0};
}

} // namespace

class QemuArenaBridge::SharedMemory {
public:
    SharedMemory(const std::string& name, size_t size, bool createIfMissing) : m_size(size) {
#if defined(_WIN32)
        const std::wstring wideName(name.begin(), name.end());
        m_handle = createIfMissing
                       ? CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                            static_cast<DWORD>(m_size), wideName.c_str())
                       : OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, wideName.c_str());
        if (!m_handle) throw std::runtime_error("Failed to open QEMU shared memory: " + name);
        m_view = MapViewOfFile(m_handle, FILE_MAP_ALL_ACCESS, 0, 0, m_size);
        if (!m_view) {
            CloseHandle(m_handle);
            m_handle = nullptr;
            throw std::runtime_error("Failed to map QEMU shared memory: " + name);
        }
#else
        const std::string shmName = posixSharedMemoryName(name);
        m_name = shmName;
        m_owner = createIfMissing;
        const int flags = createIfMissing ? (O_CREAT | O_RDWR) : O_RDWR;
        m_fd = shm_open(shmName.c_str(), flags, 0600);
        if (m_fd < 0) throw std::runtime_error("Failed to open QEMU shared memory: " + shmName);
        if (createIfMissing && ftruncate(m_fd, static_cast<off_t>(m_size)) != 0) {
            ::close(m_fd);
            m_fd = -1;
            throw std::runtime_error("Failed to size QEMU shared memory: " + shmName);
        }
        m_view = mmap(nullptr, m_size, PROT_READ | PROT_WRITE, MAP_SHARED, m_fd, 0);
        if (m_view == MAP_FAILED) {
            ::close(m_fd);
            m_fd = -1;
            m_view = nullptr;
            throw std::runtime_error("Failed to map QEMU shared memory: " + shmName);
        }
#endif
    }

    ~SharedMemory() {
#if defined(_WIN32)
        if (m_view) UnmapViewOfFile(m_view);
        if (m_handle) CloseHandle(m_handle);
#else
        if (m_view) munmap(m_view, m_size);
        if (m_fd >= 0) ::close(m_fd);
        if (m_owner && !m_name.empty()) shm_unlink(m_name.c_str());
#endif
    }

    void* data() const { return m_view; }

private:
    size_t m_size = 0;
    void* m_view = nullptr;
#if defined(_WIN32)
    HANDLE m_handle = nullptr;
#else
    int m_fd = -1;
    std::string m_name;
    bool m_owner = false;
#endif
};

QemuArenaBridge::QemuArenaBridge() = default;
QemuArenaBridge::~QemuArenaBridge() = default;

void QemuArenaBridge::setMemoryRegions(std::span<const MemoryRegion> regions) {
    m_regions.assign(regions.begin(), regions.end());
    std::sort(m_regions.begin(), m_regions.end(), [](const MemoryRegion& a, const MemoryRegion& b) {
        return a.start < b.start;
    });
}

void QemuArenaBridge::open(const QemuArenaOpenOptions& options) {
    close();
    if (options.name.empty()) throw std::runtime_error("QEMU shared memory name is empty");
    m_sharedMemory = std::make_unique<SharedMemory>(options.name, sizeof(LsdnQemuArena), options.createIfMissing);
    m_arena = static_cast<LsdnQemuArena*>(m_sharedMemory->data());
}

void QemuArenaBridge::close() {
    m_arena = nullptr;
    m_sharedMemory.reset();
}

bool QemuArenaBridge::isOpen() const { return m_arena != nullptr; }
LsdnQemuArena* QemuArenaBridge::arena() { return m_arena; }
const LsdnQemuArena* QemuArenaBridge::arena() const { return m_arena; }

QemuPollResult QemuArenaBridge::poll() {
    if (!m_arena) return QemuPollResult{false, std::nullopt, std::nullopt, "QEMU arena is not open"};

    // Achado 2026-07-22 (usuário reporta simulação travando por completo depois de rodar por um
    // tempo, indicador de velocidade continua marcando 100%): `queueWriteIndex` é escrito pelo
    // processo QEMU (outro processo, `pushQueueEntry()` em simuliface.c) -- sem um load de
    // aquisição aqui, pareado com a store de liberação de lá, o padrão de memória do C++ não
    // garante que os campos da entrada (`regAddr`/`regData`/`simuAction`/`simuTime`, escritos
    // ANTES de lá incrementar o índice) já estejam visíveis pra este processo quando o índice
    // aparenta ter avançado -- uma leitura "adiantada" da entrada podia estourar o cálculo de
    // tempo de evento (`McuComponent.cpp::qemuEventTimeNs`) e travar aquela entrada (e tudo atrás
    // dela na fila de 32) pra sempre, sem o Scheduler elétrico (relógio independente) perceber.
    // `std::atomic_ref` não muda o layout do `LsdnQemuArena` compartilhado (mesmo campo, mesmo
    // tipo) -- só a disciplina de acesso.
    const uint64_t queueWriteIndex =
        std::atomic_ref<uint64_t>(m_arena->queueWriteIndex).load(std::memory_order_acquire);

    // PERF-13 (protocolo v3): a fila de escritas/heartbeat tem prioridade sobre o slot único de
    // leitura -- corresponde exatamente à ordem que o lado QEMU já garante (readReg() espera a
    // fila esvaziar de vez antes de emitir SIM_READ, ver waitForQueueDrain() em simuliface.c),
    // então nunca há as duas coisas pendentes ao mesmo tempo na prática -- mas checar a fila
    // primeiro deixa isso correto por construção, não só por coincidência de timing.
    // `queueReadIndex` é escrito só por ESTE processo (ver acknowledgeWrite()), então uma leitura
    // simples basta pro lado de cá.
    if (m_arena->queueReadIndex != queueWriteIndex) {
        const uint64_t slot = m_arena->queueReadIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH;
        const LsdnQemuQueueEntry& entry = m_arena->queue[slot];

        // NÃO confirma aqui de propósito (ver acknowledgeWrite()) -- ler a entrada não pode, por
        // si só, liberar espaço na fila antes do módulo certo processar o registrador.
        QemuPollResult result;
        result.hasEvent = true;
        result.event = copyQueueEntry(*m_arena, entry);
        if (result.event->simuAction == LSDN_SIM_WRITE) result.dispatch = dispatch(result.event->regAddr);
        return result;
    }

    if (m_arena->simuTime == 0) return {};

    // Fora da fila: só SIM_READ chega aqui no protocolo v3 (escritas/heartbeat são sempre
    // publicados na fila acima, nunca mais neste slot único -- ver qemu_arena_abi.h).
    QemuPollResult result;
    result.hasEvent = true;
    result.event = copyArenaEvent(*m_arena);
    if (result.event->simuAction == LSDN_SIM_READ) result.dispatch = dispatch(result.event->regAddr);
    return result;
}

void QemuArenaBridge::acknowledgeWrite() {
    // PERF-13 (protocolo v3): escritas/heartbeat vêm da fila agora -- confirma avançando o
    // índice de leitura (libera um slot pro QEMU publicar a próxima entrada), nunca mais zerando
    // m_arena->simuTime (isso é só do slot único de leitura, ver acknowledgeRead()). No-op se a
    // fila já estiver vazia (não deveria acontecer -- só chamado depois de poll() achar uma
    // entrada -- mas seguro por construção mesmo assim).
    //
    // Achado 2026-07-22 (ver comentário de poll() acima): `queueReadIndex` é lido pelo processo
    // QEMU (`waitForSynch()`/`waitForQueueDrain()` em simuliface.c, que decidem se o vCPU pode
    // continuar publicando entradas novas) -- store de liberação aqui pareia com o load de
    // aquisição de lá.
    if (!m_arena) return;
    const uint64_t queueWriteIndex =
        std::atomic_ref<uint64_t>(m_arena->queueWriteIndex).load(std::memory_order_acquire);
    if (m_arena->queueReadIndex != queueWriteIndex) {
        std::atomic_ref<uint64_t>(m_arena->queueReadIndex)
            .store(m_arena->queueReadIndex + 1, std::memory_order_release);
    }
}

void QemuArenaBridge::acknowledgeRead(uint64_t regData) {
    if (!m_arena) return;
    m_arena->regData = regData;
    m_arena->qemuAction = LSDN_SIM_READ;
    m_arena->simuTime = 0;
}

QemuDispatchResult QemuArenaBridge::dispatch(uint64_t address) const {
    const auto it = std::upper_bound(m_regions.begin(), m_regions.end(), address,
                                     [](uint64_t value, const MemoryRegion& region) {
                                         return value < region.start;
                                     });
    if (it == m_regions.begin()) {
        return QemuDispatchResult{false, {}, "No MemoryRegion matches address 0x" + std::to_string(address)};
    }

    const MemoryRegion& candidate = *(it - 1);
    if (address >= candidate.start && address <= candidate.end) return QemuDispatchResult{true, candidate, {}};
    return QemuDispatchResult{false, {}, "No MemoryRegion matches address 0x" + std::to_string(address)};
}

} // namespace lasecsimul::mcu::qemu
