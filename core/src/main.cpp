#include "app/CoreApplication.hpp"
#include <cstdio>
#include <exception>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <timeapi.h>
#pragma comment(lib, "winmm.lib")
namespace {
/* Achado 2026-08-26 (benchmark I2C burst): sem isto, QUALQUER sleep_for()/wait_for() com timeout
 * curto neste processo (ex: McuComponent::runBackgroundPollLoop, pausa de 50us entre checagens da
 * arena) arredonda pra cima ate' a granularidade PADRAO do timer do Windows -- tipicamente ~15.6ms
 * (64Hz) numa maquina sem ninguem pedindo resolucao maior. Medido ao vivo: 85% dos intervalos entre
 * bursts I2C consecutivos caiam a menos de 800us de um MULTIPLO exato de 15625us, custando ~6.2s de
 * 8s de janela so' nessa espera -- nao no protocolo de burst em si (cada handler mede <50us) nem no
 * mutex do Scheduler (ja removido do caminho, ver NativeDeviceProxy::m_deviceMutex). timeBeginPeriod
 * pede resolucao de 1ms pro processo inteiro (== Sleep coarse timer resolution do Windows, mecanismo
 * padrao usado por qualquer software sensivel a latencia nesta plataforma -- nao afeta Linux/macOS,
 * onde clock_nanosleep ja' e' fino por padrao). RAII: garante timeEndPeriod mesmo se app.run()
 * lancar excecao. */
class HighResolutionTimerScope {
public:
    HighResolutionTimerScope() : m_active(timeBeginPeriod(1) == TIMERR_NOERROR) {}
    ~HighResolutionTimerScope() {
        if (m_active) timeEndPeriod(1);
    }
    HighResolutionTimerScope(const HighResolutionTimerScope&) = delete;
    HighResolutionTimerScope& operator=(const HighResolutionTimerScope&) = delete;

private:
    bool m_active;
};
} // namespace
#endif

int main(int argc, char** argv) {
#ifdef _WIN32
    const HighResolutionTimerScope highResolutionTimerScope;
#endif
    try {
        lasecsimul::app::CoreConfig cfg = lasecsimul::app::parseArgs(argc, argv);
        lasecsimul::app::CoreApplication app(std::move(cfg));
        return app.run();
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[Core] erro fatal: %s\n", e.what());
        return 1;
    } catch (...) {
        std::fprintf(stderr, "[Core] erro fatal desconhecido\n");
        return 1;
    }
}
