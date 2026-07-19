#pragma once

#include <cstdio>
#include <functional>
#include <string>
#include <utility>

#if defined(_WIN32)
// NOMINMAX: sem isto, windows.h define macros `max`/`min` que quebram TODA chamada `std::max`/
// `std::min` em qualquer tradução unit que inclua este header (transitivamente, via
// QemuModuleProxy.hpp -- ex: SimulationSession.cpp usa std::max extensivamente). Antes deste
// header incluir <windows.h> diretamente, `CrashGuard.cpp` já incluía sem NOMINMAX, mas isolado
// (nada ali chama std::max/min); mover a inclusão pro .hpp (pra viabilizar o template abaixo)
// tornou a poluição de macro visível em qualquer lugar que inclua este header.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace lasecsimul::plugins {

/**
 * Contencao de falha best-effort para chamadas a plugins nativos sem sandbox.
 * No Windows, SEH captura falhas de acesso a memoria de forma segura para continuar.
 * Em POSIX, nao existe equivalente seguro (ver .spec/lasecsimul-native-devices.spec, secao 12,
 * item 4) — uma falha ali deve ser tratada na camada de processo (reinicio do Core), nao aqui.
 */
class CrashGuard {
public:
    /** Retorna false se a chamada falhou e foi contida; true se completou normalmente.
     * Overload NÃO-template histórico (implementado em CrashGuard.cpp) -- mantido só pra quem já
     * tem um `std::function<void()>` construído em mãos; todo call site que passa uma lambda
     * direto (o caso comum, ex: QemuModuleProxy/NativeDeviceProxy) prefere o template abaixo via
     * resolução de sobrecarga (correspondência exata > conversão definida pelo usuário pra
     * `std::function`), então não precisou mudar nenhum call site pra ganhar a otimização. */
    static bool call(const std::string& typeId, const std::function<void()>& fn);

    /** Bug real de desempenho encontrado 2026-07-19 perfilando um circuito com MCU ativo:
     * `QemuModuleProxy` chama isto uma ou duas vezes por pino a CADA `stamp()` (centenas de
     * milhares de vezes por segundo numa simulação MCU-driven) -- construir um `std::function<void()>`
     * a cada chamada, mesmo sem alocar no heap (o buffer pequeno do MSVC cabe uma lambda com
     * poucas capturas por referência), ainda tem custo real de apagamento de tipo (vtable de
     * type-erasure, cópia pro buffer, destrutor via ponteiro de função) que a suíte não conseguia
     * enxergar por não perfilar contra QEMU real. Medido: ~3,7µs por chamada, dominando 95% do
     * custo de `stamp()` do MCU. Um template permite inline completo através da fronteira, zero
     * apagamento de tipo -- mesma proteção SEH, só sem a indireção. */
    template <class Fn>
    static bool call(const std::string& typeId, Fn&& fn) {
#if defined(_WIN32)
        __try {
            std::forward<Fn>(fn)();
            return true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            std::fprintf(stderr, "[CrashGuard] plugin '%s' raised SEH 0x%08lX — marcando faulted\n",
                         typeId.c_str(), static_cast<unsigned long>(GetExceptionCode()));
            return false;
        }
#else
        std::forward<Fn>(fn)();
        return true;
#endif
    }
};

} // namespace lasecsimul::plugins
