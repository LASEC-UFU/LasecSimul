#include "GhdlArenaBridge.hpp"

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

namespace lasecsimul::fpga {

namespace {

std::string posixSharedMemoryName(const std::string& name) {
    if (!name.empty() && name.front() == '/') return name;
    return "/" + name;
}

size_t totalMappingSize(uint32_t inputCapacity, uint32_t outputCapacity) {
    return sizeof(LsdnFpgaArenaDescriptor) + sizeof(LsdnFpgaArenaTransport) +
           static_cast<size_t>(inputCapacity) * sizeof(LsdnFpgaChangeEntry) +
           static_cast<size_t>(outputCapacity) * sizeof(LsdnFpgaChangeEntry);
}

} // namespace

/** Ao contrário de `QemuArenaBridge::SharedMemory` (tamanho fixo, conhecido em tempo de
 * compilação), o tamanho aqui só é conhecido em runtime (depende da contagem de bits do
 * componente FPGA) -- então quem ANEXA numa arena já existente (não cria) precisa primeiro
 * mapear só o descriptor (tamanho fixo) pra descobrir as capacidades reais, e só então remapear a
 * view inteira. No Windows isso exige duas chamadas de `MapViewOfFile` (não há API pra consultar
 * o tamanho de um mapeamento já aberto); no POSIX, `fstat` no fd já revela o tamanho real do
 * segmento de uma vez, então o remap é sempre um no-op lá. */
class GhdlArenaBridge::SharedMemory {
public:
    SharedMemory(const std::string& name, bool createIfMissing, size_t createSize) : m_owner(createIfMissing) {
#if defined(_WIN32)
        const std::wstring wideName(name.begin(), name.end());
        if (createIfMissing) {
            m_handle = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                          static_cast<DWORD>(static_cast<uint64_t>(createSize) >> 32),
                                          static_cast<DWORD>(createSize & 0xffffffffu), wideName.c_str());
        } else {
            m_handle = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, wideName.c_str());
        }
        if (!m_handle) throw std::runtime_error("Failed to open GHDL shared memory: " + name);
        mapView(createIfMissing ? createSize : sizeof(LsdnFpgaArenaDescriptor));
#else
        const std::string shmName = posixSharedMemoryName(name);
        m_name = shmName;
        const int flags = createIfMissing ? (O_CREAT | O_RDWR) : O_RDWR;
        m_fd = shm_open(shmName.c_str(), flags, 0600);
        if (m_fd < 0) throw std::runtime_error("Failed to open GHDL shared memory: " + shmName);
        size_t mapSize = createSize;
        if (createIfMissing) {
            if (ftruncate(m_fd, static_cast<off_t>(createSize)) != 0) {
                ::close(m_fd);
                m_fd = -1;
                throw std::runtime_error("Failed to size GHDL shared memory: " + shmName);
            }
        } else {
            struct stat st{};
            if (fstat(m_fd, &st) != 0) {
                ::close(m_fd);
                m_fd = -1;
                throw std::runtime_error("Failed to stat GHDL shared memory: " + shmName);
            }
            mapSize = static_cast<size_t>(st.st_size);
        }
        mapView(mapSize);
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
    size_t size() const { return m_size; }

    /** No-op fora do Windows (o construtor já mapeou o tamanho real via `fstat`). No Windows,
     * troca a view pequena inicial (usada só pra ler o descriptor no caso de anexar) pela view
     * completa, agora que `fullSize` é conhecido. */
    void remapFull(size_t fullSize) {
        if (fullSize == m_size) return;
#if defined(_WIN32)
        if (m_view) UnmapViewOfFile(m_view);
        m_view = MapViewOfFile(m_handle, FILE_MAP_ALL_ACCESS, 0, 0, fullSize);
        if (!m_view) throw std::runtime_error("Failed to remap GHDL shared memory");
        m_size = fullSize;
#else
        (void)fullSize;
#endif
    }

private:
    void mapView(size_t size) {
        m_size = size;
#if defined(_WIN32)
        m_view = MapViewOfFile(m_handle, FILE_MAP_ALL_ACCESS, 0, 0, size);
        if (!m_view) {
            CloseHandle(m_handle);
            m_handle = nullptr;
            throw std::runtime_error("Failed to map GHDL shared memory");
        }
#else
        m_view = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, m_fd, 0);
        if (m_view == MAP_FAILED) {
            m_view = nullptr;
            ::close(m_fd);
            m_fd = -1;
            throw std::runtime_error("Failed to map GHDL shared memory");
        }
#endif
    }

    size_t m_size = 0;
    void* m_view = nullptr;
    bool m_owner = false;
#if defined(_WIN32)
    HANDLE m_handle = nullptr;
#else
    int m_fd = -1;
    std::string m_name;
#endif
};

