#include "PlcRuntime.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>
#include <cstdlib>
#include <vector>

#include "lasecsimul/Sha256.hpp"
#include "lasecsimul/CausalTrace.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <aclapi.h>
#include <userenv.h>
#else
#include <csignal>
#include <fcntl.h>
#include <poll.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__linux__)
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <linux/unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#endif
#endif

namespace lasecsimul::plc {

namespace {

#if defined(_WIN32)
std::wstring widen(const std::string& text) {
    if (text.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    std::wstring result(static_cast<size_t>(size > 0 ? size : 0), L'\0');
    if (size > 0) MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, result.data(), size);
    if (!result.empty() && result.back() == L'\0') result.pop_back();
    return result;
}

std::wstring quoteWindowsArg(const std::string& argument) {
    const std::wstring input = widen(argument);
    if (!input.empty() && input.find_first_of(L" \t\"") == std::wstring::npos) return input;
    std::wstring output = L"\"";
    size_t slashes = 0;
    for (const wchar_t ch : input) {
        if (ch == L'\\') { ++slashes; }
        else if (ch == L'"') { output.append(slashes * 2 + 1, L'\\'); output.push_back(ch); slashes = 0; }
        else { output.append(slashes, L'\\'); slashes = 0; output.push_back(ch); }
    }
    output.append(slashes * 2, L'\\');
    output.push_back(L'"');
    return output;
}

std::wstring environmentValue(const wchar_t* name) {
    const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if (size == 0) return {};
    std::wstring value(size, L'\0');
    const DWORD written = GetEnvironmentVariableW(name, value.data(), size);
    if (written == 0 || written >= size) return {};
    value.resize(written);
    return value;
}

void setPrivateDirectoryAcl(const std::filesystem::path& directory, PSID appContainerSid) {
    using GetNamedSecurityInfoFn = DWORD (WINAPI*)(LPCWSTR, SE_OBJECT_TYPE, SECURITY_INFORMATION,
        PSID*, PSID*, PACL*, PACL*, PSECURITY_DESCRIPTOR*);
    using SetEntriesInAclFn = DWORD (WINAPI*)(ULONG, PEXPLICIT_ACCESSW, PACL, PACL*);
    using SetNamedSecurityInfoFn = DWORD (WINAPI*)(LPWSTR, SE_OBJECT_TYPE, SECURITY_INFORMATION,
        PSID, PSID, PACL, PACL);
    HMODULE advapi = GetModuleHandleW(L"advapi32.dll");
    auto getInfo = reinterpret_cast<GetNamedSecurityInfoFn>(GetProcAddress(advapi, "GetNamedSecurityInfoW"));
    auto setEntries = reinterpret_cast<SetEntriesInAclFn>(GetProcAddress(advapi, "SetEntriesInAclW"));
    auto setInfo = reinterpret_cast<SetNamedSecurityInfoFn>(GetProcAddress(advapi, "SetNamedSecurityInfoW"));
    if (!getInfo || !setEntries || !setInfo) throw PlcRuntimeError("APIs de ACL do AppContainer indisponiveis");
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL oldDacl = nullptr;
    const std::wstring path = directory.wstring();
    if (getInfo(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                nullptr, nullptr, &oldDacl, nullptr, &descriptor) != ERROR_SUCCESS)
        throw PlcRuntimeError("nao foi possivel ler a ACL do diretorio privado do worker PLC");
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = GENERIC_ALL;
    access.grfAccessMode = GRANT_ACCESS;
    access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    access.Trustee.ptstrName = static_cast<LPWSTR>(appContainerSid);
    PACL newDacl = nullptr;
    const DWORD aclResult = setEntries(1, &access, oldDacl, &newDacl);
    const DWORD setResult = aclResult == ERROR_SUCCESS
        ? setInfo(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                  nullptr, nullptr, newDacl, nullptr)
        : aclResult;
    if (newDacl) LocalFree(newDacl);
    if (descriptor) LocalFree(descriptor);
    if (setResult != ERROR_SUCCESS) throw PlcRuntimeError("nao foi possivel limitar ACL do worker PLC ao AppContainer");
}

PSID createPlcAppContainerSid() {
    using CreateProfileFn = HRESULT (WINAPI*)(PCWSTR, PCWSTR, PCWSTR, PSID_AND_ATTRIBUTES, DWORD, PSID*);
    using DeriveSidFn = HRESULT (WINAPI*)(PCWSTR, PSID*);
    HMODULE userenv = LoadLibraryW(L"userenv.dll");
    if (!userenv) throw PlcRuntimeError("AppContainer indisponivel: userenv.dll nao carregou");
    auto createProfile = reinterpret_cast<CreateProfileFn>(GetProcAddress(userenv, "CreateAppContainerProfile"));
    auto deriveSid = reinterpret_cast<DeriveSidFn>(GetProcAddress(userenv, "DeriveAppContainerSidFromAppContainerName"));
    if (!createProfile || !deriveSid) throw PlcRuntimeError("AppContainer indisponivel nesta versao do Windows");
    constexpr wchar_t kProfileName[] = L"LasecSimul.PLC.SharedHost.Worker";
    PSID sid = nullptr;
    HRESULT result = createProfile(kProfileName, L"LasecSimul PLC Worker", L"Isolated PLC scan worker",
                                   nullptr, 0, &sid);
    if (result == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) result = deriveSid(kProfileName, &sid);
    if (FAILED(result) || !sid) throw PlcRuntimeError("nao foi possivel criar a identidade AppContainer do worker PLC");
    return sid;
}
#endif

std::string trim(const std::string& text) {
    const size_t start = text.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return {};
    const size_t end = text.find_last_not_of(" \t\r\n");
    return text.substr(start, end - start + 1);
}

void recordPlcTrace(trace::EventType type, RuntimeLaunchIdentity identity,
                    uint64_t sequence, uint64_t dependency, uint64_t virtualNs) noexcept {
    trace::Recorder& recorder = trace::Recorder::instance();
    if (recorder.mode() != trace::Mode::Detailed) return;
    recorder.setRuntimeIdentity(identity);
    recorder.record(type, sequence, dependency, virtualNs);
    recorder.setRuntimeIdentity({});
}

std::filesystem::path plcWorkerSandboxRoot() {
    const char* configured = std::getenv("LASECSIMUL_PLC_SHAREDHOST_WORK_ROOT");
    const std::filesystem::path root = configured && *configured
        ? std::filesystem::u8path(configured)
        : std::filesystem::temp_directory_path() / "lasecsimul-plc-workers";
    if (!root.is_absolute()) throw PlcRuntimeError("LASECSIMUL_PLC_SHAREDHOST_WORK_ROOT deve ser caminho absoluto");
    std::filesystem::create_directories(root);
    return root;
}

#if defined(__linux__)
bool prepareLinuxWorkerSandbox(const std::string& executable, const std::filesystem::path& workDir,
                               int& ruleset, std::vector<sock_filter>& filter) {
    constexpr uint64_t fsRights = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
    const int abi = static_cast<int>(syscall(SYS_landlock_create_ruleset, nullptr, 0,
                                              LANDLOCK_CREATE_RULESET_VERSION));
    if (abi < 1) return false;
    landlock_ruleset_attr rulesetAttr{};
    rulesetAttr.handled_access_fs = fsRights;
    ruleset = static_cast<int>(syscall(SYS_landlock_create_ruleset, &rulesetAttr,
                                       sizeof(rulesetAttr), 0));
    if (ruleset < 0) return false;
    auto addPath = [ruleset](const std::filesystem::path& path, uint64_t access) {
        const int fd = open(path.c_str(), O_PATH | O_CLOEXEC);
        if (fd < 0) return errno == ENOENT;
        landlock_path_beneath_attr rule{};
        rule.allowed_access = access;
        rule.parent_fd = fd;
        const bool ok = syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH,
                                &rule, 0) == 0;
        close(fd);
        return ok;
    };
    const uint64_t readOnly = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
                              LANDLOCK_ACCESS_FS_READ_DIR;
    bool ok = addPath(workDir, fsRights) && addPath(std::filesystem::u8path(executable), readOnly);
    // The native module is linked statically on Windows and dynamically on Linux. Permit only the
    // system library trees needed by the ELF loader; user/project trees stay denied by default.
    for (const char* libraryDir : {"/lib", "/lib64", "/usr/lib", "/usr/lib64", "/usr/local/lib"})
        ok = addPath(libraryDir, readOnly) && ok;
    ok = addPath("/etc/ld.so.cache", LANDLOCK_ACCESS_FS_READ_FILE) && ok;
    if (!ok) {
        close(ruleset);
        ruleset = -1;
        return false;
    }
    filter.push_back(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));
    auto denySyscall = [&filter](int number) {
        filter.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, static_cast<uint32_t>(number), 0, 1));
        filter.push_back(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)));
    };
