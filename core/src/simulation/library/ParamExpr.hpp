#pragma once

#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace lasecsimul::simulation::library {

/**
 * Valor de parâmetro de bloco: matriz real `rows x cols` em ordem de LINHA (escalar = 1x1, vetor
 * linha = 1xN, vazio = 0x0). É o tipo de todos os parâmetros numéricos da biblioteca de blocos
 * (`docs/66` §5): o texto do campo é uma expressão no subconjunto MATLAB abaixo, avaliada a frio
 * (compilação do plano), nunca no caminho quente.
 */
struct ParamValue {
    size_t rows = 0;
    size_t cols = 0;
    std::vector<double> data;

    static ParamValue scalar(double value) { return {1, 1, {value}}; }
    static ParamValue row(std::vector<double> values) {
        const size_t n = values.size();
        return {n == 0 ? size_t{0} : size_t{1}, n, std::move(values)};
    }
    static ParamValue matrix(size_t rows, size_t cols, std::vector<double> values) {
        if (values.size() != rows * cols) throw std::invalid_argument("dimensao inconsistente");
        return {rows, cols, std::move(values)};
    }

    size_t numel() const noexcept { return data.size(); }
    bool empty() const noexcept { return data.empty(); }
    bool isScalar() const noexcept { return data.size() == 1; }
    bool isVector() const noexcept { return rows == 1 || cols == 1 || data.empty(); }
    double at(size_t row, size_t col) const { return data.at(row * cols + col); }
    /** Escalar; recusa matriz com mais de um elemento. */
    double asScalar(std::string_view what) const;
    /** Elementos em ordem linear do MATLAB (por COLUNA) -- igual a `x(:)`. */
    std::vector<double> linear() const;
};

/**
 * Variáveis visíveis para a expressão (Model Workspace do projeto, parâmetros de máscara de
 * subsistema). Encadeável: um subsistema enxerga o próprio escopo e depois o de cima.
 */
class ParamWorkspace {
public:
    explicit ParamWorkspace(const ParamWorkspace* parent = nullptr) : m_parent(parent) {}
    void set(std::string name, ParamValue value) { m_values[std::move(name)] = std::move(value); }
    const ParamValue* find(std::string_view name) const;
    bool empty() const noexcept { return m_values.empty() && (!m_parent || m_parent->empty()); }

private:
    const ParamWorkspace* m_parent = nullptr;
    std::unordered_map<std::string, ParamValue> m_values;
};

/** Erro de avaliação com posição (1-based) no texto, para o inspetor apontar o problema. */
class ParamError : public std::invalid_argument {
public:
    ParamError(const std::string& message, size_t column)
        : std::invalid_argument(message + " (coluna " + std::to_string(column) + ")"), m_column(column) {}
    size_t column() const noexcept { return m_column; }

private:
    size_t m_column;
};

/**
 * Avalia `text`. Gramática (subconjunto MATLAB): números (`1`, `.5`, `2e-3`, `Inf`, `NaN`), `pi`,
 * `eps`, `true`/`false`; operadores `|| && | & == ~= < <= > >= : + - * / .* ./ ^ .^ ' .'` e unários
 * `- + ~`; matrizes `[a b; c d]` (espaço ou vírgula separa colunas, `;` ou quebra de linha separa
 * linhas, com a regra de espaço do MATLAB para `[1 -2]`); indexação `v(i)`, `m(i,j)`, `end`; funções
 * elementares e de construção (ver `ParamExpr.cpp`). Variável desconhecida é erro explícito -- não
 * existe workspace do MATLAB aqui.
 */
ParamValue evaluateParam(std::string_view text, const ParamWorkspace* workspace = nullptr);

/** Atalhos com mensagem padronizada citando o parâmetro. */
double evaluateScalarParam(std::string_view name, std::string_view text, const ParamWorkspace* workspace = nullptr);
std::vector<double> evaluateVectorParam(std::string_view name, std::string_view text, const ParamWorkspace* workspace = nullptr);

/** Formata com 15 dígitos significativos no estilo do MATLAB (`[1 2 3]`, `[1 2; 3 4]`). */
std::string formatParam(const ParamValue& value);

} // namespace lasecsimul::simulation::library
