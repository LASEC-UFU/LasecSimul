#include "ParamExpr.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <limits>
#include <numeric>
#include <optional>

namespace lasecsimul::simulation::library {

double ParamValue::asScalar(std::string_view what) const {
    if (data.size() != 1) throw std::invalid_argument(std::string(what) + " precisa ser escalar");
    return data.front();
}

std::vector<double> ParamValue::linear() const {
    std::vector<double> result;
    result.reserve(data.size());
    for (size_t col = 0; col < cols; ++col)
        for (size_t row = 0; row < rows; ++row) result.push_back(data[row * cols + col]);
    return result;
}

const ParamValue* ParamWorkspace::find(std::string_view name) const {
    const auto it = m_values.find(std::string(name));
    if (it != m_values.end()) return &it->second;
    return m_parent ? m_parent->find(name) : nullptr;
}

namespace {

enum class TokenKind { Number, Ident, Op, LParen, RParen, LBracket, RBracket, Comma, Semicolon, Newline, End };

struct Token {
    TokenKind kind = TokenKind::End;
    std::string text;
    double number = 0.0;
    size_t column = 0;
    bool spaceBefore = false;
};

bool isIdentStart(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
bool isIdentPart(char c) { return isIdentStart(c) || (c >= '0' && c <= '9'); }
bool isDigit(char c) { return c >= '0' && c <= '9'; }

std::vector<Token> tokenize(std::string_view text) {
    std::vector<Token> tokens;
    size_t i = 0;
    bool space = false;
    const auto endsOperand = [&]() {
        if (tokens.empty()) return false;
        const Token& last = tokens.back();
        return last.kind == TokenKind::Number || last.kind == TokenKind::Ident || last.kind == TokenKind::RParen ||
               last.kind == TokenKind::RBracket || (last.kind == TokenKind::Op && (last.text == "'" || last.text == ".'"));
    };
    while (i < text.size()) {
        const char c = text[i];
        if (c == ' ' || c == '\t' || c == '\r') { space = true; ++i; continue; }
        if (c == '%') { while (i < text.size() && text[i] != '\n') ++i; continue; }
        if (c == '.' && text.substr(i, 3) == "...") { while (i < text.size() && text[i] != '\n') ++i; if (i < text.size()) ++i; space = true; continue; }
        Token token;
        token.column = i + 1;
        token.spaceBefore = space;
        space = false;
        if (c == '\n') { token.kind = TokenKind::Newline; ++i; tokens.push_back(token); continue; }
        if (isDigit(c) || (c == '.' && i + 1 < text.size() && isDigit(text[i + 1]))) {
            const size_t begin = i;
            while (i < text.size() && isDigit(text[i])) ++i;
            if (i < text.size() && text[i] == '.') {
                const char next = i + 1 < text.size() ? text[i + 1] : '\0';
                // `1.*2` é `1 .* 2`: o ponto pertence ao operador elemento a elemento.
                if (!(next == '*' || next == '/' || next == '^' || next == '\\' || next == '\'')) {
                    ++i;
                    while (i < text.size() && isDigit(text[i])) ++i;
                }
            }
            if (i < text.size() && (text[i] == 'e' || text[i] == 'E')) {
                size_t j = i + 1;
                if (j < text.size() && (text[j] == '+' || text[j] == '-')) ++j;
                if (j < text.size() && isDigit(text[j])) {
                    i = j;
                    while (i < text.size() && isDigit(text[i])) ++i;
                }
            }
            token.kind = TokenKind::Number;
            token.text = std::string(text.substr(begin, i - begin));
            token.number = std::strtod(token.text.c_str(), nullptr);
            tokens.push_back(token);
            continue;
        }
        if (isIdentStart(c)) {
            const size_t begin = i;
            while (i < text.size() && isIdentPart(text[i])) ++i;
            token.kind = TokenKind::Ident;
            token.text = std::string(text.substr(begin, i - begin));
            tokens.push_back(token);
            continue;
        }
        const auto two = text.substr(i, 2);
        if (two == "||" || two == "&&" || two == "==" || two == "~=" || two == "!=" || two == "<=" || two == ">=" ||
            two == ".*" || two == "./" || two == ".^" || two == ".\\" || two == ".'") {
            token.kind = TokenKind::Op;
            token.text = std::string(two == "!=" ? std::string_view("~=") : two);
            i += 2;
            tokens.push_back(token);
            continue;
        }
        switch (c) {
        case '(': token.kind = TokenKind::LParen; break;
        case ')': token.kind = TokenKind::RParen; break;
        case '[': token.kind = TokenKind::LBracket; break;
        case ']': token.kind = TokenKind::RBracket; break;
        case ',': token.kind = TokenKind::Comma; break;
        case ';': token.kind = TokenKind::Semicolon; break;
        case '\'':
            if (!endsOperand() || token.spaceBefore)
                throw ParamError("texto entre aspas nao e um valor numerico", token.column);
            token.kind = TokenKind::Op;
            break;
        case '+': case '-': case '*': case '/': case '\\': case '^': case '<': case '>': case '&': case '|':
        case '~': case '!': case ':':
            token.kind = TokenKind::Op;
            break;
        default:
            throw ParamError(std::string("caractere inesperado '") + c + "'", token.column);
        }
        token.text = std::string(1, c == '!' ? '~' : c);
        ++i;
        tokens.push_back(token);
    }
    Token end;
    end.kind = TokenKind::End;
    end.column = text.size() + 1;
    tokens.push_back(end);
    return tokens;
}

ParamValue makeValue(size_t rows, size_t cols, double fill = 0.0) {
    return ParamValue{rows, cols, std::vector<double>(rows * cols, fill)};
}

ParamValue transposed(const ParamValue& value) {
    ParamValue result = makeValue(value.cols, value.rows);
    for (size_t r = 0; r < value.rows; ++r)
        for (size_t c = 0; c < value.cols; ++c) result.data[c * value.rows + r] = value.data[r * value.cols + c];
    return result;
}

/** Broadcast elemento a elemento (expansão implícita do MATLAB: dimensão igual ou 1). */
ParamValue elementwise(const ParamValue& a, const ParamValue& b, const std::function<double(double, double)>& op,
                       size_t column) {
    if (a.empty() || b.empty()) {
        if ((a.empty() && (b.empty() || b.isScalar())) || (b.empty() && a.isScalar())) return ParamValue{};
        throw ParamError("operacao com matriz vazia", column);
    }
    const auto dim = [&](size_t x, size_t y) -> size_t {
        if (x == y || y == 1) return x;
        if (x == 1) return y;
        throw ParamError("dimensoes incompativeis (" + std::to_string(a.rows) + "x" + std::to_string(a.cols) + " e " +
                             std::to_string(b.rows) + "x" + std::to_string(b.cols) + ")", column);
    };
    const size_t rows = dim(a.rows, b.rows);
    const size_t cols = dim(a.cols, b.cols);
    ParamValue result = makeValue(rows, cols);
    for (size_t r = 0; r < rows; ++r)
        for (size_t c = 0; c < cols; ++c) {
            const double x = a.data[(a.rows == 1 ? 0 : r) * a.cols + (a.cols == 1 ? 0 : c)];
            const double y = b.data[(b.rows == 1 ? 0 : r) * b.cols + (b.cols == 1 ? 0 : c)];
            result.data[r * cols + c] = op(x, y);
        }
    return result;
}

ParamValue mapValue(const ParamValue& value, const std::function<double(double)>& op) {
    ParamValue result = value;
    for (double& element : result.data) element = op(element);
    return result;
}

ParamValue matrixProduct(const ParamValue& a, const ParamValue& b, size_t column) {
    if (a.isScalar() || b.isScalar()) return elementwise(a, b, [](double x, double y) { return x * y; }, column);
    if (a.cols != b.rows) throw ParamError("produto matricial exige colunas(A) == linhas(B)", column);
    ParamValue result = makeValue(a.rows, b.cols);
    for (size_t r = 0; r < a.rows; ++r)
        for (size_t c = 0; c < b.cols; ++c) {
            double sum = 0.0;
            for (size_t k = 0; k < a.cols; ++k) sum += a.data[r * a.cols + k] * b.data[k * b.cols + c];
            result.data[r * b.cols + c] = sum;
        }
    return result;
}

/** Resolve A*X = B por eliminação de Gauss com pivotamento parcial (A quadrada). */
ParamValue solveLinear(const ParamValue& a, const ParamValue& b, size_t column) {
    if (a.rows != a.cols || a.rows != b.rows) throw ParamError("divisao matricial exige matriz quadrada compativel", column);
    const size_t n = a.rows;
    std::vector<double> m = a.data;
    ParamValue x = b;
    for (size_t k = 0; k < n; ++k) {
        size_t pivot = k;
        for (size_t r = k + 1; r < n; ++r)
            if (std::abs(m[r * n + k]) > std::abs(m[pivot * n + k])) pivot = r;
        if (m[pivot * n + k] == 0.0) throw ParamError("matriz singular", column);
        if (pivot != k) {
            for (size_t c = 0; c < n; ++c) std::swap(m[k * n + c], m[pivot * n + c]);
            for (size_t c = 0; c < x.cols; ++c) std::swap(x.data[k * x.cols + c], x.data[pivot * x.cols + c]);
        }
        for (size_t r = 0; r < n; ++r) {
            if (r == k) continue;
            const double factor = m[r * n + k] / m[k * n + k];
            if (factor == 0.0) continue;
            for (size_t c = k; c < n; ++c) m[r * n + c] -= factor * m[k * n + c];
            for (size_t c = 0; c < x.cols; ++c) x.data[r * x.cols + c] -= factor * x.data[k * x.cols + c];
        }
    }
    for (size_t r = 0; r < n; ++r)
        for (size_t c = 0; c < x.cols; ++c) x.data[r * x.cols + c] /= m[r * n + r];
    return x;
}

ParamValue identity(size_t rows, size_t cols) {
    ParamValue result = makeValue(rows, cols);
    for (size_t i = 0; i < std::min(rows, cols); ++i) result.data[i * cols + i] = 1.0;
    return result;
}

ParamValue matrixPower(const ParamValue& a, const ParamValue& b, size_t column) {
    if (a.isScalar() && b.isScalar()) return ParamValue::scalar(std::pow(a.data[0], b.data[0]));
    if (!b.isScalar() || a.rows != a.cols) throw ParamError("'^' exige matriz quadrada e expoente escalar (use .^)", column);
    const double exponent = b.data[0];
    if (exponent != std::floor(exponent)) throw ParamError("potencia matricial so com expoente inteiro", column);
    ParamValue base = exponent < 0 ? solveLinear(a, identity(a.rows, a.rows), column) : a;
    long long n = static_cast<long long>(std::abs(exponent));
    ParamValue result = identity(a.rows, a.rows);
    while (n > 0) {
        if (n & 1) result = matrixProduct(result, base, column);
        base = matrixProduct(base, base, column);
        n >>= 1;
    }
    return result;
}

ParamValue concatenateRow(const std::vector<ParamValue>& items, size_t column) {
    size_t rows = 0, cols = 0;
    for (const ParamValue& item : items) {
        if (item.empty()) continue;
        if (rows == 0) rows = item.rows;
        else if (item.rows != rows) throw ParamError("concatenacao horizontal com numero de linhas diferente", column);
        cols += item.cols;
    }
    ParamValue result = makeValue(rows, cols);
    size_t offset = 0;
    for (const ParamValue& item : items) {
        if (item.empty()) continue;
        for (size_t r = 0; r < rows; ++r)
            for (size_t c = 0; c < item.cols; ++c) result.data[r * cols + offset + c] = item.data[r * item.cols + c];
        offset += item.cols;
    }
    return result;
}

ParamValue concatenateColumn(const std::vector<ParamValue>& items, size_t column) {
    size_t rows = 0, cols = 0;
    for (const ParamValue& item : items) {
        if (item.empty()) continue;
        if (cols == 0) cols = item.cols;
        else if (item.cols != cols) throw ParamError("concatenacao vertical com numero de colunas diferente", column);
        rows += item.rows;
    }
    ParamValue result = makeValue(rows, cols);
    size_t offset = 0;
    for (const ParamValue& item : items) {
        if (item.empty()) continue;
        std::copy(item.data.begin(), item.data.end(), result.data.begin() + static_cast<std::ptrdiff_t>(offset * cols));
        offset += item.rows;
    }
    return result;
}

std::vector<double> polyConv(const std::vector<double>& a, const std::vector<double>& b) {
    if (a.empty() || b.empty()) return {};
    std::vector<double> result(a.size() + b.size() - 1, 0.0);
    for (size_t i = 0; i < a.size(); ++i)
        for (size_t j = 0; j < b.size(); ++j) result[i + j] += a[i] * b[j];
    return result;
}

class Parser {
public:
    Parser(std::string_view text, const ParamWorkspace* workspace) : m_tokens(tokenize(text)), m_workspace(workspace) {}

    ParamValue parse() {
        skipNewlines();
        if (peek().kind == TokenKind::End) return ParamValue{};
        ParamValue value = orExpr();
        skipNewlines();
        if (peek().kind != TokenKind::End) throw ParamError("token inesperado '" + peek().text + "'", peek().column);
        return value;
    }

private:
    const Token& peek(size_t ahead = 0) const { return m_tokens[std::min(m_position + ahead, m_tokens.size() - 1)]; }
    Token next() { return m_tokens[m_position++]; }
    bool inMatrix() const { return !m_context.empty() && m_context.back() == '['; }
    void skipNewlines() { while (peek().kind == TokenKind::Newline) ++m_position; }
    bool isOp(const Token& token, std::string_view op) const { return token.kind == TokenKind::Op && token.text == op; }

    /** Dentro de `[ ]`, um espaço antes de um operando (ou de `+`/`-` colado no operando seguinte)
     * começa um NOVO elemento -- `[1 -2]` são dois elementos, `[1 - 2]` é um. */
    bool startsNewElement() const {
        if (!inMatrix()) return false;
        const Token& token = peek();
        if (!token.spaceBefore) return false;
        if (token.kind == TokenKind::Op && (token.text == "+" || token.text == "-"))
            return !peek(1).spaceBefore && peek(1).kind != TokenKind::End;
        return token.kind == TokenKind::Number || token.kind == TokenKind::Ident || token.kind == TokenKind::LParen ||
               token.kind == TokenKind::LBracket || (token.kind == TokenKind::Op && token.text == "~");
    }

    ParamValue orExpr() {
        ParamValue left = andExpr();
        while (!startsNewElement() && (isOp(peek(), "||") || isOp(peek(), "|"))) {
            const Token op = next();
            ParamValue right = andExpr();
            left = elementwise(left, right, [](double a, double b) { return (a != 0.0 || b != 0.0) ? 1.0 : 0.0; }, op.column);
        }
        return left;
    }
    ParamValue andExpr() {
        ParamValue left = comparison();
        while (!startsNewElement() && (isOp(peek(), "&&") || isOp(peek(), "&"))) {
            const Token op = next();
            ParamValue right = comparison();
            left = elementwise(left, right, [](double a, double b) { return (a != 0.0 && b != 0.0) ? 1.0 : 0.0; }, op.column);
        }
        return left;
    }
    ParamValue comparison() {
        ParamValue left = range();
        while (!startsNewElement() && peek().kind == TokenKind::Op &&
               (peek().text == "==" || peek().text == "~=" || peek().text == "<" || peek().text == "<=" ||
                peek().text == ">" || peek().text == ">=")) {
            const Token op = next();
            ParamValue right = range();
            const std::string o = op.text;
            left = elementwise(left, right, [o](double a, double b) {
                const bool r = o == "==" ? a == b : o == "~=" ? a != b : o == "<" ? a < b : o == "<=" ? a <= b : o == ">" ? a > b : a >= b;
                return r ? 1.0 : 0.0;
            }, op.column);
        }
        return left;
    }
    ParamValue range() {
        ParamValue first = additive();
        if (startsNewElement() || !isOp(peek(), ":")) return first;
        const size_t column = next().column;
        ParamValue second = additive();
        std::optional<ParamValue> third;
        if (!startsNewElement() && isOp(peek(), ":")) { next(); third = additive(); }
        const double start = first.asScalar("inicio da faixa");
        const double step = third ? second.asScalar("passo da faixa") : 1.0;
        const double stop = third ? third->asScalar("fim da faixa") : second.asScalar("fim da faixa");
        if (step == 0.0 || !std::isfinite(start) || !std::isfinite(step) || !std::isfinite(stop))
            throw ParamError("faixa invalida", column);
        const double span = (stop - start) / step;
        if (span < -1e-10) return ParamValue{};
        const size_t count = static_cast<size_t>(std::floor(span + 1e-10)) + 1;
        if (count > 1'000'000) throw ParamError("faixa grande demais", column);
        std::vector<double> values(count);
        for (size_t i = 0; i < count; ++i) values[i] = start + static_cast<double>(i) * step;
        return ParamValue::row(std::move(values));
    }
    ParamValue additive() {
        ParamValue left = multiplicative();
        while (!startsNewElement() && peek().kind == TokenKind::Op && (peek().text == "+" || peek().text == "-")) {
            const Token op = next();
            ParamValue right = multiplicative();
            left = op.text == "+" ? elementwise(left, right, std::plus<double>(), op.column)
                                  : elementwise(left, right, std::minus<double>(), op.column);
        }
        return left;
    }
    ParamValue multiplicative() {
        ParamValue left = unary();
        while (!startsNewElement() && peek().kind == TokenKind::Op &&
               (peek().text == "*" || peek().text == "/" || peek().text == ".*" || peek().text == "./" ||
                peek().text == "\\" || peek().text == ".\\")) {
            const Token op = next();
            ParamValue right = unary();
            if (op.text == "*") left = matrixProduct(left, right, op.column);
            else if (op.text == ".*") left = elementwise(left, right, std::multiplies<double>(), op.column);
            else if (op.text == "./") left = elementwise(left, right, std::divides<double>(), op.column);
            else if (op.text == ".\\") left = elementwise(left, right, [](double a, double b) { return b / a; }, op.column);
            else if (op.text == "/") {
                if (right.isScalar()) left = elementwise(left, right, std::divides<double>(), op.column);
                else left = transposed(solveLinear(transposed(right), transposed(left), op.column));
            } else {
                if (left.isScalar()) left = elementwise(right, left, std::divides<double>(), op.column);
                else left = solveLinear(left, right, op.column);
            }
        }
        return left;
    }
    ParamValue unary() {
        if (peek().kind == TokenKind::Op && (peek().text == "-" || peek().text == "+" || peek().text == "~")) {
            const Token op = next();
            ParamValue value = unary();
            if (op.text == "-") return mapValue(value, [](double x) { return -x; });
            if (op.text == "~") return mapValue(value, [](double x) { return x == 0.0 ? 1.0 : 0.0; });
            return value;
        }
        return power();
    }
    /** `^` liga mais forte que o unário à esquerda (`-2^2 == -4`) e aceita unário à direita (`2^-1`). */
    ParamValue power() {
        ParamValue base = postfix();
        while (!startsNewElement() && peek().kind == TokenKind::Op && (peek().text == "^" || peek().text == ".^")) {
            const Token op = next();
            ParamValue exponent;
            if (peek().kind == TokenKind::Op && (peek().text == "-" || peek().text == "+" || peek().text == "~")) {
                const Token sign = next();
                exponent = postfix();
                if (sign.text == "-") exponent = mapValue(exponent, [](double x) { return -x; });
                else if (sign.text == "~") exponent = mapValue(exponent, [](double x) { return x == 0.0 ? 1.0 : 0.0; });
            } else {
                exponent = postfix();
            }
            base = op.text == ".^" ? elementwise(base, exponent, [](double a, double b) { return std::pow(a, b); }, op.column)
                                   : matrixPower(base, exponent, op.column);
        }
        return base;
    }
    ParamValue postfix() {
        ParamValue value = primary();
        while (true) {
            if (peek().kind == TokenKind::Op && (peek().text == "'" || peek().text == ".'") && !peek().spaceBefore) {
                next();
                value = transposed(value);
                continue;
            }
            // Indexação só de variável (como no MATLAB, `[1 2 3](2)` é erro) -- feita em `identifier`.
            return value;
        }
    }

    std::vector<ParamValue> arguments(const ParamValue* indexed) {
        std::vector<ParamValue> args;
        m_context.push_back('(');
        skipNewlines();
        if (peek().kind == TokenKind::RParen) { next(); m_context.pop_back(); return args; }
        size_t position = 0;
        while (true) {
            skipNewlines();
            if (indexed && isOp(peek(), ":") && (peek(1).kind == TokenKind::Comma || peek(1).kind == TokenKind::RParen)) {
                next();
                args.push_back(ParamValue{0, 0, {std::numeric_limits<double>::quiet_NaN()}});
            } else {
                // `end` dentro do índice vale o tamanho na dimensão correspondente.
                const double previousEnd = m_endValue;
                if (indexed) m_endValue = static_cast<double>(m_endDims.empty() ? indexed->numel() : m_endDims.at(std::min(position, m_endDims.size() - 1)));
                args.push_back(orExpr());
                m_endValue = previousEnd;
            }
            ++position;
            skipNewlines();
            if (peek().kind == TokenKind::Comma) { next(); continue; }
            if (peek().kind == TokenKind::RParen) { next(); break; }
            throw ParamError("',' ou ')' esperado", peek().column);
        }
        m_context.pop_back();
        return args;
    }

    ParamValue index(const ParamValue& value, size_t column) {
        // Pré-varre quantos índices há para `end` saber a dimensão: 1 índice = linear; 2 = (linha, coluna).
        size_t depth = 0, commas = 0;
        for (size_t i = m_position; i < m_tokens.size(); ++i) {
            const TokenKind kind = m_tokens[i].kind;
            if (kind == TokenKind::LParen || kind == TokenKind::LBracket) ++depth;
            else if (kind == TokenKind::RParen || kind == TokenKind::RBracket) { if (depth == 0) break; --depth; }
            else if (kind == TokenKind::Comma && depth == 0) ++commas;
        }
        const std::vector<size_t> previousDims = m_endDims;
        m_endDims = commas == 0 ? std::vector<size_t>{value.numel()} : std::vector<size_t>{value.rows, value.cols};
        std::vector<ParamValue> args = arguments(&value);
        m_endDims = previousDims;
        const auto indices = [&](const ParamValue& arg, size_t limit) {
            std::vector<size_t> result;
            if (arg.rows == 0 && arg.cols == 0 && arg.data.size() == 1 && std::isnan(arg.data[0])) {
                for (size_t i = 0; i < limit; ++i) result.push_back(i);
                return result;
            }
            for (double raw : arg.data) {
                if (raw != std::floor(raw) || raw < 1 || raw > static_cast<double>(limit))
                    throw ParamError("indice fora da faixa", column);
                result.push_back(static_cast<size_t>(raw) - 1);
            }
            return result;
        };
        if (args.size() == 1) {
            const std::vector<double> linearValues = value.linear();
            const std::vector<size_t> picked = indices(args[0], linearValues.size());
            std::vector<double> out;
            for (size_t i : picked) out.push_back(linearValues[i]);
            if (value.cols == 1 && value.rows > 1) return ParamValue{out.size(), out.empty() ? size_t{0} : size_t{1}, out};
            return ParamValue::row(std::move(out));
        }
        if (args.size() == 2) {
            const std::vector<size_t> rows = indices(args[0], value.rows);
            const std::vector<size_t> cols = indices(args[1], value.cols);
            ParamValue result = makeValue(rows.size(), cols.size());
            for (size_t r = 0; r < rows.size(); ++r)
                for (size_t c = 0; c < cols.size(); ++c) result.data[r * cols.size() + c] = value.data[rows[r] * value.cols + cols[c]];
            return result;
        }
        throw ParamError("indexacao suporta 1 ou 2 indices", column);
    }

    ParamValue matrixLiteral(size_t column) {
        m_context.push_back('[');
        std::vector<ParamValue> rows;
        std::vector<ParamValue> current;
        bool rowHasContent = false;
        while (true) {
            const Token& token = peek();
            if (token.kind == TokenKind::RBracket) {
                next();
                if (rowHasContent || !current.empty()) rows.push_back(concatenateRow(current, column));
                break;
            }
            if (token.kind == TokenKind::End) throw ParamError("']' ausente", column);
            if (token.kind == TokenKind::Semicolon || token.kind == TokenKind::Newline) {
                next();
                if (!current.empty()) rows.push_back(concatenateRow(current, column));
                current.clear();
                rowHasContent = false;
                continue;
            }
            if (token.kind == TokenKind::Comma) { next(); continue; }
            current.push_back(orExpr());
            rowHasContent = true;
        }
        m_context.pop_back();
        return concatenateColumn(rows, column);
    }

    ParamValue primary() {
        const Token token = next();
        switch (token.kind) {
        case TokenKind::Number: return ParamValue::scalar(token.number);
        case TokenKind::LParen: {
            m_context.push_back('(');
            ParamValue value = orExpr();
            m_context.pop_back();
            if (peek().kind != TokenKind::RParen) throw ParamError("')' ausente", token.column);
            next();
            return value;
        }
        case TokenKind::LBracket: return matrixLiteral(token.column);
        case TokenKind::Ident: return identifier(token);
        default: break;
        }
        throw ParamError(token.kind == TokenKind::End ? "expressao incompleta" : "operando invalido '" + token.text + "'",
                         token.column);
    }

    ParamValue identifier(const Token& token) {
        const std::string& name = token.text;
        if (name == "end") {
            if (std::isnan(m_endValue)) throw ParamError("'end' fora de uma indexacao", token.column);
            return ParamValue::scalar(m_endValue);
        }
        const bool call = peek().kind == TokenKind::LParen && !(inMatrix() && peek().spaceBefore);
        if (m_workspace) {
            if (const ParamValue* variable = m_workspace->find(name)) {
                if (!call) return *variable;
                const Token open = next();
                return index(*variable, open.column);
            }
        }
        if (name == "pi" && !call) return ParamValue::scalar(3.14159265358979323846);
        if ((name == "Inf" || name == "inf") && !call) return ParamValue::scalar(std::numeric_limits<double>::infinity());
        if ((name == "NaN" || name == "nan") && !call) return ParamValue::scalar(std::numeric_limits<double>::quiet_NaN());
        if (name == "eps" && !call) return ParamValue::scalar(std::numeric_limits<double>::epsilon());
        if (name == "realmax" && !call) return ParamValue::scalar(std::numeric_limits<double>::max());
        if (name == "realmin" && !call) return ParamValue::scalar(std::numeric_limits<double>::min());
        if (name == "true" && !call) return ParamValue::scalar(1.0);
        if (name == "false" && !call) return ParamValue::scalar(0.0);
        if (!call) throw ParamError("variavel nao definida: '" + name + "' (defina-a no Model Workspace do projeto)", token.column);
        next();
        std::vector<ParamValue> args = arguments(nullptr);
        return callFunction(name, args, token.column);
    }

    ParamValue callFunction(const std::string& name, std::vector<ParamValue>& args, size_t column) {
        const auto need = [&](size_t minimum, size_t maximum) {
            if (args.size() < minimum || args.size() > maximum)
                throw ParamError("numero de argumentos invalido para " + name, column);
        };
        const auto unaryMap = [&](double (*fn)(double)) { need(1, 1); return mapValue(args[0], fn); };
        if (name == "abs") return unaryMap([](double x) { return std::abs(x); });
        if (name == "sqrt") return unaryMap([](double x) { return std::sqrt(x); });
        if (name == "exp") return unaryMap([](double x) { return std::exp(x); });
        if (name == "log") return unaryMap([](double x) { return std::log(x); });
        if (name == "log10") return unaryMap([](double x) { return std::log10(x); });
        if (name == "log2") return unaryMap([](double x) { return std::log2(x); });
        if (name == "sin") return unaryMap([](double x) { return std::sin(x); });
        if (name == "cos") return unaryMap([](double x) { return std::cos(x); });
        if (name == "tan") return unaryMap([](double x) { return std::tan(x); });
        if (name == "asin") return unaryMap([](double x) { return std::asin(x); });
        if (name == "acos") return unaryMap([](double x) { return std::acos(x); });
        if (name == "atan") return unaryMap([](double x) { return std::atan(x); });
        if (name == "sinh") return unaryMap([](double x) { return std::sinh(x); });
        if (name == "cosh") return unaryMap([](double x) { return std::cosh(x); });
        if (name == "tanh") return unaryMap([](double x) { return std::tanh(x); });
        if (name == "floor") return unaryMap([](double x) { return std::floor(x); });
        if (name == "ceil") return unaryMap([](double x) { return std::ceil(x); });
        if (name == "round") return unaryMap([](double x) { return std::round(x); });
        if (name == "fix") return unaryMap([](double x) { return std::trunc(x); });
        if (name == "sign") return unaryMap([](double x) { return x > 0.0 ? 1.0 : x < 0.0 ? -1.0 : 0.0; });
        if (name == "deg2rad") return unaryMap([](double x) { return x * 3.14159265358979323846 / 180.0; });
        if (name == "rad2deg") return unaryMap([](double x) { return x * 180.0 / 3.14159265358979323846; });
        if (name == "isinf") return unaryMap([](double x) { return std::isinf(x) ? 1.0 : 0.0; });
        if (name == "isnan") return unaryMap([](double x) { return std::isnan(x) ? 1.0 : 0.0; });
        if (name == "isfinite") return unaryMap([](double x) { return std::isfinite(x) ? 1.0 : 0.0; });
        if (name == "real" || name == "double") { need(1, 1); return args[0]; }
        if (name == "not") return unaryMap([](double x) { return x == 0.0 ? 1.0 : 0.0; });
        if (name == "transpose") { need(1, 1); return transposed(args[0]); }
        if (name == "atan2" || name == "mod" || name == "rem" || name == "hypot" || name == "power") {
            need(2, 2);
            std::function<double(double, double)> op;
            if (name == "atan2") op = [](double y, double x) { return std::atan2(y, x); };
            else if (name == "hypot") op = [](double a, double b) { return std::hypot(a, b); };
            else if (name == "power") op = [](double a, double b) { return std::pow(a, b); };
            else if (name == "rem") op = [](double a, double b) { return b == 0.0 ? std::numeric_limits<double>::quiet_NaN() : a - std::trunc(a / b) * b; };
            else op = [](double a, double b) { return b == 0.0 ? a : a - std::floor(a / b) * b; };
            return elementwise(args[0], args[1], op, column);
        }
        if (name == "max" || name == "min") {
            need(1, 2);
            const bool isMax = name == "max";
            if (args.size() == 2) return elementwise(args[0], args[1], [isMax](double a, double b) { return isMax ? std::max(a, b) : std::min(a, b); }, column);
            return reduce(args[0], [isMax](const std::vector<double>& v) {
                return isMax ? *std::max_element(v.begin(), v.end()) : *std::min_element(v.begin(), v.end());
            });
        }
        if (name == "sum") { need(1, 1); return reduce(args[0], [](const std::vector<double>& v) { return std::accumulate(v.begin(), v.end(), 0.0); }, 0.0); }
        if (name == "prod") { need(1, 1); return reduce(args[0], [](const std::vector<double>& v) { return std::accumulate(v.begin(), v.end(), 1.0, std::multiplies<double>()); }, 1.0); }
        if (name == "mean") { need(1, 1); return reduce(args[0], [](const std::vector<double>& v) { return std::accumulate(v.begin(), v.end(), 0.0) / static_cast<double>(v.size()); }); }
        if (name == "numel") { need(1, 1); return ParamValue::scalar(static_cast<double>(args[0].numel())); }
        if (name == "length") { need(1, 1); return ParamValue::scalar(args[0].empty() ? 0.0 : static_cast<double>(std::max(args[0].rows, args[0].cols))); }
        if (name == "size") {
            need(1, 2);
            if (args.size() == 2) {
                const double dim = args[1].asScalar("dimensao");
                return ParamValue::scalar(dim == 1.0 ? static_cast<double>(args[0].rows) : dim == 2.0 ? static_cast<double>(args[0].cols) : 1.0);
            }
            return ParamValue::row({static_cast<double>(args[0].rows), static_cast<double>(args[0].cols)});
        }
        if (name == "zeros" || name == "ones" || name == "eye") {
            need(0, 2);
            size_t rows = 1, cols = 1;
            const auto count = [&](const ParamValue& v) {
                const double n = v.asScalar("dimensao");
                if (n < 0 || n != std::floor(n) || n > 1e6) throw ParamError("dimensao invalida", column);
                return static_cast<size_t>(n);
            };
            if (args.size() == 1 && args[0].numel() == 2) { rows = count(ParamValue::scalar(args[0].data[0])); cols = count(ParamValue::scalar(args[0].data[1])); }
            else if (args.size() >= 1) { rows = count(args[0]); cols = args.size() == 2 ? count(args[1]) : rows; }
            if (name == "eye") return identity(rows, cols);
            return makeValue(rows, cols, name == "ones" ? 1.0 : 0.0);
        }
        if (name == "diag") {
            need(1, 1);
            const ParamValue& v = args[0];
            if (v.isVector()) {
                const size_t n = v.numel();
                ParamValue result = makeValue(n, n);
                for (size_t i = 0; i < n; ++i) result.data[i * n + i] = v.data[i];
                return result;
            }
            std::vector<double> d;
            for (size_t i = 0; i < std::min(v.rows, v.cols); ++i) d.push_back(v.data[i * v.cols + i]);
            return ParamValue{d.size(), d.empty() ? size_t{0} : size_t{1}, d};
        }
        if (name == "linspace") {
            need(2, 3);
            const double a = args[0].asScalar("inicio"), b = args[1].asScalar("fim");
            const double n = args.size() == 3 ? args[2].asScalar("n") : 100.0;
            if (n < 1 || n != std::floor(n)) throw ParamError("n invalido em linspace", column);
            std::vector<double> values(static_cast<size_t>(n));
            for (size_t i = 0; i < values.size(); ++i) values[i] = values.size() == 1 ? b : a + (b - a) * static_cast<double>(i) / static_cast<double>(values.size() - 1);
            return ParamValue::row(std::move(values));
        }
        if (name == "conv") { need(2, 2); return ParamValue::row(polyConv(args[0].linear(), args[1].linear())); }
        if (name == "poly") {
            need(1, 1);
            std::vector<double> p{1.0};
            for (double root : args[0].linear()) p = polyConv(p, {1.0, -root});
            return ParamValue::row(std::move(p));
        }
        if (name == "polyval") {
            need(2, 2);
            const std::vector<double> p = args[0].linear();
            return mapValue(args[1], [p](double x) { double y = 0.0; for (double c : p) y = y * x + c; return y; });
        }
        if (name == "repmat") {
            need(2, 3);
            const size_t m = static_cast<size_t>(args[1].asScalar("m"));
            const size_t n = args.size() == 3 ? static_cast<size_t>(args[2].asScalar("n")) : m;
            std::vector<ParamValue> row(n, args[0]);
            std::vector<ParamValue> column(m, concatenateRow(row, 0));
            return concatenateColumn(column, 0);
        }
        if (name == "reshape") {
            need(3, 3);
            const size_t rows = static_cast<size_t>(args[1].asScalar("linhas"));
            const size_t cols = static_cast<size_t>(args[2].asScalar("colunas"));
            const std::vector<double> linearValues = args[0].linear();
            if (rows * cols != linearValues.size()) throw ParamError("reshape com numero de elementos diferente", column);
            ParamValue result = makeValue(rows, cols);
            for (size_t i = 0; i < linearValues.size(); ++i) result.data[(i % rows) * cols + i / rows] = linearValues[i];
            return result;
        }
        if (name == "fliplr" || name == "flipud") {
            need(1, 1);
            ParamValue result = args[0];
            for (size_t r = 0; r < result.rows; ++r)
                for (size_t c = 0; c < result.cols; ++c)
                    result.data[r * result.cols + c] = name == "fliplr" ? args[0].data[r * result.cols + (result.cols - 1 - c)]
                                                                        : args[0].data[(result.rows - 1 - r) * result.cols + c];
            return result;
        }
        if (name == "cumsum") {
            need(1, 1);
            ParamValue result = args[0];
            double sum = 0.0;
            if (result.isVector()) for (double& value : result.data) { sum += value; value = sum; }
            else throw ParamError("cumsum so para vetores", column);
            return result;
        }
        if (name == "inv") { need(1, 1); return solveLinear(args[0], identity(args[0].rows, args[0].rows), column); }
        if (name == "pi" || name == "Inf" || name == "inf" || name == "NaN" || name == "nan" || name == "eps") {
            need(0, 0);
            return identifierConstant(name);
        }
        throw ParamError("funcao nao suportada: " + name, column);
    }

    static ParamValue identifierConstant(const std::string& name) {
        if (name == "pi") return ParamValue::scalar(3.14159265358979323846);
        if (name == "eps") return ParamValue::scalar(std::numeric_limits<double>::epsilon());
        if (name == "NaN" || name == "nan") return ParamValue::scalar(std::numeric_limits<double>::quiet_NaN());
        return ParamValue::scalar(std::numeric_limits<double>::infinity());
    }

    /** Redução no estilo MATLAB: vetor -> escalar; matriz -> uma linha com a redução de cada coluna. */
    static ParamValue reduce(const ParamValue& value, const std::function<double(const std::vector<double>&)>& fn,
                             std::optional<double> emptyValue = std::nullopt) {
        if (value.empty()) {
            if (emptyValue) return ParamValue::scalar(*emptyValue);
            return ParamValue{};
        }
        if (value.isVector()) return ParamValue::scalar(fn(value.data));
        std::vector<double> out;
        for (size_t c = 0; c < value.cols; ++c) {
            std::vector<double> column;
            for (size_t r = 0; r < value.rows; ++r) column.push_back(value.data[r * value.cols + c]);
            out.push_back(fn(column));
        }
        return ParamValue::row(std::move(out));
    }

    std::vector<Token> m_tokens;
    size_t m_position = 0;
    const ParamWorkspace* m_workspace;
    std::vector<char> m_context;
    double m_endValue = std::numeric_limits<double>::quiet_NaN();
    std::vector<size_t> m_endDims;
};

} // namespace

ParamValue evaluateParam(std::string_view text, const ParamWorkspace* workspace) {
    return Parser(text, workspace).parse();
}

double evaluateScalarParam(std::string_view name, std::string_view text, const ParamWorkspace* workspace) {
    try {
        const ParamValue value = evaluateParam(text, workspace);
        if (!value.isScalar()) throw std::invalid_argument("precisa ser escalar");
        return value.data.front();
    } catch (const std::exception& error) {
        throw std::invalid_argument(std::string(name) + ": " + error.what());
    }
}

std::vector<double> evaluateVectorParam(std::string_view name, std::string_view text, const ParamWorkspace* workspace) {
    try {
        const ParamValue value = evaluateParam(text, workspace);
        if (!value.isVector()) throw std::invalid_argument("precisa ser vetor");
        return value.data;
    } catch (const std::exception& error) {
        throw std::invalid_argument(std::string(name) + ": " + error.what());
    }
}

std::string formatParam(const ParamValue& value) {
    const auto number = [](double x) {
        if (std::isnan(x)) return std::string("NaN");
        if (std::isinf(x)) return std::string(x > 0 ? "Inf" : "-Inf");
        char buffer[64];
        std::snprintf(buffer, sizeof(buffer), "%.15g", x);
        return std::string(buffer);
    };
    if (value.isScalar()) return number(value.data[0]);
    std::string out = "[";
    for (size_t r = 0; r < value.rows; ++r) {
        if (r > 0) out += "; ";
        for (size_t c = 0; c < value.cols; ++c) {
            if (c > 0) out += ' ';
            out += number(value.data[r * value.cols + c]);
        }
    }
    return out + "]";
}

} // namespace lasecsimul::simulation::library
