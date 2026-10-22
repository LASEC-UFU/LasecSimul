// User-Defined Functions: Fcn. A expressão é compilada AQUI (a frio) para bytecode pós-fixo do
// kernel `fcn` (UserDefinedKernels.cpp). Gramática e precedência da documentação do bloco
// (maior -> menor): ( ); ^; + - unários; !; * /; + - binários; > < <= >=; == !=; &&; ||.
// u ou u(1) é o 1º elemento da entrada, u(i) o i-ésimo. Funções: abs acos asin atan atan2 ceil cos
// cosh exp floor hypot log log10 power rem sgn sin sinh sqrt tan tanh. Variáveis do Model Workspace
// entram como constantes.
#include <cctype>

#include "BuilderCommon.hpp"
#include "simulation/library/kernels/KernelOps.hpp"

namespace lasecsimul::components::blocks::builders {
namespace {

class FcnCompiler {
public:
    FcnCompiler(const BuildContext& context, std::string_view text) : m_context(context), m_text(text) {}

    void compile() {
        orExpr();
        skip();
        if (m_position != m_text.size()) error("token inesperado");
    }
    std::vector<int64_t> program() const {
        std::vector<int64_t> ip{std::max<int64_t>(1, m_maxDepth)};
        ip.insert(ip.end(), m_code.begin(), m_code.end());
        return ip;
    }
    const std::vector<double>& constants() const { return m_constants; }
    int64_t maxInputIndex() const { return m_maxInput; }

private:
    [[noreturn]] void error(const std::string& message) const {
        m_context.fail("expressao invalida na coluna " + std::to_string(m_position + 1) + ": " + message);
    }
    void skip() { while (m_position < m_text.size() && std::isspace(static_cast<unsigned char>(m_text[m_position]))) ++m_position; }
    bool accept(std::string_view token) {
        skip();
        if (m_text.substr(m_position, token.size()) != token) return false;
        // `<` não pode consumir o início de `<=`; idem `>`, `=` de `==`, `!` de `!=`.
        if (token.size() == 1 && (token == "<" || token == ">" || token == "!" || token == "~") &&
            m_position + 1 < m_text.size() && m_text[m_position + 1] == '=') return false;
        if (token.size() == 1 && (token == "&" || token == "|")) return false;
        m_position += token.size();
        return true;
    }
    void emit(int64_t op, int64_t arg, int delta) {
        m_code.push_back(op);
        m_code.push_back(arg);
        m_depth += delta;
        m_maxDepth = std::max<int64_t>(m_maxDepth, m_depth);
    }
    void pushConstant(double value) {
        m_constants.push_back(value);
        emit(lib::FcnPushConst, static_cast<int64_t>(m_constants.size() - 1), 1);
    }

