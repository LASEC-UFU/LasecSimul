#pragma once
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

namespace lasecsimul::session {

enum class PauseSignalMode { Value, Voltage, Digital, Current, Rising, Falling };
using PauseScalar = std::variant<double, bool, uint64_t>;

struct PauseExpressionError : std::runtime_error {
    size_t column;
    PauseExpressionError(size_t column, std::string message) : std::runtime_error(std::move(message)), column(column) {}
};

struct PauseEvaluation {
    bool value = false;
    std::unordered_map<std::string, PauseScalar> resolvedValues;
};

class PauseExpression {
public:
    struct Node;
    using Resolver = std::function<PauseScalar(PauseSignalMode, const std::string&)>;
    PauseExpression();
    ~PauseExpression();
    PauseExpression(PauseExpression&&) noexcept;
    PauseExpression& operator=(PauseExpression&&) noexcept;
    PauseExpression(const PauseExpression&) = delete;
    PauseExpression& operator=(const PauseExpression&) = delete;

    static PauseExpression compile(const std::string& expression);
    PauseEvaluation evaluate(const Resolver& resolver);
    void resetEdges();
    bool empty() const;
    const std::string& source() const { return m_source; }

private:
    std::unique_ptr<Node> m_root;
    std::string m_source;
    std::unordered_map<std::string, bool> m_previousEdges;
};
} // namespace lasecsimul::session
