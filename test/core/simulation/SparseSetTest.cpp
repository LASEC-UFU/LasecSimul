#include "simulation/SparseSet.hpp"
#include <cstdint>
#include <cstdio>
#include <vector>
// assert() é a verificação deste teste. Em Release o CMake define NDEBUG e cada assert() viraria
// no-op: o baseline noturno (Release) aprovava o teste sem checar nada. <assert.h> redefine
// assert() conforme NDEBUG a cada inclusão; por isso vem depois dos outros includes.
#undef NDEBUG
#include <assert.h>

using lasecsimul::simulation::SparseSet;

int main() {
    SparseSet<uint32_t> set(2);

    assert(set.empty());
    assert(set.capacity() == 2);

    assert(set.insert(1));
    assert(!set.insert(1));
    assert(set.size() == 1);
    assert(set.contains(1));

    assert(set.insert(4));
    assert(set.capacity() >= 5);
    assert(set.contains(4));

    const std::vector<uint32_t> dense(set.dense().begin(), set.dense().end());
    assert(dense.size() == 2);
    assert(dense[0] == 1);
    assert(dense[1] == 4);

    assert(set.remove(1));
    assert(!set.remove(1));
    assert(!set.contains(1));
    assert(set.contains(4));
    assert(set.size() == 1);

    set.clear();
    assert(set.empty());
    assert(!set.contains(4));

    std::printf("OK: SparseSet insert/remove/grow/clear/dense.\n");
    return 0;
}
