#pragma once

#include <cstdint>

namespace lasecsimul::simulation::library {

/** Modos de reset externo (Integrator, Discrete-Time Integrator, PID, Delay...), com a semântica
 * documentada: rising = de negativo/zero para positivo, ou de negativo para zero; falling = de
 * positivo para zero/negativo, ou de zero para negativo; either = qualquer um dos dois; level =
 * sinal não nulo agora, ou que passou de não nulo para zero; level hold = sinal não nulo agora. */
enum class ResetMode : int64_t { None = 0, Rising = 1, Falling = 2, Either = 3, Level = 4, LevelHold = 5 };

inline bool risingEdge(double previous, double current) {
    return (previous <= 0.0 && current > 0.0) || (previous < 0.0 && current == 0.0);
}
inline bool fallingEdge(double previous, double current) {
    return (previous >= 0.0 && current < 0.0) || (previous > 0.0 && current == 0.0);
}

inline bool resetTriggered(ResetMode mode, double previous, double current) {
    switch (mode) {
    case ResetMode::Rising: return risingEdge(previous, current);
    case ResetMode::Falling: return fallingEdge(previous, current);
    case ResetMode::Either: return risingEdge(previous, current) || fallingEdge(previous, current);
    case ResetMode::Level: return current != 0.0 || (previous != 0.0 && current == 0.0);
    case ResetMode::LevelHold: return current != 0.0;
    default: return false;
    }
}

} // namespace lasecsimul::simulation::library