#ifdef __NR_socket
    denySyscall(__NR_socket);
#endif
#ifdef __NR_socketpair
    denySyscall(__NR_socketpair);
#endif
#ifdef __NR_connect
    denySyscall(__NR_connect);
#endif
#ifdef __NR_bind
    denySyscall(__NR_bind);
#endif
#ifdef __NR_listen
    denySyscall(__NR_listen);
#endif
#ifdef __NR_accept
    denySyscall(__NR_accept);
#endif
#ifdef __NR_accept4
    denySyscall(__NR_accept4);
#endif
#ifdef __NR_sendto
    denySyscall(__NR_sendto);
#endif
#ifdef __NR_recvfrom
    denySyscall(__NR_recvfrom);
#endif
#ifdef __NR_sendmsg
    denySyscall(__NR_sendmsg);
#endif
#ifdef __NR_recvmsg
    denySyscall(__NR_recvmsg);
#endif
#ifdef __NR_sendmmsg
    denySyscall(__NR_sendmmsg);
#endif
#ifdef __NR_recvmmsg
    denySyscall(__NR_recvmmsg);
#endif
#ifdef __NR_io_uring_setup
    denySyscall(__NR_io_uring_setup);
#endif
#ifdef __NR_clone
    denySyscall(__NR_clone);
#endif
#ifdef __NR_clone3
    denySyscall(__NR_clone3);
#endif
#ifdef __NR_fork
    denySyscall(__NR_fork);
#endif
#ifdef __NR_vfork
    denySyscall(__NR_vfork);
#endif
#ifdef __NR_kill
    denySyscall(__NR_kill);
#endif
#ifdef __NR_tkill
    denySyscall(__NR_tkill);
#endif
#ifdef __NR_tgkill
    denySyscall(__NR_tgkill);
#endif
#ifdef __NR_pidfd_send_signal
    denySyscall(__NR_pidfd_send_signal);
#endif
#ifdef __NR_ptrace
    denySyscall(__NR_ptrace);
#endif
#ifdef __NR_process_vm_readv
    denySyscall(__NR_process_vm_readv);
#endif
#ifdef __NR_process_vm_writev
    denySyscall(__NR_process_vm_writev);
#endif
#ifdef __NR_pidfd_getfd
    denySyscall(__NR_pidfd_getfd);
#endif
#ifdef __NR_bpf
    denySyscall(__NR_bpf);
#endif
#ifdef __NR_perf_event_open
    denySyscall(__NR_perf_event_open);
#endif
#ifdef __NR_userfaultfd
    denySyscall(__NR_userfaultfd);
#endif
#ifdef __NR_unshare
    denySyscall(__NR_unshare);
#endif
#ifdef __NR_setns
    denySyscall(__NR_setns);
#endif
#ifdef __NR_mount
    denySyscall(__NR_mount);
#endif
#ifdef __NR_umount2
    denySyscall(__NR_umount2);
#endif
#ifdef __NR_reboot
    denySyscall(__NR_reboot);
#endif
    filter.push_back(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    return !filter.empty() && filter.size() <= USHRT_MAX;
}
#endif

} // namespace

// =============================================================================
// Process -- um worker por instância, pipes stdin/stdout reais. Mesma técnica já validada em
// `PlcCompiler::validateArtifact()` (F9.3), agora como classe reaproveitável dentro de um único
// `PlcRuntime` (nunca compartilhada entre instâncias -- isolamento total é o requisito). stderr do
// worker é descartado (redirecionado pra NUL/dev-null): o protocolo `PlcScanSession` nunca escreve
// diagnóstico lá em operação normal, e crash/EOF já são detectados via saída do processo, não via
// conteúdo de stderr -- evita a complexidade de thread leitora de stderr que F8 teve.
// =============================================================================

class PlcRuntime::Process {
public:
    explicit Process(std::string executablePath, uint64_t memoryLimitBytes, bool isolate)
        : m_executablePath(isolate ? std::filesystem::absolute(std::filesystem::u8path(executablePath)).string()
                                   : std::move(executablePath)),
          m_memoryLimitBytes(memoryLimitBytes), m_isolate(isolate) {}
    ~Process() { terminate(); }

