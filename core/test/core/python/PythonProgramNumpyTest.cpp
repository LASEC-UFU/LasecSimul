#include "python/PythonRuntime.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace lasecsimul;

int main() {
#if !defined(LASECSIMUL_TEST_PYTHON_EXECUTABLE)
    std::puts("PULADO: CMake nao encontrou um interpretador Python 3");
    return 0;
#else
    const char* overrideExecutable = std::getenv("LASECSIMUL_TEST_NUMPY_EXECUTABLE");
    const bool explicitlySelected = overrideExecutable && *overrideExecutable;
    const std::string executable = explicitlySelected ? overrideExecutable : LASECSIMUL_TEST_PYTHON_EXECUTABLE;
    auto budget = resources::ResourceGovernor::forProfile(resources::ResourceProfile::Desktop, 4).budget();
    budget.pythonStepTimeoutMs = 3000;
    budget.pythonMemoryBytes = 512ull * 1024ull * 1024ull;
    budget.pythonPayloadBytes = 256ull * 1024ull;
    python::PythonRuntime runtime(budget, executable);
    python::PythonBlockDefinition block;
    block.blockId = "numpy";
    block.source = "import numpy as np\nresult = float(np.clip(value * 2.0, 0.0, 100.0))";
    block.inputs = {{"value", "real"}};
    block.outputs = {{"result", "real", 0.0}};
    runtime.configure({block});
    python::PythonStep step;
    step.blockId = "numpy";
    step.typedInputs["value"] = 8.5;
    try {
        const auto result = runtime.stepBatch(0, "numpy", {step}).front();
        if (!result.error.empty()) {
            runtime.shutdown();
            if (!explicitlySelected && result.error.find("No module named 'numpy'") != std::string::npos) {
                std::puts("PULADO: NumPy nao esta instalado no interpretador Python selecionado");
                return 0;
            }
            std::fprintf(stderr, "NumPy integration failed in %s: %s\n", executable.c_str(), result.error.c_str());
            return 1;
        }
        const double output = std::get<double>(result.typedOutputs.at("result"));
        runtime.shutdown();
        if (!std::isfinite(output) || std::abs(output - 17.0) > 1e-9) {
            std::fprintf(stderr, "NumPy-backed Python block returned an incorrect result: %.17g\n", output);
            return 1;
        }
        std::puts("NumPy import and operations in the selected Python interpreter: OK");
        return 0;
    } catch (const std::exception& error) {
        runtime.shutdown();
        const std::string message = error.what();
        if (!explicitlySelected && message.find("No module named 'numpy'") != std::string::npos) {
            std::puts("PULADO: NumPy nao esta instalado no interpretador Python selecionado");
            return 0;
        }
        std::fprintf(stderr, "NumPy integration failed in %s: %s\n", executable.c_str(), message.c_str());
        return 1;
    }
#endif
}
