#include "PlcCompileCli.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>

#include <nlohmann/json.hpp>

#include "PlcCompiler.hpp"

namespace lasecsimul::plc {

namespace fs = std::filesystem;

namespace {

nlohmann::json moduleToJson(const PlcNativeModule& module) {
    nlohmann::json exportedIo = nlohmann::json::array();
    for (const auto& io : module.exportedIo) {
        exportedIo.push_back({{"ioId", io.ioId}, {"name", io.name}, {"direction", io.direction}, {"iecType", io.iecType}});
    }
    nlohmann::json debugMap = nlohmann::json::array();
    for (const auto& line : module.debugMap) {
        debugMap.push_back({{"generatedLine", line.generatedLine}, {"sourceFile", line.sourceFile},
                            {"sourceLine", line.sourceLine}});
    }
    return {
        {"formatVersion", module.formatVersion},
        {"workerProtocolVersion", module.workerProtocolVersion},
        {"targetPlatform", module.targetPlatform},
        {"targetArch", module.targetArch},
        {"strucppVersion", module.strucppVersion},
        {"runtimeRevision", module.runtimeRevision},
        {"cxxToolchainVersion", module.cxxToolchainVersion},
        {"sourceHash", module.sourceHash},
        {"artifactHash", module.artifactHash},
        {"nativeBinaryRef", module.nativeBinaryRef},
        {"programName", module.programName},
        {"exportedIo", exportedIo},
        {"debugMap", debugMap},
    };
}

int reply(const nlohmann::json& response, int exitCode) {
    // ensure_ascii: a saída do g++ pode trazer bytes que não são UTF-8 válido (página de código do
    // console); com replace o dump nunca lança e o JSON continua legível pela Extension.
    std::cout << response.dump(-1, ' ', true, nlohmann::json::error_handler_t::replace) << std::endl;
    return exitCode;
}

int failure(const std::string& stage, const std::string& message, const std::string& capturedOutput = {},
            int processExitCode = 0, int exitCode = 2) {
    return reply({{"ok", false},
                  {"diagnostics", {{"stage", stage}, {"message", message}, {"capturedOutput", capturedOutput},
                                   {"exitCode", processExitCode}}}},
                 exitCode);
}

/** `u8string()` é `std::u8string` em C++20; o JSON quer `std::string` UTF-8. */
std::string utf8(const fs::path& path) {
    const auto text = path.u8string();
    return std::string(text.begin(), text.end());
}

fs::path requiredPath(const nlohmann::json& request, const char* field) {
    if (!request.contains(field) || !request[field].is_string() || request[field].get<std::string>().empty()) {
        throw std::invalid_argument(std::string("campo obrigatorio ausente: ") + field);
    }
    return fs::u8path(request[field].get<std::string>());
}

} // namespace

int runPlcCompileCli(const std::string& requestPath) {
    nlohmann::json request;
    PlcCompileOptions options;
    fs::path manifestPath;
    try {
        std::ifstream input(fs::u8path(requestPath), std::ios::binary);
        if (!input) throw std::invalid_argument("pedido nao encontrado: " + requestPath);
        request = nlohmann::json::parse(input);
        options.stSourcePath = requiredPath(request, "stSourcePath");
        options.workDir = requiredPath(request, "workDir");
        options.strucppBinaryPath = requiredPath(request, "strucppBinaryPath");
        options.runtimeIncludeDir = requiredPath(request, "runtimeIncludeDir");
        options.lasecsimulPlcSrcDir = requiredPath(request, "lasecsimulPlcSrcDir");
        manifestPath = requiredPath(request, "manifestPath");
        if (request.contains("cxxCompilerPath") && request["cxxCompilerPath"].is_string()) {
            options.cxxCompilerPath = fs::u8path(request["cxxCompilerPath"].get<std::string>());
        }
        if (request.contains("strucppLibraryDirs") && request["strucppLibraryDirs"].is_array()) {
            for (const auto& libraryDir : request["strucppLibraryDirs"]) {
                if (libraryDir.is_string()) options.strucppLibraryDirs.push_back(fs::u8path(libraryDir.get<std::string>()));
            }
        }
        if (request.contains("ioIdByVariableName") && request["ioIdByVariableName"].is_object()) {
            for (const auto& [name, ioId] : request["ioIdByVariableName"].items()) {
                if (ioId.is_string()) options.ioIdByVariableName[name] = ioId.get<std::string>();
            }
        }
    } catch (const std::exception& error) {
        return failure("request", error.what(), {}, 0, 3);
    }

    try {
        const PlcNativeModule module = PlcCompiler::compile(options);
        std::error_code mkdirError;
        fs::create_directories(manifestPath.parent_path(), mkdirError);
        std::ofstream output(manifestPath, std::ios::binary | std::ios::trunc);
        output << moduleToJson(module).dump(2) << "\n";
        output.close();
        if (!output) return failure("manifest", "nao foi possivel gravar " + utf8(manifestPath));
        return reply({{"ok", true}, {"manifestPath", utf8(manifestPath)}}, 0);
    } catch (const PlcCompileError& error) {
        const auto& diagnostics = error.diagnostics();
        return failure(diagnostics.stage, diagnostics.message, diagnostics.capturedOutput, diagnostics.exitCode);
    } catch (const std::exception& error) {
        return failure("internal", error.what());
    }
}

} // namespace lasecsimul::plc