    void start() {
#if defined(_WIN32)
        std::wstring executable = widen(m_executablePath);
        if (m_isolate) {
            static std::atomic<uint64_t> nextSandboxId{1};
            const uint64_t sandboxId = nextSandboxId.fetch_add(1, std::memory_order_relaxed);
            m_workingDirectory = plcWorkerSandboxRoot() /
                ("worker-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(sandboxId));
            std::filesystem::create_directories(m_workingDirectory);
            m_appContainerSid = createPlcAppContainerSid();
            setPrivateDirectoryAcl(m_workingDirectory, m_appContainerSid);
            const std::filesystem::path workerCopy = m_workingDirectory / "worker.exe";
            std::filesystem::copy_file(std::filesystem::u8path(m_executablePath), workerCopy,
                                       std::filesystem::copy_options::overwrite_existing);
            executable = workerCopy.wstring();
        }
        SECURITY_ATTRIBUTES attributes{};
        attributes.nLength = sizeof(attributes);
        attributes.bInheritHandle = TRUE;

        HANDLE childStdinRead = nullptr;
        HANDLE childStdoutWrite = nullptr;
        if (!CreatePipe(&childStdinRead, &m_stdinWrite, &attributes, 0) ||
            !CreatePipe(&m_stdoutRead, &childStdoutWrite, &attributes, 0)) {
            throw PlcRuntimeError("falha ao criar pipes do worker PLC");
        }
        SetHandleInformation(m_stdinWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(m_stdoutRead, HANDLE_FLAG_INHERIT, 0);

        HANDLE nulHandle = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE | FILE_SHARE_READ,
                                       &attributes, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);

        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = m_isolate ? sizeof(startup) : sizeof(STARTUPINFOW);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = childStdinRead;
        startup.StartupInfo.hStdOutput = childStdoutWrite;
        startup.StartupInfo.hStdError = (nulHandle != INVALID_HANDLE_VALUE) ? nulHandle : childStdoutWrite;

        std::wstring command = quoteWindowsArg(std::string(m_isolate ? "worker.exe" : m_executablePath));
        std::wstring environment;
        std::vector<uint8_t> attributeStorage;
        LPPROC_THREAD_ATTRIBUTE_LIST attributeList = nullptr;
        SECURITY_CAPABILITIES securityCapabilities{};
        DWORD creationFlags = CREATE_NO_WINDOW | CREATE_SUSPENDED;
        if (m_isolate) {
            HANDLE inheritedHandles[] = {childStdinRead, childStdoutWrite,
                (nulHandle != INVALID_HANDLE_VALUE) ? nulHandle : childStdoutWrite};
            SIZE_T attributeBytes = 0;
            InitializeProcThreadAttributeList(nullptr, 3, 0, &attributeBytes);
            attributeStorage.resize(attributeBytes);
            attributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
            if (!InitializeProcThreadAttributeList(attributeList, 3, 0, &attributeBytes) ||
                !UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                           inheritedHandles, sizeof(inheritedHandles), nullptr, nullptr)) {
                if (attributeList) DeleteProcThreadAttributeList(attributeList);
                CloseHandle(childStdinRead); CloseHandle(childStdoutWrite);
                if (nulHandle != INVALID_HANDLE_VALUE) CloseHandle(nulHandle);
                closeHandles();
                throw PlcRuntimeError("falha ao preparar handles isolados do worker PLC");
            }
            securityCapabilities.AppContainerSid = m_appContainerSid;
            securityCapabilities.Capabilities = nullptr;
            securityCapabilities.CapabilityCount = 0;
            securityCapabilities.Reserved = 0;
            DWORD allApplicationPackagesPolicy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                           &securityCapabilities, sizeof(securityCapabilities), nullptr, nullptr)) {
                DeleteProcThreadAttributeList(attributeList);
                CloseHandle(childStdinRead); CloseHandle(childStdoutWrite);
                if (nulHandle != INVALID_HANDLE_VALUE) CloseHandle(nulHandle);
                closeHandles();
                throw PlcRuntimeError("falha ao configurar AppContainer sem capabilities de rede");
            }
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
                                           &allApplicationPackagesPolicy, sizeof(allApplicationPackagesPolicy), nullptr, nullptr)) {
                DeleteProcThreadAttributeList(attributeList);
                CloseHandle(childStdinRead); CloseHandle(childStdoutWrite);
                if (nulHandle != INVALID_HANDLE_VALUE) CloseHandle(nulHandle);
                closeHandles();
                throw PlcRuntimeError("falha ao configurar LPAC sem acesso implicito a Application Packages");
            }
            startup.lpAttributeList = attributeList;
            creationFlags |= EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
            const std::wstring systemRoot = environmentValue(L"SystemRoot");
            if (systemRoot.empty()) {
                DeleteProcThreadAttributeList(attributeList);
                CloseHandle(childStdinRead); CloseHandle(childStdoutWrite);
                if (nulHandle != INVALID_HANDLE_VALUE) CloseHandle(nulHandle);
                closeHandles();
                throw PlcRuntimeError("SystemRoot ausente; nao e seguro iniciar worker SharedHost");
            }
            const std::wstring work = m_workingDirectory.wstring();
            const std::wstring path = systemRoot + L"\\System32";
            const std::wstring driveRoot = m_workingDirectory.root_path().wstring();
            if (driveRoot.size() >= 2 && driveRoot[1] == L':') {
                environment.push_back(L'=');
                environment.push_back(driveRoot[0]);
                environment.append(L":=");
                environment.append(driveRoot).push_back(L'\0');
            }
            for (const auto& entry : {std::pair{L"APPDATA", work}, std::pair{L"HOME", work},
                                      std::pair{L"LOCALAPPDATA", work}, std::pair{L"PATH", path},
                                      std::pair{L"SYSTEMROOT", systemRoot}, std::pair{L"TEMP", work},
                                      std::pair{L"TMP", work}, std::pair{L"USERPROFILE", work},
                                      std::pair{L"WINDIR", systemRoot}}) {
                environment.append(entry.first).push_back(L'=');
                environment.append(entry.second).push_back(L'\0');
            }
            environment.push_back(L'\0');
        }
        const BOOL created = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                                            creationFlags, m_isolate ? environment.data() : nullptr,
                                            m_isolate ? m_workingDirectory.c_str() : nullptr,
                                            &startup.StartupInfo, &m_processInfo);
        if (attributeList) DeleteProcThreadAttributeList(attributeList);
        const DWORD createError = created ? ERROR_SUCCESS : GetLastError();
        CloseHandle(childStdinRead);
        CloseHandle(childStdoutWrite);
        if (nulHandle != INVALID_HANDLE_VALUE) CloseHandle(nulHandle);
        if (!created) {
            closeHandles();
            throw PlcRuntimeError("falha ao iniciar o worker PLC (Win32 " + std::to_string(createError) + "): " + m_executablePath);
        }
        m_job = CreateJobObjectW(nullptr, nullptr);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (m_isolate) {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
        }
        if (m_memoryLimitBytes > 0) {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            limits.ProcessMemoryLimit = static_cast<SIZE_T>(m_memoryLimitBytes);
        }
        if (!m_job || !SetInformationJobObject(m_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
            !AssignProcessToJobObject(m_job, m_processInfo.hProcess) ||
            ResumeThread(m_processInfo.hThread) == static_cast<DWORD>(-1)) {
            if (m_processInfo.hProcess) TerminateProcess(m_processInfo.hProcess, 1);
            closeHandles();
            throw PlcRuntimeError("falha ao aplicar Job Object e limite de memoria ao worker PLC");
        }
#else
        // Sem isso, escrever no stdin de um worker que ja morreu (pipe sem leitor) manda SIGPIPE
        // pro PROPRIO Core e mata o processo inteiro por padrao -- exatamente o que "crash do
        // worker nao pode derrubar o Core" proibe. write() simplesmente devolve EPIPE/-1 em vez
        // disso, que writeLine() ja trata como falha normal.
        std::signal(SIGPIPE, SIG_IGN);

        int inputPipe[2] = {-1, -1};
        int outputPipe[2] = {-1, -1};
        if (pipe(inputPipe) != 0 || pipe(outputPipe) != 0) {
            throw PlcRuntimeError("falha ao criar pipes do worker PLC");
        }
        if (m_isolate) {
            static std::atomic<uint64_t> nextSandboxId{1};
            m_workingDirectory = plcWorkerSandboxRoot() /
                ("worker-" + std::to_string(static_cast<uint64_t>(getpid())) + "-" +
                 std::to_string(nextSandboxId.fetch_add(1, std::memory_order_relaxed)));
            std::filesystem::create_directories(m_workingDirectory);
            chmod(m_workingDirectory.c_str(), 0700);
        }
        if (m_isolate) {
#if defined(__linux__)
            int rulesetFd = -1;
            std::vector<sock_filter> filter;
            if (!prepareLinuxWorkerSandbox(m_executablePath, m_workingDirectory, rulesetFd, filter))
                throw PlcRuntimeError("nao foi possivel preparar sandbox Landlock/seccomp do worker PLC");
            const int devNull = open("/dev/null", O_WRONLY | O_CLOEXEC);
            if (devNull < 0) { close(rulesetFd); throw PlcRuntimeError("nao foi possivel abrir /dev/null"); }
            char* const argv[] = {const_cast<char*>(m_executablePath.c_str()), nullptr};
            char home[] = "HOME=."; char lang[] = "LANG=C"; char path[] = "PATH=";
            char tmpdir[] = "TMPDIR=."; char tz[] = "TZ=UTC";
            char* const envp[] = {home, lang, path, tmpdir, tz, nullptr};
            sock_fprog program{static_cast<unsigned short>(filter.size()), filter.data()};
            const char* const executablePath = m_executablePath.c_str();
            const char* const workingDirectory = m_workingDirectory.c_str();
            const uint64_t memoryLimit = m_memoryLimitBytes;
            m_pid = vfork();
            if (m_pid == 0) {
                if (setpgid(0, 0) != 0 || chdir(workingDirectory) != 0) _exit(126);
                if (memoryLimit > 0) {
                    const struct rlimit limit{static_cast<rlim_t>(memoryLimit), static_cast<rlim_t>(memoryLimit)};
                    if (setrlimit(RLIMIT_AS, &limit) != 0) _exit(126);
                }
                if (dup2(inputPipe[0], STDIN_FILENO) < 0 || dup2(outputPipe[1], STDOUT_FILENO) < 0 ||
                    dup2(devNull, STDERR_FILENO) < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
                    syscall(SYS_landlock_restrict_self, rulesetFd, 0) != 0) _exit(126);
                close(rulesetFd);
                close(devNull);
                close(inputPipe[0]); close(inputPipe[1]); close(outputPipe[0]); close(outputPipe[1]);
#if defined(SYS_close_range)
                if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0) _exit(126);
#else
                _exit(126);
#endif
                if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) _exit(126);
                execve(executablePath, argv, envp);
                _exit(127);
            }
            close(rulesetFd);
            close(devNull);
            if (m_pid < 0) throw PlcRuntimeError("vfork() falhou pro worker PLC");
