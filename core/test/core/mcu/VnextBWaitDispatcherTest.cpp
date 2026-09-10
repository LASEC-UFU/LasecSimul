// E147-E (EVIDENCE.md, 2026-09-10): VnextBWaitDispatcher::Impl::run() computes the attachment
// index as `result - WAIT_OBJECT_0 - 1` (correctly excluding the internal `wake` handle at
// `handles[0]`) but then used that SAME index directly into `handles[]` for the ResetEvent()
// call -- `handles[0]` is `wake`, so the first attachment (whose correct handle is
// `handles[1]`) had `handles[0]` (the dispatcher's own internal wake event) reset instead of its
// own event. The real attachment handle was left signaled, so the next WaitForMultipleObjects()
// call returned immediately for it again, forever -- this is the root cause traced through
// E147-B/C/D's millions of ExternalMarkDirty wakeCallbacks against only hundreds of real
// publications, all while the shared manual-reset doorbell stayed observably signaled.
//
// No QEMU, no electrical circuit, no Scheduler dependency: pure enough to prove or disprove the
// off-by-one in complete isolation, using real Windows manual-reset Events exactly like the
// dispatcher's production callers (VnextBAttachment.cpp) do.
#include "mcu/qemu/VnextBWaitDispatcher.hpp"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <thread>
#include <condition_variable>

#ifdef _WIN32
#include <windows.h>
#endif

using namespace lasecsimul::mcu::qemu;

