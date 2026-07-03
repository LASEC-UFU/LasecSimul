#include "app/CoreApplication.hpp"
#include <cstdio>
#include <exception>

int main(int argc, char** argv) {
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