#else
            throw PlcRuntimeError("SharedHost PLC sem sandbox suportado nesta plataforma POSIX");
#endif
        } else {
        m_pid = fork();
        if (m_pid < 0) throw PlcRuntimeError("fork() falhou pro worker PLC");
        if (m_pid == 0) {
            setpgid(0, 0);
            if (m_memoryLimitBytes > 0) {
                const struct rlimit limit{static_cast<rlim_t>(m_memoryLimitBytes), static_cast<rlim_t>(m_memoryLimitBytes)};
                if (setrlimit(RLIMIT_AS, &limit) != 0) _exit(126);
            }
            const int devNull = open("/dev/null", O_WRONLY);
            dup2(inputPipe[0], STDIN_FILENO);
            dup2(outputPipe[1], STDOUT_FILENO);
            if (devNull >= 0) dup2(devNull, STDERR_FILENO);
            if (m_isolate) {
                if (chdir(m_workingDirectory.c_str()) != 0) _exit(126);
                if (clearenv() != 0 || setenv("HOME", ".", 1) != 0 || setenv("TMPDIR", ".", 1) != 0 ||
                    setenv("PATH", "", 1) != 0 || setenv("LANG", "C", 1) != 0 || setenv("TZ", "UTC", 1) != 0)
                    _exit(126);
                if (devNull >= 0 && devNull > STDERR_FILENO) close(devNull);
                closeInheritedDescriptors();
#if defined(__linux__)
                if (!installLinuxWorkerSandbox(m_executablePath, m_workingDirectory)) _exit(126);
#else
                _exit(126); // fail-closed: SharedHost worker isolation has no sandbox on this platform.
#endif
            }
            close(inputPipe[0]); close(inputPipe[1]);
            close(outputPipe[0]); close(outputPipe[1]);
            execl(m_executablePath.c_str(), m_executablePath.c_str(), nullptr);
            _exit(127);
        }
        }
        setpgid(m_pid, m_pid);
        close(inputPipe[0]);
        close(outputPipe[1]);
        m_stdinFd = inputPipe[1];
        m_stdoutFd = outputPipe[0];
        fcntl(m_stdoutFd, F_SETFL, fcntl(m_stdoutFd, F_GETFL, 0) | O_NONBLOCK);
