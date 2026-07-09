#pragma once

// SHA-256 autocontido (sem dependência externa) -- usado por
// `plugins::PluginLoader::verifyChecksum` (achado de auditoria arquitetural 2026-07-09, D-verifyChecksum:
// o Core recalcula o hash do binário e confere contra `library.json`, defesa em profundidade
// independente da decisão de confiança que a Extension já tomou antes de pedir o load via IPC --
// ver .spec/lasecsimul-native-devices.spec, seção 12). Implementação baseada no algoritmo público
// FIPS 180-4, sem otimização SIMD (arquivo de plugin é tipicamente < 10MB, custo de hash é
// desprezível perto do próprio LoadLibrary/dlopen).

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace lasecsimul {

class Sha256 {
public:
    Sha256() { reset(); }

    void reset() {
        m_state = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                   0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
        m_bitLength = 0;
        m_bufferLength = 0;
    }

    void update(const uint8_t* data, size_t length) {
        m_bitLength += static_cast<uint64_t>(length) * 8;
        while (length > 0) {
            const size_t take = std::min(length, size_t{64} - m_bufferLength);
            std::memcpy(m_buffer.data() + m_bufferLength, data, take);
            m_bufferLength += take;
            data += take;
            length -= take;
            if (m_bufferLength == 64) {
                transform(m_buffer.data());
                m_bufferLength = 0;
            }
        }
    }

    /** Devolve o hash em hexadecimal minúsculo (64 caracteres) -- não reutilizável depois (mesmo
     * contrato de qualquer digest one-shot; chame reset() se precisar de outro hash). */
    std::string finalizeHex() {
        const uint64_t bitLengthSnapshot = m_bitLength;
        uint8_t padByte = 0x80;
        update(&padByte, 1);
        padByte = 0x00;
        while (m_bufferLength != 56) update(&padByte, 1);

        std::array<uint8_t, 8> lengthBytes{};
        for (int i = 0; i < 8; ++i) lengthBytes[7 - i] = static_cast<uint8_t>(bitLengthSnapshot >> (i * 8));
        update(lengthBytes.data(), 8);

        std::ostringstream out;
        for (uint32_t word : m_state) {
            char buf[9];
            std::snprintf(buf, sizeof(buf), "%08x", word);
            out << buf;
        }
        return out.str();
    }

    /** Hash de um arquivo inteiro, lido em blocos (nunca carrega tudo na memória de uma vez) --
     * devolve `std::nullopt`-like vazio (`""`) se o arquivo não puder ser aberto, nunca lança. */
    static std::string hashFile(const std::filesystem::path& path) {
        std::ifstream file(path, std::ios::binary);
        if (!file) return {};
        Sha256 hasher;
        std::vector<uint8_t> chunk(1 << 16);
        while (file) {
            file.read(reinterpret_cast<char*>(chunk.data()), static_cast<std::streamsize>(chunk.size()));
            const std::streamsize got = file.gcount();
            if (got > 0) hasher.update(chunk.data(), static_cast<size_t>(got));
        }
        return hasher.finalizeHex();
    }

private:
    static uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

    void transform(const uint8_t* block) {
        static constexpr std::array<uint32_t, 64> kRoundConstants = {
            0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
            0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
            0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
            0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
            0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
            0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
            0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
            0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

        std::array<uint32_t, 64> w{};
        for (int i = 0; i < 16; ++i) {
            w[i] = (static_cast<uint32_t>(block[i * 4]) << 24) | (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(block[i * 4 + 2]) << 8) | static_cast<uint32_t>(block[i * 4 + 3]);
        }
        for (int i = 16; i < 64; ++i) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }

        uint32_t a = m_state[0], b = m_state[1], c = m_state[2], d = m_state[3];
        uint32_t e = m_state[4], f = m_state[5], g = m_state[6], h = m_state[7];

        for (int i = 0; i < 64; ++i) {
            const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const uint32_t ch = (e & f) ^ (~e & g);
            const uint32_t temp1 = h + s1 + ch + kRoundConstants[i] + w[i];
            const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t temp2 = s0 + maj;
            h = g; g = f; f = e; e = d + temp1;
            d = c; c = b; b = a; a = temp1 + temp2;
        }

        m_state[0] += a; m_state[1] += b; m_state[2] += c; m_state[3] += d;
        m_state[4] += e; m_state[5] += f; m_state[6] += g; m_state[7] += h;
    }

    std::array<uint32_t, 8> m_state{};
    std::array<uint8_t, 64> m_buffer{};
    size_t m_bufferLength = 0;
    uint64_t m_bitLength = 0;
};

} // namespace lasecsimul
