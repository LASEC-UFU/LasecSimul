#include "PlcCompiler.hpp"

#include <array>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <optional>
#include <regex>
#include <sstream>
#include <thread>

#include "PlcDriverCodegen.hpp"
#include "PlcInterfaceParser.hpp"
#include "lasecsimul/Sha256.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace lasecsimul::plc {

namespace {

namespace fs = std::filesystem;

std::string readFile(const fs::path& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) return {};
    std::ostringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

void writeFile(const fs::path& path, const std::string& content) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file << content;
}

[[noreturn]] void fail(const std::string& stage, const std::string& message, std::string capturedOutput = {}, int exitCode = 0) {
    throw PlcCompileError(PlcCompileDiagnostics{stage, message, std::move(capturedOutput), exitCode});
}

// =============================================================================
// Processo curto (STruCpp, compilador C++): roda, espera terminar, captura stdout+stderr
// combinados via redirecionamento pra arquivo temporario -- deliberadamente NAO usa pipes/thread
// leitora (achado real de F8/PythonRuntime: gerenciar pipes bidirecionais de verdade tem uma
// classe inteira de bugs sutis de Windows; um comando que so roda ate terminar nao precisa disso,
// so esperar e ler o arquivo depois).
// =============================================================================

struct ProcessRunResult {
    int exitCode = -1;
    std::string combinedOutput;
    bool spawnFailed = false;
    std::string spawnError;
};

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