namespace {

int failures = 0;

#define TEST_ASSERT(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

#ifdef _WIN32

HANDLE makeManualResetEvent() { return CreateEventW(nullptr, TRUE, FALSE, nullptr); }

// RED-1: a single attachment. Before the fix, SetEvent() once produces an unbounded stream of
// callbacks (the dispatcher's own worker thread spins on WaitForMultipleObjects because the real
// handle it should have reset was never touched -- `handles[0]` (wake) was reset instead). Bound
// the observation window explicitly so a still-broken build fails fast instead of hanging CI.
void testSingleAttachmentDoesNotStormAfterOneSignal() {
    std::fprintf(stderr, "-- RED-1: um attachment, um SetEvent --\n");
    VnextBWaitDispatcher dispatcher;
    HANDLE attachmentEvent = makeManualResetEvent();
    std::atomic<int> callbackCount{0};
    const uint64_t token = dispatcher.registerArtifactEvent(
        attachmentEvent, [&] { callbackCount.fetch_add(1, std::memory_order_relaxed); });
    TEST_ASSERT(token != 0, "registro do attachment single deve suceder");

    SetEvent(attachmentEvent);

    // Bounded observation: give the worker ample real time to misbehave (if it's going to), but
    // never wait for more than a handful of callbacks -- a still-broken build would keep
    // incrementing forever otherwise.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    while (std::chrono::steady_clock::now() < deadline && callbackCount.load() < 10) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    const int observed = callbackCount.load();
    TEST_ASSERT(observed == 1, "exatamente uma callback apos um SetEvent (nao ilimitada)");
    const DWORD stillSignaled = WaitForSingleObject(attachmentEvent, 0);
    TEST_ASSERT(stillSignaled == WAIT_TIMEOUT,
                "o evento verdadeiro deve estar NAO sinalizado apos o reset correto");

    dispatcher.unregister(token);
    CloseHandle(attachmentEvent);
    std::fprintf(stderr, "   observed callbacks=%d\n", observed);
}

// RED-2: two attachments, signal only the second (B). Protects against a fix that only
// special-cases index 0, and exercises nextStartSlot rotation (registered in order A, B -- B is
// slot 1, its correct handles[] position is 2). Confirms specifically that A's handle is
// untouched and B's handle is the one actually reset.
void testTwoAttachmentsResetTheCorrectHandle() {
    std::fprintf(stderr, "-- RED-2: dois attachments, sinaliza somente B --\n");
    VnextBWaitDispatcher dispatcher;
    HANDLE eventA = makeManualResetEvent();
    HANDLE eventB = makeManualResetEvent();
    std::atomic<int> countA{0}, countB{0};
    const uint64_t tokenA = dispatcher.registerArtifactEvent(
        eventA, [&] { countA.fetch_add(1, std::memory_order_relaxed); });
    const uint64_t tokenB = dispatcher.registerArtifactEvent(
        eventB, [&] { countB.fetch_add(1, std::memory_order_relaxed); });
    TEST_ASSERT(tokenA != 0 && tokenB != 0, "registro de A e B deve suceder");

    SetEvent(eventB);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    while (std::chrono::steady_clock::now() < deadline && countB.load() < 10) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    TEST_ASSERT(countB.load() == 1, "B deve disparar exatamente uma vez");
    TEST_ASSERT(countA.load() == 0, "A nao deve disparar -- nunca foi sinalizado");
    const DWORD bStillSignaled = WaitForSingleObject(eventB, 0);
    TEST_ASSERT(bStillSignaled == WAIT_TIMEOUT, "B deve estar NAO sinalizado (reset correto)");
    const DWORD aState = WaitForSingleObject(eventA, 0);
    TEST_ASSERT(aState == WAIT_TIMEOUT, "A permanece nao sinalizado (nunca foi setado)");

    dispatcher.unregister(tokenA);
    dispatcher.unregister(tokenB);
    CloseHandle(eventA);
    CloseHandle(eventB);
    std::fprintf(stderr, "   countA=%d countB=%d\n", countA.load(), countB.load());
}

// Contract 2: without a new SetEvent(), the counter stays stable (no spurious re-fires at all,
// not just "eventually bounded").
void testStableWithoutNewSignal() {
    std::fprintf(stderr, "-- Contrato: sem novo SetEvent, contador estavel --\n");
    VnextBWaitDispatcher dispatcher;
    HANDLE ev = makeManualResetEvent();
    std::atomic<int> count{0};
    const uint64_t token =
        dispatcher.registerArtifactEvent(ev, [&] { count.fetch_add(1, std::memory_order_relaxed); });
    SetEvent(ev);
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const int afterFirst = count.load();
    TEST_ASSERT(afterFirst == 1, "uma callback apos o unico SetEvent");
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    TEST_ASSERT(count.load() == afterFirst, "contador nao cresce sem novo SetEvent");
    dispatcher.unregister(token);
    CloseHandle(ev);
}

// Contract 6: nextStartSlot rotation stays fair across repeated signals on different slots --
// registers three attachments, signals each in turn, confirms each fires independently without
// starving the others (a continuously-resignaled early slot must not prevent a later slot's
// callback from ever running).
void testRotationFairnessAcrossSlots() {
    std::fprintf(stderr, "-- Contrato: rotacao nextStartSlot nao morre de fome --\n");
    VnextBWaitDispatcher dispatcher;
    HANDLE events[3] = {makeManualResetEvent(), makeManualResetEvent(), makeManualResetEvent()};
    std::atomic<int> counts[3] = {};
    uint64_t tokens[3];
    for (int i = 0; i < 3; ++i) {
        tokens[i] = dispatcher.registerArtifactEvent(
            events[i], [&counts, i] { counts[i].fetch_add(1, std::memory_order_relaxed); });
    }
    for (int round = 0; round < 5; ++round) {
        for (int i = 0; i < 3; ++i) {
            SetEvent(events[i]);
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(300);
            while (std::chrono::steady_clock::now() < deadline &&
                   counts[i].load() <= round) {
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
        }
    }
    for (int i = 0; i < 3; ++i) {
        TEST_ASSERT(counts[i].load() == 5, "cada slot recebeu exatamente suas 5 callbacks");
    }
    for (int i = 0; i < 3; ++i) { dispatcher.unregister(tokens[i]); CloseHandle(events[i]); }
    std::fprintf(stderr, "   counts=%d,%d,%d\n", counts[0].load(), counts[1].load(), counts[2].load());
}

// Lost-wake test: signal A, let the dispatcher reset+enter the callback, hold the callback with a
// barrier, signal A AGAIN while the callback is still running, release the callback, and require
// EXACTLY one more callback afterward -- proving the "reset before invoking user code" comment is
// actually true and a concurrent publish during a callback is never dropped nor double-counted.
void testSecondSignalDuringCallbackIsNotLost() {
    std::fprintf(stderr, "-- Lost-wake: segundo SetEvent durante a callback em execucao --\n");
    VnextBWaitDispatcher dispatcher;
    HANDLE ev = makeManualResetEvent();
    std::atomic<int> count{0};
    std::mutex barrierMutex;
    std::condition_variable barrierCv;
    bool firstCallbackEntered = false;
    bool releaseFirstCallback = false;

    const uint64_t token = dispatcher.registerArtifactEvent(ev, [&] {
        const int n = count.fetch_add(1, std::memory_order_relaxed) + 1;
        if (n == 1) {
            std::unique_lock lock(barrierMutex);
            firstCallbackEntered = true;
            barrierCv.notify_all();
            barrierCv.wait(lock, [&] { return releaseFirstCallback; });
        }
    });

    SetEvent(ev);
    {
        std::unique_lock lock(barrierMutex);
        const bool entered = barrierCv.wait_for(lock, std::chrono::seconds(2),
                                                 [&] { return firstCallbackEntered; });
        TEST_ASSERT(entered, "primeira callback deve iniciar dentro do timeout");
    }
    // The dispatcher's contract (per VnextBWaitDispatcher.cpp's own comment) resets the handle
    // BEFORE invoking the callback -- so re-signaling now must be observed as a genuinely new
    // wake, not silently merged into the callback already running.
    SetEvent(ev);
    {
        std::lock_guard lock(barrierMutex);
        releaseFirstCallback = true;
    }
    barrierCv.notify_all();

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1000);
    while (std::chrono::steady_clock::now() < deadline && count.load() < 2) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    TEST_ASSERT(count.load() == 2, "exatamente uma segunda callback -- sinal concorrente nao perdido");
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    TEST_ASSERT(count.load() == 2, "contador estabiliza em 2, sem callbacks extras");

    dispatcher.unregister(token);
    CloseHandle(ev);
}

// Coalesced-signal test: two SetEvent() calls before the dispatcher ever resets the handle may
// legitimately collapse into a single callback (Windows manual-reset semantics -- this is
// EXPECTED, not a bug), but the production contract only tolerates that because the callback body
// always re-inspects/drains the shared arena state rather than assuming "one SetEvent = one
// logical event". This test proves at least one callback occurs and the handle ends up
// unsignaled -- it does NOT assert callback count == 2, matching the task's explicit instruction
// not to require strict callbacks==events equality.
void testTwoSignalsBeforeResetCoalesceButAreObservable() {
    std::fprintf(stderr, "-- Coalescencia: dois SetEvent antes do reset --\n");
    VnextBWaitDispatcher dispatcher;
    HANDLE ev = makeManualResetEvent();
    std::atomic<int> count{0};
    const uint64_t token =
        dispatcher.registerArtifactEvent(ev, [&] { count.fetch_add(1, std::memory_order_relaxed); });

    SetEvent(ev);
    SetEvent(ev); // manual-reset: this may or may not produce a distinct wake -- both are valid.

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    while (std::chrono::steady_clock::now() < deadline && count.load() < 1) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    TEST_ASSERT(count.load() >= 1, "pelo menos uma callback observa o(s) sinal(is) coalescido(s)");
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    const int stableCount = count.load();
    TEST_ASSERT(stableCount == 1 || stableCount == 2,
                "coalescencia produz 1 ou 2 callbacks, nunca zero nem crescimento ilimitado");
    const DWORD stillSignaled = WaitForSingleObject(ev, 0);
    TEST_ASSERT(stillSignaled == WAIT_TIMEOUT, "handle fica nao sinalizado apos o(s) reset(s)");

    dispatcher.unregister(token);
    CloseHandle(ev);
    std::fprintf(stderr, "   count=%d\n", stableCount);
}

// unregister()/teardown: no callback after unregister() returns, and the dispatcher's destructor
// (teardown) does not hang -- covered implicitly by every test above completing at all (a hang
// here would time out the whole binary), but assert explicitly that a signal set AFTER
// unregister() never reaches a callback (the entry is gone, the callback capture must not run).
void testNoCallbackAfterUnregisterReturns() {
    std::fprintf(stderr, "-- unregister(): nenhuma callback depois de retornar --\n");
    VnextBWaitDispatcher dispatcher;
    HANDLE ev = makeManualResetEvent();
    std::atomic<int> count{0};
    const uint64_t token =
        dispatcher.registerArtifactEvent(ev, [&] { count.fetch_add(1, std::memory_order_relaxed); });
    dispatcher.unregister(token);
    SetEvent(ev); // no longer registered -- must be a no-op from the dispatcher's perspective.
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    TEST_ASSERT(count.load() == 0, "nenhuma callback apos unregister(), mesmo sinalizando depois");
    CloseHandle(ev);
}

#endif // _WIN32

} // namespace

int main() {
#ifdef _WIN32
    testSingleAttachmentDoesNotStormAfterOneSignal();
    testTwoAttachmentsResetTheCorrectHandle();
    testStableWithoutNewSignal();
    testRotationFairnessAcrossSlots();
    testSecondSignalDuringCallbackIsNotLost();
    testTwoSignalsBeforeResetCoalesceButAreObservable();
    testNoCallbackAfterUnregisterReturns();
#else
    std::fprintf(stderr, "VnextBWaitDispatcher e Windows-only; nada a testar nesta plataforma.\n");
#endif
    if (failures) {
        std::fprintf(stderr, "%d teste(s) FALHARAM.\n", failures);
        return 1;
    }
    std::fprintf(stderr, "Todos os testes passaram.\n");
    return 0;
}