#endif
    }

    bool running() const {
#if defined(_WIN32)
        return m_processInfo.hProcess && WaitForSingleObject(m_processInfo.hProcess, 0) == WAIT_TIMEOUT;
#else
        if (m_pid <= 0) return false;
        int status = 0;
        const pid_t result = waitpid(m_pid, &status, WNOHANG);
        if (result == 0) return true;
        if (result == m_pid) const_cast<Process*>(this)->m_pid = -1;
        return false;
#endif
    }

    uint64_t processId() const {
#if defined(_WIN32)
        return static_cast<uint64_t>(m_processInfo.dwProcessId);
#else
        return m_pid > 0 ? static_cast<uint64_t>(m_pid) : 0;
#endif
    }

    /** `false` = EOF/pipe quebrado ao escrever (worker morreu) -- nunca lança, quem chama decide o
     * que fazer (marcar Faulted). */
    bool writeLine(const std::string& line) {
        const std::string wire = line + "\n";
#if defined(_WIN32)
        size_t offset = 0;
        while (offset < wire.size()) {
            DWORD written = 0;
            if (!WriteFile(m_stdinWrite, wire.data() + offset, static_cast<DWORD>(wire.size() - offset), &written, nullptr) ||
                written == 0) {
                return false;
            }
            offset += written;
        }
        return true;
#else
        size_t offset = 0;
        while (offset < wire.size()) {
            const ssize_t written = write(m_stdinFd, wire.data() + offset, wire.size() - offset);
            if (written <= 0) return false;
            offset += static_cast<size_t>(written);
        }
        return true;
#endif
    }

    /** `std::nullopt` = timeout OU EOF (worker morreu/fechou stdout) -- quem chama distingue os
     * dois checando `running()` depois, se precisar; pro propósito de "nunca publicar resultado
     * parcial", os dois casos são tratados igual (Faulted, sem resultado). */
    std::optional<std::string> readLine(std::chrono::milliseconds timeout) {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        for (;;) {
            const size_t newline = m_buffer.find('\n');
            if (newline != std::string::npos) {
                std::string line = m_buffer.substr(0, newline);
                m_buffer.erase(0, newline + 1);
                return line;
            }
            // IMPORTANTE: sempre tenta drenar o pipe ANTES de checar `running()`. Um worker que
            // escreve a resposta e sai imediatamente em seguida (varios modos do
            // `misbehaving_worker` de teste, e cenarios reais de crash logo apos responder) pode
            // ja ter saido no momento em que checamos -- os bytes continuam disponiveis no buffer
            // do pipe do kernel independente do processo ainda existir, entao checar `running()`
            // primeiro e descartar sem tentar ler perde essa resposta por uma corrida de tempo.
            // So trata como EOF quando o pipe realmente nao tem mais nada E (peek falhou/pipe
            // quebrado OU o processo ja nao esta rodando).
#if defined(_WIN32)
            DWORD available = 0;
            const BOOL peeked = PeekNamedPipe(m_stdoutRead, nullptr, 0, nullptr, &available, nullptr);
            if (peeked && available > 0) {
                char chunk[4096];
                DWORD count = 0;
                if (!ReadFile(m_stdoutRead, chunk, sizeof(chunk), &count, nullptr)) return std::nullopt;
                m_buffer.append(chunk, count);
                continue;
            }
            if (!peeked || !running()) return std::nullopt;
#else
            struct pollfd descriptor { m_stdoutFd, POLLIN, 0 };
            const int ready = poll(&descriptor, 1, 20);
            if (ready > 0 && (descriptor.revents & POLLIN)) {
                char chunk[4096];
                const ssize_t count = read(m_stdoutFd, chunk, sizeof(chunk));
                if (count > 0) { m_buffer.append(chunk, static_cast<size_t>(count)); continue; }
                if (count == 0) return std::nullopt; // EOF de verdade -- writer fechou o lado dele.
            }
            if (ready < 0 || !running()) return std::nullopt;
#endif
            if (std::chrono::steady_clock::now() >= deadline) return std::nullopt;
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }

    /** Idempotente -- termina o processo se ainda estiver rodando, fecha handles. Nunca lança. */
    void terminate() {
#if defined(_WIN32)
        if (m_processInfo.hProcess && WaitForSingleObject(m_processInfo.hProcess, 0) == WAIT_TIMEOUT) {
            TerminateProcess(m_processInfo.hProcess, 1);
            WaitForSingleObject(m_processInfo.hProcess, 2000);
        }
        closeHandles();
#else
        if (m_pid > 0) {
            ::kill(-m_pid, SIGKILL);
            int status = 0;
            waitpid(m_pid, &status, 0);
            m_pid = -1;
        }
        if (m_stdinFd >= 0) { close(m_stdinFd); m_stdinFd = -1; }
        if (m_stdoutFd >= 0) { close(m_stdoutFd); m_stdoutFd = -1; }
        cleanupSandboxDirectory();
#endif
    }

    /** Espera o processo sair SOZINHO (depois de SHUTDOWN já ter sido mandado) -- não força nada.
     * `true` = saiu dentro do prazo. */
    bool waitForExit(std::chrono::milliseconds timeout) {
#if defined(_WIN32)
        if (!m_processInfo.hProcess) return true;
        return WaitForSingleObject(m_processInfo.hProcess, static_cast<DWORD>(timeout.count())) == WAIT_OBJECT_0;
#else
        if (m_pid <= 0) return true;
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline) {
            if (!running()) return true;
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        return !running();
#endif
    }

private:
#if defined(_WIN32)
    void closeHandles() {
        if (m_processInfo.hThread) { CloseHandle(m_processInfo.hThread); m_processInfo.hThread = nullptr; }
        if (m_processInfo.hProcess) { CloseHandle(m_processInfo.hProcess); m_processInfo.hProcess = nullptr; }
        if (m_job) { CloseHandle(m_job); m_job = nullptr; }
        if (m_stdinWrite) { CloseHandle(m_stdinWrite); m_stdinWrite = nullptr; }
        if (m_stdoutRead) { CloseHandle(m_stdoutRead); m_stdoutRead = nullptr; }
        m_processInfo = {};
        if (m_appContainerSid) { FreeSid(m_appContainerSid); m_appContainerSid = nullptr; }
        cleanupSandboxDirectory();
    }
    HANDLE m_stdinWrite = nullptr;
    HANDLE m_stdoutRead = nullptr;
    HANDLE m_job = nullptr;
    PROCESS_INFORMATION m_processInfo{};
    PSID m_appContainerSid = nullptr;
#else
    mutable pid_t m_pid = -1;
    int m_stdinFd = -1;
    int m_stdoutFd = -1;
#endif
    void cleanupSandboxDirectory() noexcept {
        if (!m_workingDirectory.empty()) {
            std::error_code ignored;
            std::filesystem::remove_all(m_workingDirectory, ignored);
            m_workingDirectory.clear();
        }
    }
#if !defined(_WIN32)
    static void closeInheritedDescriptors() {
#if defined(__linux__) && defined(SYS_close_range)
        if (syscall(SYS_close_range, 3u, ~0u, 0u) == 0) return;
#endif
        struct rlimit limit{};
        const rlim_t maxFd = getrlimit(RLIMIT_NOFILE, &limit) == 0 ? limit.rlim_cur : 1024;
        for (int fd = 3; static_cast<rlim_t>(fd) < maxFd && fd < 65536; ++fd) close(fd);
    }
#endif
    std::string m_executablePath;
    uint64_t m_memoryLimitBytes = 0;
    bool m_isolate = false;
    std::filesystem::path m_workingDirectory;
    std::string m_buffer;
};

// =============================================================================
// PlcRuntime
// =============================================================================

