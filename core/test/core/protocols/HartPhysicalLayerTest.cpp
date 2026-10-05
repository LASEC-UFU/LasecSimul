// HART physical layer (Bell 202 FSK) -- transmitter, receiver and frame
// assembler on their own, driven by synthetic sampled waveforms.
#include "protocols/HartPhysicalLayer.hpp"

#include <cmath>
#include <cstdio>
#include <random>
#include <string>
#include <vector>

using namespace lasecsimul::protocols;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& label) {
    ++checks;
    if (ok) return;
    ++failures;
    std::fprintf(stderr, "FAIL: %s\n", label.c_str());
}

struct Link {
    double amplitudeVpp = 0.5;
    double dc = 3.0;
    uint64_t sampleNs = hart_phy::kSampleNs;
    bool jitter = false;
};

/** Sends `bytes` through a transmitter and samples the line into a receiver
 * until the carrier is off; returns the decoded bytes. */
std::vector<uint8_t> transfer(const std::vector<uint8_t>& bytes, const Link& link, HartFskReceiver& rx,
                              uint64_t startNs = 1'000'000, double* maxStep = nullptr) {
    HartFskTransmitter tx;
    std::mt19937 random(7);
    std::uniform_int_distribution<uint64_t> jitter(link.sampleNs / 2, link.sampleNs * 3 / 2);
    uint64_t t = startNs;
    // Quiet line before the carrier.
    rx.sample(t - 500'000, link.dc);
    rx.sample(t - 250'000, link.dc);
    tx.send(bytes, t);
    double previous = link.dc;
    while (tx.active()) {
        tx.advance(t);
        if (!tx.active()) break;
        const double volts = link.dc + 0.5 * link.amplitudeVpp * tx.value(t);
        if (maxStep) *maxStep = std::max(*maxStep, std::fabs(volts - previous));
        previous = volts;
        rx.sample(t, volts);
        rx.sample(t, volts); // a settle may re-read the same instant
        t += link.jitter ? jitter(random) : link.sampleNs;
    }
    rx.sample(t, link.dc);
    rx.sample(t + link.sampleNs, link.dc);
    return rx.takeBytes();
}

std::vector<uint8_t> hex(const char* text) {
    std::vector<uint8_t> out;
    for (const char* p = text; *p;) {
        while (*p == ' ') ++p;
        if (!*p) break;
        out.push_back(static_cast<uint8_t>(std::stoul(std::string(p, 2), nullptr, 16)));
        p += 2;
    }
    return out;
}

} // namespace

int main() {
    std::vector<uint8_t> payload;
    for (int i = 0; i < 256; ++i) payload.push_back(static_cast<uint8_t>(i));
    std::mt19937 random(42);
    for (int i = 0; i < 256; ++i) payload.push_back(static_cast<uint8_t>(random()));

    {
        HartFskReceiver rx;
        double maxStep = 0.0;
        const auto got = transfer(payload, Link{}, rx, 1'000'000, &maxStep);
        check(got == payload, "P1 512 characters (all byte values + random) decode exactly at 20 us sampling");
        check(rx.parityErrors() == 0 && rx.framingErrors() == 0, "P2 no parity/framing errors");
        // 0.25 V amplitude, 2200 Hz, 20 us: max slope step 0.25*2*pi*2200*20e-6 = 0.069 V.
        check(maxStep < 0.075, "P3 phase-continuous carrier: no jump between samples (max " + std::to_string(maxStep) + " V)");
    }
    {
        HartFskReceiver rx;
        Link link;
        link.jitter = true;
        check(transfer(payload, link, rx) == payload, "P4 irregular sampling (10..30 us) still decodes exactly");
    }
    {
        HartFskReceiver rx;
        Link link;
        link.sampleNs = 10'000;
        link.dc = 0.0;
        check(transfer(payload, link, rx) == payload, "P5 10 us sampling, no DC offset");
    }
    for (const uint64_t period : {40'000ull, 50'000ull}) {
        HartFskReceiver rx;
        Link link;
        link.sampleNs = period;
        link.jitter = true;
        check(transfer(payload, link, rx) == payload,
              "P5b coarser sampling (" + std::to_string(period / 1000) + " us, jittered) still decodes exactly");
    }
    {
        HartFskReceiver rx;
        Link link;
        link.amplitudeVpp = 0.130;
        check(transfer(payload, link, rx) == payload, "P6 a 130 mV p-p carrier is received (HART: >= 120 mV)");
    }
    {
        HartFskReceiver rx;
        Link link;
        link.amplitudeVpp = 0.060;
        const auto got = transfer(payload, link, rx);
        check(got.empty() && !rx.carrierAt(0), "P7 a 60 mV p-p carrier is ignored (HART: <= 80 mV rejected)");
    }
    {
        // Slave current signal on a 250 ohm load: ±0.5 mA -> 250 mV p-p.
        HartFskReceiver rx;
        Link link;
        link.amplitudeVpp = 2.0 * hart_phy::kSlaveCurrentAmplitudeA * 250.0;
        link.dc = 0.012 * 250.0;
        check(transfer(payload, link, rx) == payload, "P8 slave signal across 250 ohm (250 mV p-p on 3 V) decodes");
        HartFskReceiver small;
        link.amplitudeVpp = 2.0 * hart_phy::kSlaveCurrentAmplitudeA * 50.0;
        check(transfer(payload, link, small).empty(), "P9 the same signal across only 50 ohm (50 mV p-p) is lost");
    }
    {
        HartFskTransmitter tx;
        const std::vector<uint8_t> one{0xFF};
        tx.send(one, 0);
        uint64_t t = 0;
        while (tx.active() && t < 100'000'000) { t += 1000; tx.advance(t); }
        const uint64_t expected = tx.leadInNs + hart_phy::kCharNs + tx.idleHoldNs;
        check(!tx.active() && tx.value(t) == 0.0 && t >= expected && t <= expected + 2 * hart_phy::kBitNs,
              "P10 carrier on for lead-in + 11 bits + idle hold, then off (" + std::to_string(t) + " ns)");
    }
    {
        // Two transfers on the same receiver with silence in between.
        HartFskReceiver rx;
        const std::vector<uint8_t> a = hex("FF FF FF FF FF 82 BE 01 05 F0 4D 00 00 85");
        const std::vector<uint8_t> b = hex("FF FF FF FF FF 86 BE 01 05 F0 4D 00 0E 00 44 FE 3E 01 05 05 05 72 20 06 05 F0 4D E3");
        const auto first = transfer(a, Link{}, rx, 1'000'000);
        const auto second = transfer(b, Link{}, rx, 400'000'000);
        check(first == a && second == b, "P11 consecutive frames separated by silence");
    }
    {
        HartFskReceiver rx;
        rx.setMuted(true);
        check(transfer(payload, Link{}, rx).empty(), "P12 a muted (transmitting) receiver hears nothing");
    }
    {
        HartFrameAssembler assembler;
        const auto request = hex("FF FF FF FF FF 82 BE 01 05 F0 4D 00 00 85");
        const auto response = hex("FF FF FF FF FF 86 BE 01 05 F0 4D 00 0E 00 44 FE 3E 01 05 05 05 72 20 06 05 F0 4D E3");
        std::vector<uint8_t> stream = hex("00 FF 12");
        stream.insert(stream.end(), request.begin(), request.end());
        stream.insert(stream.end(), response.begin(), response.end());
        std::vector<std::vector<uint8_t>> frames;
        for (size_t i = 0; i < stream.size(); i += 3) {
            const auto part = assembler.push(std::span<const uint8_t>(stream).subspan(i, std::min<size_t>(3, stream.size() - i)));
            frames.insert(frames.end(), part.begin(), part.end());
        }
        check(frames.size() == 2 && frames[0] == request && frames[1] == response,
              "P13 frame assembler cuts request and response out of a fragmented stream with noise");
        const auto shortFrame = hex("FF FF 02 80 00 00 82");
        check(assembler.push(shortFrame).size() == 1, "P14 short-frame (polling address) Command 0 with 2 preambles");
        check(assembler.push(hex("FF 02 80 00 00 82")).empty(), "P15 a single preamble is not a frame start");
    }

    std::printf("HART physical layer: %d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
