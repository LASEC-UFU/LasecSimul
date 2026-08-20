#pragma once

/** Gera o texto C++ do driver do worker (código PRÓPRIO do LasecSimul, não vendorizado) que
 * conecta um `PROGRAM` compilado pela STruCpp ao `PlcScanSession` -- versão automatizada/
 * parametrizada de `PlcWorkerDriverHello.cpp` (escrito à mão em F9.2 pra provar o mecanismo; esta
 * função generaliza a MESMA forma pra qualquer `PROGRAM` com interface conhecida). Não gera nada
 * de dentro da STruCpp -- só código que `#include` o `.hpp` gerado por ela e usa os tipos que ela
 * já expõe (`strucpp::Program_<NOME>`, `strucpp::ProgramBase`). */

#include <string>

#include "PlcInterfaceParser.hpp"

namespace lasecsimul::plc {

/** `generatedHeaderName`: nome do `.hpp` que a STruCpp gerou (ex.: "hello.hpp"), incluído via
 * `#include "<generatedHeaderName>"` no driver -- quem monta o diretório de compilação garante que
 * esse arquivo exista lá. Lança `std::runtime_error` se alguma variável de `interface.variables`
 * tiver um `iecType` sem mapeamento conhecido pra `VarTypeTag` (melhor falhar aqui, cedo e claro,
 * do que gerar C++ com um tipo errado). */
std::string generatePlcWorkerDriverSource(const PlcParsedInterface& interface, const std::string& generatedHeaderName);

} // namespace lasecsimul::plc