ProcessRunResult runProcessCapturingOutput(const std::string& executable, const std::vector<std::string>& args,
                                           const fs::path& workingDir, std::chrono::milliseconds timeout) {
    ProcessRunResult result;
    const fs::path outputFile = workingDir / "__plc_compiler_output.tmp.txt";
    std::error_code removeError;
    fs::remove(outputFile, removeError);

    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = TRUE;
    HANDLE outputHandle = CreateFileW(outputFile.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ, &attributes,
                                      CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (outputHandle == INVALID_HANDLE_VALUE) {
        result.spawnFailed = true;
        result.spawnError = "falha ao criar arquivo temporario de saida: " + outputFile.string();
        return result;
    }

    std::wstring command = quoteWindowsArg(executable);
    for (const auto& arg : args) command += L" " + quoteWindowsArg(arg);

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = outputHandle;
    startup.hStdError = outputHandle;
    startup.hStdInput = nullptr;

    PROCESS_INFORMATION processInfo{};
    const BOOL created = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                                        nullptr, workingDir.wstring().c_str(), &startup, &processInfo);
    CloseHandle(outputHandle);
    if (!created) {
        result.spawnFailed = true;
        result.spawnError = "falha ao iniciar processo: " + executable;
        return result;
    }

    const DWORD waitResult = WaitForSingleObject(processInfo.hProcess, static_cast<DWORD>(timeout.count()));
    if (waitResult == WAIT_TIMEOUT) {
        TerminateProcess(processInfo.hProcess, 1);
        WaitForSingleObject(processInfo.hProcess, 2000);
        result.spawnFailed = true;
        result.spawnError = "processo excedeu o timeout e foi encerrado: " + executable;
    } else {
        DWORD exitCode = 0;
        GetExitCodeProcess(processInfo.hProcess, &exitCode);
        result.exitCode = static_cast<int>(exitCode);
    }
    CloseHandle(processInfo.hProcess);
    CloseHandle(processInfo.hThread);

    result.combinedOutput = readFile(outputFile);
    fs::remove(outputFile, removeError);
    return result;
}
#else
ProcessRunResult runProcessCapturingOutput(const std::string& executable, const std::vector<std::string>& args,
                                           const fs::path& workingDir, std::chrono::milliseconds timeout) {
    ProcessRunResult result;
    const fs::path outputFile = workingDir / "__plc_compiler_output.tmp.txt";
    std::error_code removeError;
    fs::remove(outputFile, removeError);

    const pid_t pid = fork();
    if (pid < 0) {
        result.spawnFailed = true;
        result.spawnError = "fork() falhou";
        return result;
    }
    if (pid == 0) {
        if (chdir(workingDir.string().c_str()) != 0) _exit(126);
        const int fd = open(outputFile.string().c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) _exit(126);
        dup2(fd, STDOUT_FILENO);
        dup2(fd, STDERR_FILENO);
        close(fd);
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(executable.c_str()));
        for (const auto& arg : args) argv.push_back(const_cast<char*>(arg.c_str()));
        argv.push_back(nullptr);
        execvp(executable.c_str(), argv.data());
        _exit(127);
    }

    const auto deadline = std::chrono::steady_clock::now() + timeout;
    int status = 0;
    for (;;) {
        const pid_t waited = waitpid(pid, &status, WNOHANG);
        if (waited == pid) {
            result.exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            break;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            result.spawnFailed = true;
            result.spawnError = "processo excedeu o timeout e foi encerrado: " + executable;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    result.combinedOutput = readFile(outputFile);
    fs::remove(outputFile, removeError);
    return result;
}
#endif

// =============================================================================
// Resolucao de toolchain -- nunca cai silenciosamente pro PATH quando algo foi configurado
// explicitamente (opcao ou variavel de ambiente); so tenta PATH quando NADA foi configurado.
// =============================================================================

bool isExecutableAvailable(const std::string& command) {
    ProcessRunResult result = runProcessCapturingOutput(command, {"--version"}, fs::temp_directory_path(),
                                                         std::chrono::milliseconds(5000));
    return !result.spawnFailed && result.exitCode == 0;
}

std::string resolveCxxCompiler(const fs::path& configured) {
    if (!configured.empty()) {
        const std::string configuredStr = configured.string();
        if (!isExecutableAvailable(configuredStr)) {
            fail("toolchain", "compilador C++ configurado nao encontrado/nao executavel: " + configuredStr);
        }
        return configuredStr;
    }
    if (const char* envVar = std::getenv("LASECSIMUL_PLC_CXX"); envVar && *envVar) {
        if (!isExecutableAvailable(envVar)) {
            fail("toolchain", "LASECSIMUL_PLC_CXX aponta pra um compilador nao encontrado/nao executavel: " + std::string(envVar));
        }
        return envVar;
    }
    for (const char* candidate : {"g++", "gcc"}) {
        if (isExecutableAvailable(candidate)) return candidate;
    }
    fail("toolchain",
        "nenhum compilador C++ compativel encontrado (tentado g++, gcc no PATH). O STruCpp nao "
        "empacota toolchain proprio -- instale um MinGW-w64/UCRT (Windows) ou configure "
        "LASECSIMUL_PLC_CXX. Ver scripts/check-plc-toolchain.js.");
}

// =============================================================================
// Diretivas #line -> debugMap (achado real de F9.2: STLineMap e artefato so do harness REPL da
// STruCpp; #line, emitido por `strucpp --line-directives`, e o mecanismo real disponivel na
// compilacao simples).
// =============================================================================

std::vector<PlcDebugLineMapping> extractDebugMapFromLineDirectives(const std::string& generatedCpp) {
    std::vector<PlcDebugLineMapping> debugMap;
    static const std::regex kLineDirective(R"re(^#line\s+(\d+)\s+"([^"]*)")re");
    std::istringstream stream(generatedCpp);
    std::string line;
    uint32_t generatedLineNumber = 0;
    while (std::getline(stream, line)) {
        ++generatedLineNumber;
        std::smatch match;
        if (std::regex_search(line, match, kLineDirective)) {
            debugMap.push_back({generatedLineNumber, match[2].str(), static_cast<uint32_t>(std::stoul(match[1].str()))});
        }
    }
    return debugMap;
}

std::string platformKey() {
#if defined(_WIN32)
    return "windows";
#elif defined(__linux__)
    return "linux";
#elif defined(__APPLE__)
    return "darwin";
#else
    return "unknown";
#endif
}

std::string archKey() {
#if defined(_WIN64) || defined(__x86_64__) || defined(__aarch64__)
#if defined(__aarch64__) || defined(_M_ARM64)
    return "arm64";
#else
    return "x64";
#endif
#else
    return "unknown";
#endif
}

// =============================================================================
// Validacao do artefato: spawna o binario compilado de verdade, fala HELLO/SHUTDOWN via
// stdin/stdout reais -- so entao o modulo e considerado utilizavel. Pipes bidirecionais mínimos,
// deliberadamente NAO reaproveitando PlcRuntime (que nem existe ainda -- isso e F9.4) nem
// PythonRuntime::Process (dominio diferente) -- so o necessario pra esta checagem pontual.
// =============================================================================

#if defined(_WIN32)
bool validateArtifact(const fs::path& binaryPath, std::string& errorOut) {
    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = TRUE;

    HANDLE childStdinRead = nullptr, stdinWrite = nullptr;
    HANDLE stdoutRead = nullptr, childStdoutWrite = nullptr;
    if (!CreatePipe(&childStdinRead, &stdinWrite, &attributes, 0) ||
        !CreatePipe(&stdoutRead, &childStdoutWrite, &attributes, 0)) {
        errorOut = "falha ao criar pipes de validacao";
        return false;
    }
    SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = childStdinRead;
    startup.hStdOutput = childStdoutWrite;
    startup.hStdError = childStdoutWrite;

    std::wstring command = quoteWindowsArg(binaryPath.string());
    PROCESS_INFORMATION processInfo{};
    const BOOL created = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                                        nullptr, nullptr, &startup, &processInfo);
    CloseHandle(childStdinRead);
    CloseHandle(childStdoutWrite);
    if (!created) {
        CloseHandle(stdinWrite);
        CloseHandle(stdoutRead);
        errorOut = "falha ao iniciar o artefato compilado pra validacao";
        return false;
    }

    auto writeLine = [&](const std::string& line) {
        std::string wire = line + "\n";
        DWORD written = 0;
        WriteFile(stdinWrite, wire.data(), static_cast<DWORD>(wire.size()), &written, nullptr);
    };
    auto readLine = [&](std::chrono::milliseconds timeout) -> std::optional<std::string> {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        std::string buffer;
        for (;;) {
            const size_t newline = buffer.find('\n');
            if (newline != std::string::npos) return buffer.substr(0, newline);
            DWORD available = 0;
            if (!PeekNamedPipe(stdoutRead, nullptr, 0, nullptr, &available, nullptr)) return std::nullopt;
            if (available > 0) {
                char chunk[256];
                DWORD count = 0;
                if (!ReadFile(stdoutRead, chunk, sizeof(chunk), &count, nullptr)) return std::nullopt;
                buffer.append(chunk, count);
                continue;
            }
            if (std::chrono::steady_clock::now() >= deadline) return std::nullopt;
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    };

    writeLine("HELLO validate1");
    const auto helloResponse = readLine(std::chrono::milliseconds(5000));
    bool ok = helloResponse.has_value() && helloResponse->rfind("OK validate1", 0) == 0;
    if (!ok) errorOut = "artefato nao respondeu HELLO corretamente: " +
                        (helloResponse ? *helloResponse : std::string("(timeout/sem resposta)"));

    writeLine("SHUTDOWN validate2");
    WaitForSingleObject(processInfo.hProcess, 3000);
    TerminateProcess(processInfo.hProcess, 0); // idempotente se ja tiver saido sozinho

    CloseHandle(stdinWrite);
    CloseHandle(stdoutRead);
    CloseHandle(processInfo.hProcess);
    CloseHandle(processInfo.hThread);
    return ok;
}
#else
bool validateArtifact(const fs::path& binaryPath, std::string& errorOut) {
    int inputPipe[2];
    int outputPipe[2];
    if (pipe(inputPipe) != 0 || pipe(outputPipe) != 0) {
        errorOut = "falha ao criar pipes de validacao";
        return false;
    }
    const pid_t pid = fork();
    if (pid < 0) {
        errorOut = "fork() falhou na validacao";
        return false;
    }
    if (pid == 0) {
        dup2(inputPipe[0], STDIN_FILENO);
        dup2(outputPipe[1], STDOUT_FILENO);
        dup2(outputPipe[1], STDERR_FILENO);
        close(inputPipe[0]); close(inputPipe[1]);
        close(outputPipe[0]); close(outputPipe[1]);
        execl(binaryPath.string().c_str(), binaryPath.string().c_str(), nullptr);
        _exit(127);
    }
    close(inputPipe[0]);
    close(outputPipe[1]);
    fcntl(outputPipe[0], F_SETFL, fcntl(outputPipe[0], F_GETFL, 0) | O_NONBLOCK);

    auto writeLine = [&](const std::string& line) {
        std::string wire = line + "\n";
        write(inputPipe[1], wire.data(), wire.size());
    };
    auto readLine = [&](std::chrono::milliseconds timeout) -> std::optional<std::string> {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        std::string buffer;
        for (;;) {
            const size_t newline = buffer.find('\n');
            if (newline != std::string::npos) return buffer.substr(0, newline);
            struct pollfd descriptor { outputPipe[0], POLLIN, 0 };
            const int ready = poll(&descriptor, 1, 20);
            if (ready > 0 && (descriptor.revents & POLLIN)) {
                char chunk[256];
                const ssize_t count = read(outputPipe[0], chunk, sizeof(chunk));
                if (count > 0) buffer.append(chunk, static_cast<size_t>(count));
            }
            if (std::chrono::steady_clock::now() >= deadline) return std::nullopt;
        }
    };

    writeLine("HELLO validate1");
    const auto helloResponse = readLine(std::chrono::milliseconds(5000));
    bool ok = helloResponse.has_value() && helloResponse->rfind("OK validate1", 0) == 0;
    if (!ok) errorOut = "artefato nao respondeu HELLO corretamente: " +
                        (helloResponse ? *helloResponse : std::string("(timeout/sem resposta)"));

    writeLine("SHUTDOWN validate2");
    int status = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(3000);
    while (waitpid(pid, &status, WNOHANG) == 0 && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    kill(pid, SIGKILL); // idempotente se ja tiver saido sozinho
    waitpid(pid, &status, 0);

    close(inputPipe[1]);
    close(outputPipe[0]);
    return ok;
}
#endif

} // namespace

PlcNativeModule PlcCompiler::compile(const PlcCompileOptions& options) {
    if (options.strucppBinaryPath.empty() || !fs::exists(options.strucppBinaryPath)) {
        fail("toolchain", "binario STruCpp nao encontrado: " + options.strucppBinaryPath.string() +
                          " -- rode 'npm run build:strucpp' e passe o caminho resolvido.");
    }
    if (options.runtimeIncludeDir.empty() || !fs::exists(options.runtimeIncludeDir)) {
        fail("toolchain", "runtimeIncludeDir nao encontrado: " + options.runtimeIncludeDir.string());
    }
    if (options.lasecsimulPlcSrcDir.empty() || !fs::exists(options.lasecsimulPlcSrcDir)) {
        fail("toolchain", "lasecsimulPlcSrcDir nao encontrado: " + options.lasecsimulPlcSrcDir.string());
    }
    if (options.stSourcePath.empty() || !fs::exists(options.stSourcePath)) {
        fail("parse", "arquivo fonte ST nao encontrado: " + options.stSourcePath.string());
    }
    const std::string cxxCompiler = resolveCxxCompiler(options.cxxCompilerPath);

    std::error_code mkdirError;
    fs::create_directories(options.workDir, mkdirError);

    const std::string stSource = readFile(options.stSourcePath);
    PlcParsedInterface parsedInterface;
    try {
        parsedInterface = parsePlcProgramInterface(stSource);
    } catch (const PlcInterfaceParseError& error) {
        fail("parse", error.what());
    }

    const std::string programNameLower = options.stSourcePath.stem().string();
    const fs::path generatedCppPath = options.workDir / (programNameLower + ".cpp");
    const fs::path generatedHppPath = options.workDir / (programNameLower + ".hpp");

    ProcessRunResult strucppResult = runProcessCapturingOutput(
        options.strucppBinaryPath.string(),
        {options.stSourcePath.string(), "-o", generatedCppPath.string(), "--line-directives", "--source-comments"},
        options.workDir, std::chrono::milliseconds(30000));
    if (strucppResult.spawnFailed) {
        fail("strucpp", strucppResult.spawnError, strucppResult.combinedOutput);
    }
    if (strucppResult.exitCode != 0 || !fs::exists(generatedCppPath) || !fs::exists(generatedHppPath)) {
        fail("strucpp", "STruCpp falhou ao compilar " + options.stSourcePath.string(),
            strucppResult.combinedOutput, strucppResult.exitCode);
    }

    const std::string generatedCpp = readFile(generatedCppPath);
    const std::vector<PlcDebugLineMapping> debugMap = extractDebugMapFromLineDirectives(generatedCpp);

    std::string driverSource;
    try {
        driverSource = generatePlcWorkerDriverSource(parsedInterface, generatedHppPath.filename().string());
    } catch (const std::exception& error) {
        fail("codegen", error.what());
    }
    const fs::path driverCppPath = options.workDir / "driver.cpp";
    writeFile(driverCppPath, driverSource);

    const fs::path binaryPath = options.workDir / (programNameLower +
#if defined(_WIN32)
        ".exe"
#else
        ""
#endif
    );
    std::error_code removeBinaryError;
    fs::remove(binaryPath, removeBinaryError); // nunca deixar um binario da compilacao ANTERIOR
                                                // parecer valido se esta falhar antes de recriar.

    std::vector<std::string> cxxArgs = {
        "-std=c++17", "-O2",
        "-I", options.runtimeIncludeDir.string(),
        "-I", options.lasecsimulPlcSrcDir.string(),
        "-I", options.workDir.string(),
        driverCppPath.string(), generatedCppPath.string(),
        (options.lasecsimulPlcSrcDir / "PlcScanSession.cpp").string(),
        "-o", binaryPath.string(),
    };
#if defined(_WIN32)
    // MinGW/ld: remove o timestamp de build embutido no cabecalho PE -- sem isso, artifactHash
    // nunca seria deterministico entre dois builds identicos (requisito explicito desta rodada).
    cxxArgs.push_back("-Wl,--no-insert-timestamp");
#endif
    ProcessRunResult cxxResult = runProcessCapturingOutput(cxxCompiler, cxxArgs, options.workDir, std::chrono::milliseconds(120000));
    if (cxxResult.spawnFailed) {
        fail("cxx", cxxResult.spawnError, cxxResult.combinedOutput);
    }
    if (cxxResult.exitCode != 0 || !fs::exists(binaryPath)) {
        fail("cxx", "compilador C++ falhou ao compilar o driver/artefato PLC", cxxResult.combinedOutput, cxxResult.exitCode);
    }

    std::string validationError;
    if (!validateArtifact(binaryPath, validationError)) {
        std::error_code removeInvalidError;
        fs::remove(binaryPath, removeInvalidError); // nunca deixar um binario que compilou mas nao
                                                     // responde corretamente parecer utilizavel.
        fail("validate", "artefato compilado nao passou na validacao HELLO/SHUTDOWN: " + validationError);
    }

    PlcNativeModule module;
    module.formatVersion = 1;
    module.workerProtocolVersion = 1;
    module.targetPlatform = platformKey();
    module.targetArch = archKey();
    {
        // Lido do PROPRIO binario em execucao (`strucpp --version` -> "STruC++ version X.Y.Z"),
        // nunca hardcoded aqui -- fonte unica de verdade continua sendo scripts/strucpp-pin.json,
        // que decide QUAL binario foi baixado; este apenas relata o que esse binario diz de si.
        ProcessRunResult strucppVersionResult = runProcessCapturingOutput(
            options.strucppBinaryPath.string(), {"--version"}, options.workDir, std::chrono::milliseconds(5000));
        std::string versionLine = strucppVersionResult.combinedOutput;
        const size_t lastSpace = versionLine.find_last_of(' ');
        module.strucppVersion = (lastSpace != std::string::npos) ? versionLine.substr(lastSpace + 1) : versionLine;
        // trim de espaco/quebra de linha residual
        while (!module.strucppVersion.empty() && std::isspace(static_cast<unsigned char>(module.strucppVersion.back()))) {
            module.strucppVersion.pop_back();
        }
        // Headers de core/src/plc/runtime/include/ vem do MESMO pacote de release que este
        // binario (ver scripts/build-strucpp.js) -- revisao da runtime = mesma versao do compilador.
        module.runtimeRevision = module.strucppVersion;
    }
    {
        ProcessRunResult versionResult = runProcessCapturingOutput(cxxCompiler, {"--version"}, options.workDir, std::chrono::milliseconds(5000));
        std::istringstream versionStream(versionResult.combinedOutput);
        std::string firstLine;
        std::getline(versionStream, firstLine);
        module.cxxToolchainVersion = firstLine;
    }
    module.sourceHash = Sha256::hashFile(options.stSourcePath);
    module.artifactHash = Sha256::hashFile(binaryPath);
    module.nativeBinaryRef = binaryPath.string();
    module.programName = parsedInterface.programName;
    for (const auto& variable : parsedInterface.variables) {
        module.exportedIo.push_back({variable.name, variable.name, variable.direction, variable.iecType});
    }
    module.debugMap = debugMap;
    return module;
}

} // namespace lasecsimul::plc