GhdlArenaBridge::GhdlArenaBridge() = default;
GhdlArenaBridge::~GhdlArenaBridge() = default;

void GhdlArenaBridge::mapPointers() {
    uint8_t* const base = static_cast<uint8_t*>(m_sharedMemory->data());
    m_descriptor = reinterpret_cast<LsdnFpgaArenaDescriptor*>(base);
    m_transport = reinterpret_cast<LsdnFpgaArenaTransport*>(base + sizeof(LsdnFpgaArenaDescriptor));
    // Aritmética de ponteiro compartilhada com o módulo VPI (C puro) -- ver fpga_arena_abi.h.
    m_inputChanges = lsdnFpgaArenaInputChanges(m_transport);
    m_outputChanges = lsdnFpgaArenaOutputChanges(m_transport, m_inputCapacity);
}

void GhdlArenaBridge::open(const GhdlArenaOpenOptions& options) {
    close();
    if (options.name.empty()) throw std::runtime_error("GHDL shared memory name is empty");

    if (options.createIfMissing) {
        m_inputCapacity = options.inputChangeCapacity;
        m_outputCapacity = options.outputChangeCapacity;
        const size_t mappingSize = totalMappingSize(m_inputCapacity, m_outputCapacity);
        m_sharedMemory = std::make_unique<SharedMemory>(options.name, true, mappingSize);
        std::memset(m_sharedMemory->data(), 0, mappingSize);
        mapPointers();

        m_descriptor->magic = LSDN_FPGA_ARENA_ABI_MAGIC;
        m_descriptor->abiMajor = LSDN_FPGA_ARENA_ABI_MAJOR;
        m_descriptor->abiMinor = LSDN_FPGA_ARENA_ABI_MINOR;
        m_descriptor->descriptorSize = sizeof(LsdnFpgaArenaDescriptor);
        m_descriptor->transportSize = sizeof(LsdnFpgaArenaTransport);
        m_descriptor->changeEntrySize = sizeof(LsdnFpgaChangeEntry);
        m_descriptor->inputChangeCapacity = m_inputCapacity;
        m_descriptor->outputChangeCapacity = m_outputCapacity;
        m_descriptor->logQueueDepth = LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH;
        m_descriptor->coreCapabilities = LSDN_FPGA_ARENA_CAPABILITIES;
        std::atomic_ref<uint64_t>(m_descriptor->coreReady).store(1, std::memory_order_release);
        return;
    }

    m_sharedMemory = std::make_unique<SharedMemory>(options.name, false, 0);
    auto* probe = static_cast<LsdnFpgaArenaDescriptor*>(m_sharedMemory->data());
    if (probe->magic != LSDN_FPGA_ARENA_ABI_MAGIC || probe->abiMajor != LSDN_FPGA_ARENA_ABI_MAJOR ||
        probe->descriptorSize != sizeof(LsdnFpgaArenaDescriptor) ||
        probe->transportSize != sizeof(LsdnFpgaArenaTransport) ||
        probe->changeEntrySize != sizeof(LsdnFpgaChangeEntry)) {
        close();
        throw std::runtime_error("Incompatible FPGA arena ABI v1 descriptor");
    }
    m_inputCapacity = static_cast<uint32_t>(probe->inputChangeCapacity);
    m_outputCapacity = static_cast<uint32_t>(probe->outputChangeCapacity);
    m_sharedMemory->remapFull(totalMappingSize(m_inputCapacity, m_outputCapacity));
    mapPointers();
}

void GhdlArenaBridge::close() {
    m_descriptor = nullptr;
    m_transport = nullptr;
    m_inputChanges = nullptr;
    m_outputChanges = nullptr;
    m_inputCapacity = 0;
    m_outputCapacity = 0;
    m_sharedMemory.reset();
}

bool GhdlArenaBridge::isOpen() const { return m_transport != nullptr; }
LsdnFpgaArenaTransport* GhdlArenaBridge::transport() { return m_transport; }
const LsdnFpgaArenaTransport* GhdlArenaBridge::transport() const { return m_transport; }
const LsdnFpgaArenaDescriptor* GhdlArenaBridge::descriptor() const { return m_descriptor; }
uint32_t GhdlArenaBridge::inputChangeCapacity() const { return m_inputCapacity; }
uint32_t GhdlArenaBridge::outputChangeCapacity() const { return m_outputCapacity; }

bool GhdlArenaBridge::peerReady() const {
    if (!m_descriptor) return false;
    return std::atomic_ref<uint64_t>(m_descriptor->ghdlReady).load(std::memory_order_acquire) != 0;
}

uint64_t GhdlArenaBridge::negotiatedCapabilities() const {
    if (!m_descriptor || !peerReady()) return 0;
    return m_descriptor->negotiatedCapabilities;
}

