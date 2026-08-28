#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <charconv>
#include <string_view>

static bool readU64(const char* name, uint64_t& out) {
    const char* v = std::getenv(name);
    if (!v || !*v) return false;
    const char* end = v + std::char_traits<char>::length(v);
    auto r = std::from_chars(v, end, out, 10);
    return r.ec == std::errc{} && r.ptr == end;
}

int main() {
    uint64_t session = 0, runtime = 0, generation = 0;
    if (!readU64("LASECSIMUL_SESSION_EXECUTION_ID", session) ||
        !readU64("LASECSIMUL_RUNTIME_INSTANCE_ID", runtime) ||
        !readU64("LASECSIMUL_LAUNCH_GENERATION", generation)) return 2;
    const char* preserved = std::getenv("LASECSIMUL_ENV_PRESERVATION_TEST");
    std::printf("%llu,%llu,%llu,%s\n", static_cast<unsigned long long>(session),
                static_cast<unsigned long long>(runtime), static_cast<unsigned long long>(generation),
                preserved ? preserved : "");
    return 0;
}