PlcRuntime::PlcRuntime(PlcNativeModule module, PlcRuntimeOptions options)
    : m_module(std::move(module)), m_options(std::move(options)) {
    if (m_options.retainStoragePath.empty()) return;
    std::ifstream input(m_options.retainStoragePath, std::ios::binary);
    if (!input) return;
    input.seekg(0, std::ios::end);
    const std::streamoff size = input.tellg();
    if (size < 0 || size > 1024 * 1024) throw PlcRuntimeError("snapshot RETAIN persistido excede 1 MiB ou e ilegivel");
    input.seekg(0, std::ios::beg);
    m_retainSnapshot.assign(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
    if (!input.eof() && input.fail()) throw PlcRuntimeError("falha ao ler snapshot RETAIN persistido");
    m_hasRetainSnapshot = true;
}

PlcRuntime::~PlcRuntime() { shutdown(); }

void PlcRuntime::markFaulted(const std::string& message) {
    recordPlcTrace(trace::EventType::PlcWorkerFault, m_runtimeIdentity, m_requestSequence,
                   m_requestSequence, m_lastAcceptedTimeNs < 0 ? 0 : static_cast<uint64_t>(m_lastAcceptedTimeNs));
    m_faultMessage = message;
    m_state = PlcRuntimeState::Faulted;
    if (m_process) m_process->terminate();
    m_process.reset();
}

void PlcRuntime::setSessionExecutionId(uint64_t sessionExecutionId) {
    if (m_options.sessionExecutionId == sessionExecutionId) return;
    if (m_state != PlcRuntimeState::Stopped) shutdown();
    m_options.sessionExecutionId = sessionExecutionId;
    m_runtimeIdentity.sessionExecutionId = sessionExecutionId;
}

std::string PlcRuntime::nextRequestId() {
    return "r" + std::to_string(++m_requestSequence);
}

std::string PlcRuntime::sendRequestExpectingOk(const std::string& commandName, const std::string& args) {
    if (m_state != PlcRuntimeState::Ready && m_state != PlcRuntimeState::Starting) {
        throw PlcRuntimeError("PlcRuntime nao esta pronto (estado atual != Ready/Starting)");
    }
    const std::string requestId = nextRequestId();
    const std::string line = args.empty() ? (commandName + " " + requestId) : (commandName + " " + requestId + " " + args);
    if (!m_process->writeLine(line)) {
        markFaulted("falha ao escrever no worker PLC (pipe fechado -- processo provavelmente morreu)");
        throw PlcRuntimeError(m_faultMessage);
    }
    const auto response = m_process->readLine(std::chrono::milliseconds(m_options.stepTimeoutMs));
    if (!response) {
        const bool stillRunning = m_process && m_process->running();
        markFaulted(stillRunning ? "timeout esperando resposta do worker PLC para " + commandName
                                 : "worker PLC encerrou inesperadamente (EOF) durante " + commandName);
        throw PlcRuntimeError(m_faultMessage);
    }

    std::istringstream stream(*response);
    std::string status;
    std::string responseRequestId;
    if (!(stream >> status) || !(stream >> responseRequestId)) {
        markFaulted("resposta malformada do worker PLC: " + *response);
        throw PlcRuntimeError(m_faultMessage);
    }
    if (responseRequestId != requestId) {
        markFaulted("requestId incorreto na resposta do worker PLC: esperado " + requestId + ", recebido " + responseRequestId);
        throw PlcRuntimeError(m_faultMessage);
    }
    std::string rest;
    std::getline(stream, rest);
    rest = trim(rest);

    if (status == "OK") return rest;
    if (status == "ERR") {
        markFaulted("worker PLC recusou " + commandName + ": " + rest);
        throw PlcRuntimeError(m_faultMessage);
    }
    markFaulted("resposta com status desconhecido do worker PLC: " + *response);
    throw PlcRuntimeError(m_faultMessage);
}

void PlcRuntime::ensureStarted() {
    if (m_state == PlcRuntimeState::Ready) return;
    if (m_state == PlcRuntimeState::Faulted) {
        throw PlcRuntimeError("PlcRuntime esta Faulted; chame restart()/reset() antes de continuar");
    }

    const std::string actualHash = Sha256::hashFile(m_module.nativeBinaryRef);
    if (actualHash.empty() || actualHash != m_module.artifactHash) {
        markFaulted("artifactHash nao bate com o binario em " + m_module.nativeBinaryRef +
                    " (esperado " + m_module.artifactHash + ", obtido " + (actualHash.empty() ? "<arquivo ilegivel>" : actualHash) + ")");
        throw PlcRuntimeError(m_faultMessage);
    }

    try {
        if (m_options.launchIdentityProvider) m_runtimeIdentity = m_options.launchIdentityProvider();
        else {
            if (m_localLaunchGeneration == UINT64_MAX) throw std::overflow_error("PLC launch generation exhausted");
            ++m_localLaunchGeneration;
            m_runtimeIdentity = {m_options.sessionExecutionId, m_options.runtimeInstanceId, m_localLaunchGeneration};
        }
    } catch (const std::exception& error) {
        markFaulted(std::string("falha ao reservar identidade do worker PLC: ") + error.what());
        throw PlcRuntimeError(m_faultMessage);
    }
    recordPlcTrace(trace::EventType::PlcWorkerLaunchAttempt, m_runtimeIdentity, 0, 0, 0);

    m_state = PlcRuntimeState::Starting;
    m_process = std::make_unique<Process>(m_module.nativeBinaryRef, m_options.workerMemoryLimitBytes,
                                          m_options.sharedHostIsolationRequired);
    try {
        m_process->start();
    } catch (const PlcRuntimeError& error) {
        markFaulted(error.what());
        throw;
    }

    const std::string helloArgs = m_options.launchIdentityProvider
        ? "session=" + std::to_string(m_runtimeIdentity.sessionExecutionId) +
          " runtime=" + std::to_string(m_runtimeIdentity.runtimeInstanceId) +
          " generation=" + std::to_string(m_runtimeIdentity.launchGeneration)
        : std::string{};
    const std::string helloResponse = sendRequestExpectingOk("HELLO", helloArgs);
    // Formato: "protocol=<N> program=<NOME>" -- mesmo que PlcScanSession::handleHello (F9.2) gera.
    uint32_t protocolVersion = 0;
    std::string programField;
    bool identityReceived = false;
    RuntimeLaunchIdentity workerIdentity{};
    {
        std::istringstream stream(helloResponse);
        std::string protocolField, field;
        stream >> protocolField >> programField;
        const size_t eq = protocolField.find('=');
        if (eq != std::string::npos) {
            try { protocolVersion = static_cast<uint32_t>(std::stoul(protocolField.substr(eq + 1))); }
            catch (...) { protocolVersion = 0; }
        }
        const size_t programEq = programField.find('=');
        if (programEq != std::string::npos) programField = programField.substr(programEq + 1);
        while (stream >> field) {
            const size_t eq = field.find('=');
            if (eq == std::string::npos) continue;
            try {
                const uint64_t value = std::stoull(field.substr(eq + 1));
                if (field.substr(0, eq) == "session") { workerIdentity.sessionExecutionId = value; identityReceived = true; }
                else if (field.substr(0, eq) == "runtime") { workerIdentity.runtimeInstanceId = value; identityReceived = true; }
                else if (field.substr(0, eq) == "generation") { workerIdentity.launchGeneration = value; identityReceived = true; }
            } catch (...) { /* validated as incomplete/mismatched below */ }
        }
    }
    if (protocolVersion != m_module.workerProtocolVersion) {
        markFaulted("workerProtocolVersion incompativel: PlcNativeModule diz " +
                    std::to_string(m_module.workerProtocolVersion) + ", worker respondeu " + std::to_string(protocolVersion));
        throw PlcRuntimeError(m_faultMessage);
    }
    std::string expectedProgramUpper = m_module.programName;
    std::transform(expectedProgramUpper.begin(), expectedProgramUpper.end(), expectedProgramUpper.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    if (programField != expectedProgramUpper) {
        markFaulted("identidade do worker PLC inesperada: PlcNativeModule diz " + expectedProgramUpper +
                    ", worker respondeu " + programField);
        throw PlcRuntimeError(m_faultMessage);
    }
    if (m_options.launchIdentityProvider &&
        (!identityReceived || workerIdentity.sessionExecutionId != m_runtimeIdentity.sessionExecutionId ||
         workerIdentity.runtimeInstanceId != m_runtimeIdentity.runtimeInstanceId ||
         workerIdentity.launchGeneration != m_runtimeIdentity.launchGeneration)) {
        markFaulted("identidade/provenance de launch do worker PLC divergente");
        throw PlcRuntimeError(m_faultMessage);
    }

    if (m_hasRetainSnapshot) {
        const std::string reply = sendRequestExpectingOk("RETAIN_IMPORT", m_retainSnapshot);
        if (!reply.empty()) {
            markFaulted("worker PLC retornou dados inesperados ao restaurar RETAIN");
            throw PlcRuntimeError(m_faultMessage);
        }
    }

    m_state = PlcRuntimeState::Ready;
    m_hasScanned = false;
    m_lastAcceptedTimeNs = -1;
    recordPlcTrace(trace::EventType::PlcWorkerLaunchReady, m_runtimeIdentity, 0, 0, 0);
}

PlcScanResult PlcRuntime::scan(const PlcScanRequest& request) {
    ensureStarted();
    if (m_hasScanned && request.simulationTimeNs <= m_lastAcceptedTimeNs) {
        throw PlcRuntimeError("simulationTimeNs deve ser estritamente maior que o ultimo scan aceito (" +
                              std::to_string(m_lastAcceptedTimeNs) + "), recebido " + std::to_string(request.simulationTimeNs));
        // Nota: esta checagem é redundante com a que o PlcScanSession (F9.2) já faz do lado do
        // worker -- mantida aqui TAMBÉM pra rejeitar ANTES de sequer mandar a requisição, evitando
        // gastar um round-trip inteiro com algo que o Core já sabe que vai falhar. Não é uma
        // segunda fonte de verdade divergente: os dois usam a MESMA regra (estritamente maior).
    }

    std::string args = std::to_string(request.simulationTimeNs);
    for (const auto& [name, value] : request.inputs) {
        args += " " + name + "=" + value;
    }
    const uint64_t sequence = m_requestSequence + 1;
    recordPlcTrace(trace::EventType::PlcScanBegin, m_runtimeIdentity, sequence, 0,
                   request.simulationTimeNs < 0 ? 0 : static_cast<uint64_t>(request.simulationTimeNs));
    const std::string response = sendRequestExpectingOk("SCAN", args);

    PlcScanResult result;
    std::istringstream stream(response);
    std::string token;
    while (stream >> token) {
        const size_t eq = token.find('=');
        if (eq == std::string::npos) {
            markFaulted("resposta de SCAN com par nome=valor malformado: " + token);
            throw PlcRuntimeError(m_faultMessage);
        }
        result.outputs[token.substr(0, eq)] = token.substr(eq + 1);
    }

    checkpointRetainSnapshot();

    // Só atualiza o estado do lado do Core DEPOIS de ter parseado a resposta inteira com sucesso --
    // se qualquer coisa acima tivesse lançado, m_lastAcceptedTimeNs/m_hasScanned continuariam com o
    // valor anterior, nunca um estado "meio avançado".
    m_hasScanned = true;
    m_lastAcceptedTimeNs = request.simulationTimeNs;
    recordPlcTrace(trace::EventType::PlcScanCommit, m_runtimeIdentity, sequence, sequence,
                   request.simulationTimeNs < 0 ? 0 : static_cast<uint64_t>(request.simulationTimeNs));
    return result;
}

PlcScanResult PlcRuntime::event(const PlcScanRequest& request) {
    ensureStarted();
    if (request.eventTasks.empty()) throw PlcRuntimeError("EVENT requer pelo menos uma task SINGLE");
    if (m_hasScanned && request.simulationTimeNs < m_lastAcceptedTimeNs)
        throw PlcRuntimeError("timestamp de EVENT anterior à última ativação");
    std::string args = std::to_string(request.simulationTimeNs) + " ";
    for (size_t i = 0; i < request.eventTasks.size(); ++i) {
        if (i) args += ",";
        args += request.eventTasks[i];
    }
    for (const auto& [name, value] : request.inputs) args += " " + name + "=" + value;
    const uint64_t sequence = m_requestSequence + 1;
    recordPlcTrace(trace::EventType::PlcEventDispatch, m_runtimeIdentity, sequence, 0,
                   request.simulationTimeNs < 0 ? 0 : static_cast<uint64_t>(request.simulationTimeNs));
    const std::string response = sendRequestExpectingOk("EVENT", args);
    PlcScanResult result;
    std::istringstream stream(response);
    std::string token;
    while (stream >> token) {
        const size_t eq = token.find('=');
        if (eq == std::string::npos) { markFaulted("resposta EVENT malformada: " + token); throw PlcRuntimeError(m_faultMessage); }
        result.outputs[token.substr(0, eq)] = token.substr(eq + 1);
    }
    checkpointRetainSnapshot();
    m_hasScanned = true;
    m_lastAcceptedTimeNs = std::max(m_lastAcceptedTimeNs, request.simulationTimeNs);
    recordPlcTrace(trace::EventType::PlcScanCommit, m_runtimeIdentity, sequence, sequence,
                   request.simulationTimeNs < 0 ? 0 : static_cast<uint64_t>(request.simulationTimeNs));
    return result;
}

// Monitor e forçamento valem antes do primeiro scan (forçar uma entrada e então rodar): o worker
// sobe aqui como no scan. Faulted continua exigindo restart()/reset() explícito.
std::string PlcRuntime::get(const std::string& qualifiedName) {
    if (m_state == PlcRuntimeState::Stopped) ensureStarted();
    return sendRequestExpectingOk("GET", qualifiedName);
}
std::string PlcRuntime::set(const std::string& qualifiedName, const std::string& value) {
    if (m_state == PlcRuntimeState::Stopped) ensureStarted();
    const std::string response = sendRequestExpectingOk("SET", qualifiedName + " " + value);
    checkpointRetainSnapshot();
    return response;
}
std::string PlcRuntime::force(const std::string& qualifiedName, const std::string& value) {
    if (m_state == PlcRuntimeState::Stopped) ensureStarted();
    return sendRequestExpectingOk("FORCE", qualifiedName + " " + value);
}
std::string PlcRuntime::unforce(const std::string& qualifiedName) {
    if (m_state == PlcRuntimeState::Stopped) ensureStarted();
    return sendRequestExpectingOk("UNFORCE", qualifiedName);
}

void PlcRuntime::reset() {
    // Nesta rodada, reset = matar o worker atual + subir um novo (novo processo, handshake do
    // zero) -- garante estado inicial conhecido de forma determinística sem implementar a
    // semantica IEC completa de Cold/Warm Reset (RETAIN, etc. -- ver plano F9 Rodada 1). O comando
    // RESET do proprio protocolo PlcScanSession (F9.2, reinicializa a instancia NO MESMO processo)
    // fica reservado para quando fizer sentido reaproveitar o processo em vez de respawnar --
    // nao usado aqui para nao introduzir dois caminhos de "reset" com garantias sutilmente
    // diferentes nesta rodada.
    if (m_process) m_process->terminate();
    m_retainSnapshot.clear();
    m_hasRetainSnapshot = false;
    if (!m_options.retainStoragePath.empty()) {
        std::error_code ignored;
        std::filesystem::remove(m_options.retainStoragePath, ignored);
    }
    m_process.reset();
    m_state = PlcRuntimeState::Stopped;
    m_faultMessage.clear();
    m_hasScanned = false;
    m_lastAcceptedTimeNs = -1;
    ensureStarted();
}

void PlcRuntime::restart() { reset(); }

void PlcRuntime::warmReset() {
    if (m_state == PlcRuntimeState::Stopped) ensureStarted();
    sendRequestExpectingOk("RESET", "");
    m_hasScanned = false;
    m_lastAcceptedTimeNs = -1;
}

void PlcRuntime::shutdown() {
    if (m_state == PlcRuntimeState::Stopped) return;
    if (m_process && m_process->running()) {
        if (m_state == PlcRuntimeState::Ready) {
            try {
                m_retainSnapshot = sendRequestExpectingOk("RETAIN_EXPORT", "");
                m_hasRetainSnapshot = true;
                writeRetainSnapshotDurably();
            } catch (const PlcRuntimeError& error) {
                // Encerramento continua limitado pelo watchdog mesmo se o worker estiver falhando.
                if (!m_faultMessage.empty()) m_faultMessage += "; ";
                m_faultMessage += error.what();
            }
        }
        if (m_process && m_process->running()) {
            const std::string requestId = nextRequestId();
            m_process->writeLine("SHUTDOWN " + requestId);
            m_process->waitForExit(std::chrono::milliseconds(m_options.shutdownTimeoutMs));
        }
    }
    forceKill();
}

void PlcRuntime::checkpointRetainSnapshot() {
    if (m_options.retainStoragePath.empty() || m_module.retainLayout.empty()) return;
    try {
        m_retainSnapshot = sendRequestExpectingOk("RETAIN_EXPORT", "");
        m_hasRetainSnapshot = true;
        writeRetainSnapshotDurably();
    } catch (const std::exception& error) {
        if (m_state != PlcRuntimeState::Faulted) markFaulted("falha ao persistir checkpoint RETAIN: " + std::string(error.what()));
        throw PlcRuntimeError(m_faultMessage);
    }
}

void PlcRuntime::writeRetainSnapshotDurably() {
    if (m_options.retainStoragePath.empty() || !m_hasRetainSnapshot) return;
    namespace fs = std::filesystem;
    const fs::path destination = m_options.retainStoragePath;
    std::error_code ec;
    fs::create_directories(destination.parent_path(), ec);
    if (ec) throw PlcRuntimeError("nao foi possivel criar o diretorio de RETAIN: " + ec.message());
#if defined(_WIN32)
    const auto processId = static_cast<unsigned long long>(GetCurrentProcessId());
#else
    const auto processId = static_cast<unsigned long long>(::getpid());
#endif
    fs::path temporary = destination;
    temporary += ".tmp." + std::to_string(processId);
    {
        std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
        if (!output) throw PlcRuntimeError("nao foi possivel criar arquivo temporario de RETAIN");
        output.write(m_retainSnapshot.data(), static_cast<std::streamsize>(m_retainSnapshot.size()));
        output.flush();
        if (!output) throw PlcRuntimeError("nao foi possivel gravar snapshot RETAIN");
    }
#if defined(_WIN32)
    HANDLE snapshotFile = CreateFileW(temporary.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                      FILE_ATTRIBUTE_NORMAL, nullptr);
    const bool flushed = snapshotFile != INVALID_HANDLE_VALUE && FlushFileBuffers(snapshotFile);
    if (snapshotFile != INVALID_HANDLE_VALUE) CloseHandle(snapshotFile);
    if (!flushed) {
        fs::remove(temporary, ec);
        throw PlcRuntimeError("nao foi possivel sincronizar snapshot RETAIN em disco");
    }
    if (!MoveFileExW(temporary.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        const DWORD error = GetLastError();
        fs::remove(temporary, ec);
        throw PlcRuntimeError("nao foi possivel publicar snapshot RETAIN atomico (Windows " + std::to_string(error) + ")");
    }
#else
    const int snapshotFd = ::open(temporary.c_str(), O_WRONLY);
    const bool fileFlushed = snapshotFd >= 0 && ::fsync(snapshotFd) == 0;
    if (snapshotFd >= 0) ::close(snapshotFd);
    if (!fileFlushed) {
        fs::remove(temporary, ec);
        throw PlcRuntimeError("nao foi possivel sincronizar snapshot RETAIN em disco");
    }
    if (::rename(temporary.c_str(), destination.c_str()) != 0) {
        const int error = errno;
        fs::remove(temporary, ec);
        throw PlcRuntimeError("nao foi possivel publicar snapshot RETAIN atomico (errno " + std::to_string(error) + ")");
    }
    const int directoryFd = ::open(destination.parent_path().c_str(), O_RDONLY | O_DIRECTORY);
    const bool directoryFlushed = directoryFd >= 0 && ::fsync(directoryFd) == 0;
    if (directoryFd >= 0) ::close(directoryFd);
    if (!directoryFlushed) throw PlcRuntimeError("nao foi possivel sincronizar diretorio do snapshot RETAIN");
#endif
}

void PlcRuntime::forceKill() {
    if (m_process) m_process->terminate();
    m_process.reset();
    m_state = PlcRuntimeState::Stopped;
}

bool PlcRuntime::workerRunning() const { return m_process && m_process->running(); }
uint64_t PlcRuntime::workerProcessId() const { return m_process ? m_process->processId() : 0; }

} // namespace lasecsimul::plc