LsdnFpgaState GhdlArenaBridge::state() const {
    if (!m_transport) return LSDN_FPGA_STATE_NOT_STARTED;
    return static_cast<LsdnFpgaState>(
        std::atomic_ref<uint64_t>(m_transport->state).load(std::memory_order_acquire));
}

void GhdlArenaBridge::requestAdvanceTo(uint64_t targetNs, std::span<const GhdlChangeEntry> inputs) {
    if (!m_transport) throw std::runtime_error("GHDL arena is not open");
    if (inputs.size() > m_inputCapacity) {
        throw std::runtime_error("GHDL arena: input change count exceeds negotiated capacity");
    }
    for (size_t i = 0; i < inputs.size(); ++i) {
        m_inputChanges[i].portIndex = inputs[i].portIndex;
        m_inputChanges[i].bitIndex = inputs[i].bitIndex;
        m_inputChanges[i].value = static_cast<uint8_t>(inputs[i].value);
    }
    m_transport->inputChangeCount = inputs.size();
    m_transport->requestedTimeNs = targetNs;
    m_transport->command = LSDN_FPGA_CMD_ADVANCE_TO;
    // A contagem/valores de entrada e o comando precisam estar visíveis ANTES de commandSeq
    // avançar -- é o avanço de commandSeq (release) que sinaliza "rodada nova pronta pra GHDL" pro
    // lado de lá (que faz um load de aquisição pareado, mesmo princípio de
    // QemuArenaBridge::poll()/queueWriteIndex).
    std::atomic_ref<uint64_t>(m_transport->commandSeq)
        .store(m_transport->commandSeq + 1, std::memory_order_release);
}

void GhdlArenaBridge::requestReset() {
    if (!m_transport) throw std::runtime_error("GHDL arena is not open");
    m_transport->inputChangeCount = 0;
    m_transport->command = LSDN_FPGA_CMD_RESET;
    std::atomic_ref<uint64_t>(m_transport->commandSeq)
        .store(m_transport->commandSeq + 1, std::memory_order_release);
}

void GhdlArenaBridge::requestStop() {
    if (!m_transport) throw std::runtime_error("GHDL arena is not open");
    m_transport->inputChangeCount = 0;
    m_transport->command = LSDN_FPGA_CMD_STOP;
    std::atomic_ref<uint64_t>(m_transport->commandSeq)
        .store(m_transport->commandSeq + 1, std::memory_order_release);
}

GhdlAdvanceReply GhdlArenaBridge::pollReply() const {
    GhdlAdvanceReply reply;
    if (!m_transport) return reply;
    reply.state = state();
    const uint64_t commandSeq = m_transport->commandSeq; // só o Core escreve isto
    const uint64_t replySeq =
        std::atomic_ref<uint64_t>(m_transport->replySeq).load(std::memory_order_acquire);
    if (replySeq != commandSeq) return reply; // ainda não pronto -- não bloqueia, só reporta

    reply.ready = true;
    reply.reachedTimeNs = m_transport->reachedTimeNs;
    reply.overflow = m_transport->outputOverflow != 0;
    if (!reply.overflow) {
        const uint64_t count = m_transport->outputChangeCount;
        reply.outputChanges.reserve(static_cast<size_t>(count));
        for (uint64_t i = 0; i < count && i < m_outputCapacity; ++i) {
            reply.outputChanges.push_back(GhdlChangeEntry{m_outputChanges[i].portIndex, m_outputChanges[i].bitIndex,
                                                           static_cast<LogicValue>(m_outputChanges[i].value)});
        }
    }
    return reply;
}

std::optional<GhdlLogMessage> GhdlArenaBridge::pollLog() {
    if (!m_transport) return std::nullopt;
    const uint64_t writeIndex =
        std::atomic_ref<uint64_t>(m_transport->logWriteIndex).load(std::memory_order_acquire);
    if (m_transport->logReadIndex == writeIndex) return std::nullopt;

    const uint64_t slot = m_transport->logReadIndex % LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH;
    const LsdnFpgaLogEntry& entry = m_transport->logQueue[slot];
    GhdlLogMessage message;
    message.severity = static_cast<LsdnFpgaLogSeverity>(entry.severity);
    message.timeNs = entry.timeNs;
    message.message.assign(entry.message, ::strnlen(entry.message, LSDN_FPGA_ARENA_LOG_MESSAGE_MAX));
    return message;
}

void GhdlArenaBridge::acknowledgeLog() {
    if (!m_transport) return;
    const uint64_t writeIndex =
        std::atomic_ref<uint64_t>(m_transport->logWriteIndex).load(std::memory_order_acquire);
    if (m_transport->logReadIndex != writeIndex) {
        std::atomic_ref<uint64_t>(m_transport->logReadIndex)
            .store(m_transport->logReadIndex + 1, std::memory_order_release);
    }
}

} // namespace lasecsimul::fpga