    void orExpr() { andExpr(); while (accept("||")) { andExpr(); emit(lib::FcnOr, 0, -1); } }
    void andExpr() { equality(); while (accept("&&")) { equality(); emit(lib::FcnAnd, 0, -1); } }
    void equality() {
        relational();
        while (true) {
            if (accept("==")) { relational(); emit(lib::FcnEq, 0, -1); }
            else if (accept("!=") || accept("~=")) { relational(); emit(lib::FcnNe, 0, -1); }
            else return;
        }
    }
    void relational() {
        additive();
        while (true) {
            if (accept(">=")) { additive(); emit(lib::FcnGe, 0, -1); }
            else if (accept("<=")) { additive(); emit(lib::FcnLe, 0, -1); }
            else if (accept(">")) { additive(); emit(lib::FcnGt, 0, -1); }
            else if (accept("<")) { additive(); emit(lib::FcnLt, 0, -1); }
            else return;
        }
    }
    void additive() {
        multiplicative();
        while (true) {
            if (accept("+")) { multiplicative(); emit(lib::FcnAdd, 0, -1); }
            else if (accept("-")) { multiplicative(); emit(lib::FcnSub, 0, -1); }
            else return;
        }
    }
    void multiplicative() {
        logicalNot();
        while (true) {
            if (accept("*")) { logicalNot(); emit(lib::FcnMul, 0, -1); }
            else if (accept("/")) { logicalNot(); emit(lib::FcnDiv, 0, -1); }
            else return;
        }
    }
    void logicalNot() {
        if (accept("!") || accept("~")) { logicalNot(); emit(lib::FcnNot, 0, 0); return; }
        unarySign();
    }
    void unarySign() {
        if (accept("-")) { unarySign(); emit(lib::FcnNeg, 0, 0); return; }
        if (accept("+")) { unarySign(); return; }
        power();
    }
    /** `^` liga mais forte que o sinal unário à esquerda (`-2^2 = -4`) e é associativo à esquerda. */
    void power() {
        primary();
        while (accept("^")) {
            if (accept("-")) { primary(); emit(lib::FcnNeg, 0, 0); }
            else { accept("+"); primary(); }
            emit(lib::FcnPow, 0, -1);
        }
    }
    void primary() {
        skip();
        if (m_position >= m_text.size()) error("operando ausente");
        const char c = m_text[m_position];
        if (c == '(') { ++m_position; orExpr(); if (!accept(")")) error("')' ausente"); return; }
        if (std::isdigit(static_cast<unsigned char>(c)) || c == '.') { number(); return; }
        if (!std::isalpha(static_cast<unsigned char>(c)) && c != '_') error("operando invalido");
        const size_t begin = m_position;
        while (m_position < m_text.size() && (std::isalnum(static_cast<unsigned char>(m_text[m_position])) || m_text[m_position] == '_')) ++m_position;
        const std::string name(m_text.substr(begin, m_position - begin));
        if (name == "u") { inputReference(); return; }
        if (accept("(")) { function(name); return; }
        if (name == "pi") { pushConstant(3.14159265358979323846); return; }
        if (name == "eps") { pushConstant(std::numeric_limits<double>::epsilon()); return; }
        if (name == "inf" || name == "Inf") { pushConstant(std::numeric_limits<double>::infinity()); return; }
        if (name == "nan" || name == "NaN") { pushConstant(std::numeric_limits<double>::quiet_NaN()); return; }
        if (m_context.resolution.workspace) {
            if (const lib::ParamValue* variable = m_context.resolution.workspace->find(name)) {
                if (!variable->isScalar()) error("variavel '" + name + "' precisa ser escalar");
                pushConstant(variable->data[0]);
                return;
            }
        }
        error("identificador desconhecido '" + name + "'");
    }
    void number() {
        const std::string rest(m_text.substr(m_position));
        char* end = nullptr;
        const double value = std::strtod(rest.c_str(), &end);
        const size_t consumed = static_cast<size_t>(end - rest.c_str());
        if (consumed == 0) error("numero invalido");
        m_position += consumed;
        pushConstant(value);
    }
    void inputReference() {
        int64_t index = 1;
        if (accept("(") || accept("[")) {
            skip();
            const size_t begin = m_position;
            while (m_position < m_text.size() && std::isdigit(static_cast<unsigned char>(m_text[m_position]))) ++m_position;
            if (begin == m_position) error("indice de u precisa ser inteiro");
            index = std::stoll(std::string(m_text.substr(begin, m_position - begin)));
            if (!accept(")") && !accept("]")) error("')' ausente em u(i)");
            if (index < 1) error("indice de u comeca em 1");
        }
        m_maxInput = std::max(m_maxInput, index);
        emit(lib::FcnPushInput, index - 1, 1);
    }
    void function(const std::string& name) {
        struct Entry { const char* name; int64_t op; int arity; };
        static constexpr Entry kFunctions[] = {
            {"abs", lib::FcnAbs, 1}, {"acos", lib::FcnAcos, 1}, {"asin", lib::FcnAsin, 1}, {"atan", lib::FcnAtan, 1},
            {"atan2", lib::FcnAtan2, 2}, {"ceil", lib::FcnCeil, 1}, {"cos", lib::FcnCos, 1}, {"cosh", lib::FcnCosh, 1},
            {"exp", lib::FcnExp, 1}, {"floor", lib::FcnFloor, 1}, {"hypot", lib::FcnHypot, 2}, {"log", lib::FcnLog, 1},
            {"log10", lib::FcnLog10, 1}, {"power", lib::FcnPow, 2}, {"rem", lib::FcnRem, 2}, {"sgn", lib::FcnSgn, 1},
            {"sin", lib::FcnSin, 1}, {"sinh", lib::FcnSinh, 1}, {"sqrt", lib::FcnSqrt, 1}, {"tan", lib::FcnTan, 1},
            {"tanh", lib::FcnTanh, 1},
        };
        for (const Entry& entry : kFunctions) {
            if (name != entry.name) continue;
            orExpr();
            for (int argument = 1; argument < entry.arity; ++argument) {
                if (!accept(",")) error(name + " exige " + std::to_string(entry.arity) + " argumentos");
                orExpr();
            }
            if (!accept(")")) error("')' ausente em " + name);
            emit(entry.op, 0, entry.arity == 2 ? -1 : 0);
            return;
        }
        error("funcao nao suportada pelo bloco Fcn: " + name);
    }

    const BuildContext& m_context;
    std::string_view m_text;
    size_t m_position = 0;
    std::vector<int64_t> m_code;
    std::vector<double> m_constants;
    int64_t m_depth = 0;
    int64_t m_maxDepth = 0;
    int64_t m_maxInput = 0;
};

void buildFcn(BuildContext& c) {
    c.outputWidths = {1};
    if (c.widthsOnly) return;
    const std::string expression = c.text("Expr");
    FcnCompiler compiler(c, expression);
    compiler.compile();
    if (compiler.maxInputIndex() > c.inputWidth(0))
        c.fail("u(" + std::to_string(compiler.maxInputIndex()) + ") excede a largura da entrada (" + std::to_string(c.inputWidth(0)) + ")");
    simulation::SignalBlockDefinition& block = c.kernel("", "fcn", inputWidths(c), 1,
                                                        compiler.constants(), compiler.program());
    // The Fcn schema declares SampleTime and Simulink Fcn inherits it by default. Leaving the
    // generated kernel at the continuous default splits a discrete TDPS feedback SCC across
    // incompatible rate groups even when the persisted block explicitly says 0.01 s.
    block.rate = c.resolution.rate;
    c.connectInputs(c.outputBlock(0));
}

} // namespace

void registerUserDefinedBuilders(BuilderTable& table) { table.add("fcn", buildFcn); }

} // namespace lasecsimul::components::blocks::builders
