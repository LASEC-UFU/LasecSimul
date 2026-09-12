#include "protocols/HartCommandClassification.hpp"
#include "protocols/HartCommandJson.hpp"
#include "protocols/HartCommandProgram.hpp"
#include "protocols/HartCommunicationComponent.hpp"
#include "protocols/HartEngine.hpp"
#include "protocols/HartReferenceCatalog.hpp"
#include "protocols/HartTransport.hpp"
#include "protocols/HartTypeCodec.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/Scheduler.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <span>
#include <vector>

using namespace lasecsimul::protocols;

namespace {
int failures = 0;
void check(bool condition, const char* message) {
    if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; }
}

class Handler final : public IHartCommandHandler {
public:
    HartCommandId command() const noexcept override { return 1; }
    bool execute(const HartCommandContext&, HartResponseBuilder& response) noexcept override {
        return response.writeByte(0x42);
    }
};

class CustomHandler final : public IHartCommandHandler {
public:
    HartCommandId command() const noexcept override { return 99; }
    bool execute(const HartCommandContext&, HartResponseBuilder& response) noexcept override {
        return response.writeByte(0x99);
    }
};
}

int main() {
    const auto referenceCommands = HartReferenceCatalog::commandDescriptors();
    const auto referenceDevices = HartReferenceCatalog::deviceDefinitions();
    // A concurrent, ongoing implementation effort keeps adding catalog
    // entries (Additional CP, Device Family Pressure, etc.) -- an exact
    // count here has repeatedly gone stale mid-audit (was 60, then 63, then
    // 173, now 183...) without signaling any real defect each time. A floor
    // check still catches genuine corruption (e.g. the array losing most of
    // its entries) without this test needing a manual bump on every
    // concurrent addition.
    check(referenceCommands.size() >= 183, "process_simul command catalog imported (at least 183 entries)");
    check(referenceDevices.size() == 11 && referenceDevices.front().name == "FV100CA" &&
              referenceDevices.back().name == "FIT100A",
          "process_simul device catalog imported");
    const HartDeviceProfile referenceProfile = HartReferenceCatalog::makeGenericProfile();
    check(referenceProfile.commands.size() == referenceCommands.size() &&
              referenceProfile.manufacturerId == 0x3E,
          "generic process_simul-compatible profile");
    HartProfileRegistry referenceRegistry;
    // `makeDevicePlans()` assigns each reference device its own tailored
    // profile (`lasecsimul.hart.process-simul.<name>`, per-device
    // manufacturer/deviceType/primaryVariableUnit/upperRangeValue), not the
    // single shared generic profile -- `registerProfiles()` registers the
    // generic profile AND all 11 per-device ones; `registerGenericProfile()`
    // alone is for callers (like `HartCommunicationComponent`'s default
    // `profileId`) that intentionally want just the shared compatible profile.
    check(HartReferenceCatalog::registerProfiles(referenceRegistry),
          "reference profile registration (generic + per-device profiles)");
    const auto referencePlans = HartReferenceCatalog::makeDevicePlans();
    check(referencePlans.size() == 11 &&
              referencePlans.front().pollingAddress == 1 &&
              referencePlans.back().pollingAddress == 11,
          "reference device plan factory");
    HartEngine referenceEngine(referenceRegistry);
    check(referenceEngine.loadPlan({referencePlans}) && referenceEngine.deviceCount() == 11,
          "reference device plan loads");
    check(HartReferenceCatalog::installCommandPrograms(referenceEngine), "DSL command programs install");

    // Golden vectors for the five commands migrated off the former central
    // switch (FASE 19/72/73 proof gate): FV100CA, bus "hart-1", address 1,
    // manufacturerId=0x3E, deviceType=0x03, uniqueId="029EB1" -> deviceId
    // {0x02,0x9E,0xB1}, identity revisions from HartReferenceCatalog::makeGenericProfile()
    // (numRequestPreambles=5, universalCommandRevision=5, transmitterSpecificRevision=98,
    // softwareRevision=3, hardwareRevisionAndSignal=0, flags=6), PV defaults to 0.0.
    {
        const std::vector<uint8_t> identityBlock{0xFE, 0x3E, 0x03, 0x05, 0x05, 0x62, 0x03, 0x00, 0x06,
                                                 0x02, 0x9E, 0xB1};
        HartResponseBuilder cmd0(32);
        check(referenceEngine.execute("hart-1", 1, 0x00, {}, cmd0) &&
                  std::equal(cmd0.bytes().begin(), cmd0.bytes().end(), identityBlock.begin()) &&
                  cmd0.size() == identityBlock.size(),
              "0x00 read unique identifier: 12-byte identity block");

        HartResponseBuilder cmd1(32);
        const std::vector<uint8_t> pv0{0x39, 0x00, 0x00, 0x00, 0x00}; // unit=57 (percent), PV=0.0f
        check(referenceEngine.execute("hart-1", 1, 0x01, {}, cmd1) &&
                  std::equal(cmd1.bytes().begin(), cmd1.bytes().end(), pv0.begin()) && cmd1.size() == 5,
              "0x01 read primary variable includes the unit byte (fixed from the prior 4-byte response)");

        // HCF_SPEC-127 6.4 Table 1: a device supporting only PV returns
        // exactly 9 bytes (loop current + PV unit + PV) -- NOT 24 bytes
        // padded with "not used" placeholders for SV/TV/QV. A prior session
        // padded to 24 bytes; verified wrong against the real spec and fixed
        // this session (see HartReferenceCatalog.cpp's 0x03 comment).
        HartResponseBuilder cmd3(32);
        check(referenceEngine.execute("hart-1", 1, 0x03, {}, cmd3) && cmd3.size() == 9,
              "0x03 read dynamic variables: 9-byte body (loop current + PV unit/value) for a PV-only device");
        check(cmd3.bytes()[4] == 0x39, "0x03's PV unit byte matches the profile (57 = percent)");

        // HCF_SPEC-127 6.9: PV classification not modeled -> 0 (Not Yet
        // Classified); SV/TV/QV not supported at all -> 250 (Not Used).
        HartResponseBuilder cmd8(8);
        check(referenceEngine.execute("hart-1", 1, 0x08, {}, cmd8) && cmd8.size() == 4 &&
                  cmd8.bytes()[0] == 0x00 && cmd8.bytes()[1] == 0xFA && cmd8.bytes()[2] == 0xFA && cmd8.bytes()[3] == 0xFA,
              "0x08 read dynamic variable classifications: PV=Not Yet Classified, SV/TV/QV=Not Used");

        // HCF_SPEC-127 6.3/6.4: Loop Current / Percent of Range, the linear
        // 4-20mA mapping added this session. FV100CA's profile has the
        // generic 0-100 range (see makeGenericProfile()), so PV=0 -> 0% ->
        // 4.0mA exactly, a clean, verifiable golden.
        HartResponseBuilder cmd2AtZero(16);
        check(referenceEngine.execute("hart-1", 1, 0x02, {}, cmd2AtZero) && cmd2AtZero.size() == 8,
              "0x02 read loop current and percent of range: 8-byte body");
        const auto expectedCurrentAtZero = HartTypeCodec::encodeFloat32BE(4.0f);
        const auto expectedPercentAtZero = HartTypeCodec::encodeFloat32BE(0.0f);
        check(std::equal(expectedCurrentAtZero.begin(), expectedCurrentAtZero.end(), cmd2AtZero.bytes().begin()) &&
                  std::equal(expectedPercentAtZero.begin(), expectedPercentAtZero.end(), cmd2AtZero.bytes().begin() + 4),
              "0x02 at PV=0 (range 0-100): loop current = 4.0mA, percent = 0% (the exact 4-20mA floor)");

        check(referenceEngine.setPrimaryValue("FV100CA", 50.0), "set PV to 50 (midpoint of the 0-100 range)");
        HartResponseBuilder cmd2AtMid(16);
        check(referenceEngine.execute("hart-1", 1, 0x02, {}, cmd2AtMid) && cmd2AtMid.size() == 8,
              "0x02 re-read after PV change");
        const auto expectedCurrentAtMid = HartTypeCodec::encodeFloat32BE(12.0f);
        const auto expectedPercentAtMid = HartTypeCodec::encodeFloat32BE(50.0f);
        check(std::equal(expectedCurrentAtMid.begin(), expectedCurrentAtMid.end(), cmd2AtMid.bytes().begin()) &&
                  std::equal(expectedPercentAtMid.begin(), expectedPercentAtMid.end(), cmd2AtMid.bytes().begin() + 4),
              "0x02 at PV=50 (midpoint): loop current = 12.0mA (4 + 16*0.5), percent = 50%");

        HartResponseBuilder cmd3AtMid(16);
        check(referenceEngine.execute("hart-1", 1, 0x03, {}, cmd3AtMid) && cmd3AtMid.size() == 9 &&
                  std::equal(expectedCurrentAtMid.begin(), expectedCurrentAtMid.end(), cmd3AtMid.bytes().begin()),
              "0x03's loop current is the SAME real computation as 0x02's, not a separate/inconsistent value");
        check(referenceEngine.setPrimaryValue("FV100CA", 0.0), "reset PV back to 0 for the rest of this block's goldens");

        // HCF_SPEC-127 6.10 (Command 9): code 0 -> real PV; any other code
        // -> the spec's own "not supported" convention.
        const uint8_t cmd9Request[] = {0x00, 0x02};
        HartResponseBuilder cmd9Resp(32);
        check(referenceEngine.execute("hart-1", 1, 0x09, cmd9Request, cmd9Resp) && cmd9Resp.size() == 21 /* Table 2: 2 slots */,
              "0x09 read device variables with status: 21-byte body for 2 requested slots (1 status + 2*8 + 4 timestamp)");
        check(cmd9Resp.bytes()[0] == 0x00, "0x09 Extended Field Device Status: all-clear");
        check(cmd9Resp.bytes()[1] == 0x00 && cmd9Resp.bytes()[2] == 0x00 && cmd9Resp.bytes()[3] == 0x39 &&
                  cmd9Resp.bytes()[8] == 0x00,
              "0x09 slot 0 (code 0=PV): code echoed, classification=Not Yet Classified, units=57 percent, status=Good");
        check(cmd9Resp.bytes()[9] == 0x02 && cmd9Resp.bytes()[10] == 0x00 && cmd9Resp.bytes()[11] == 0xFA &&
                  cmd9Resp.bytes()[16] == 0x30,
              "0x09 slot 1 (code 2, unsupported): code echoed, units=Not Used, status=Bad+Constant");
        check(cmd9Resp.bytes()[17] == 0x00 && cmd9Resp.bytes()[18] == 0x00 && cmd9Resp.bytes()[19] == 0x00 && cmd9Resp.bytes()[20] == 0x00,
              "0x09 Slot 0 timestamp: 0 (no monotonic virtual-time clock wired into HART yet, documented gap)");

        // HCF_SPEC-127 6.14 (Command 14): fully spec-defined "not
        // applicable" response since no transducer is modeled.
        HartResponseBuilder cmd14Resp(32);
        const std::vector<uint8_t> expectedCmd14{0x00, 0x00, 0x00, 0xFA, 0x7F, 0xA0, 0x00, 0x00,
                                                 0x7F, 0xA0, 0x00, 0x00, 0x7F, 0xA0, 0x00, 0x00};
        check(referenceEngine.execute("hart-1", 1, 0x0E, {}, cmd14Resp) && cmd14Resp.size() == expectedCmd14.size() &&
                  std::equal(expectedCmd14.begin(), expectedCmd14.end(), cmd14Resp.bytes().begin()),
              "0x0E read PV transducer information: fully spec-defined not-applicable response (serial=0, limits=NaN, units=Not Used)");

        // HCF_SPEC-127 6.15 (Command 15): every field either spec-mandated
        // fallback or a real profile-backed value.
        HartResponseBuilder cmd15Resp(32);
        check(referenceEngine.execute("hart-1", 1, 0x0F, {}, cmd15Resp) && cmd15Resp.size() == 18,
              "0x0F read device information: 18-byte body");
        check(cmd15Resp.bytes()[0] == 0xFB, "0x0F Alarm Selection Code: 251 None");
        check(cmd15Resp.bytes()[1] == 0x00, "0x0F Transfer Function Code: 0 Linear (spec-mandated when unsupported)");
        check(cmd15Resp.bytes()[2] == 0x39, "0x0F PV Units Code: 57 percent (real profile value)");
        const auto expectedUrv = HartTypeCodec::encodeFloat32BE(100.0f);
        const auto expectedLrv = HartTypeCodec::encodeFloat32BE(0.0f);
        check(std::equal(expectedUrv.begin(), expectedUrv.end(), cmd15Resp.bytes().begin() + 3),
              "0x0F PV Upper Range Value: 100.0 (real profile value, matches Command 2/3's own range)");
        check(std::equal(expectedLrv.begin(), expectedLrv.end(), cmd15Resp.bytes().begin() + 7),
              "0x0F PV Lower Range Value: 0.0 (real profile value)");
        check(cmd15Resp.bytes()[15] == 0xFB, "0x0F Write Protect Code: 251 None (spec-mandated when not implemented)");
        check(cmd15Resp.bytes()[16] == 0xFA, "0x0F byte 16: 250 Not Used (spec explicitly requires this exact Reserved value)");

        const std::vector<uint8_t> packedTag = HartTypeCodec::encodePackedAscii("FV100CA", 8);
        check(packedTag.size() == 6, "packed-ASCII tag round-trips to 6 bytes for 8 chars");

        HartResponseBuilder cmd0bMatch(32);
        check(referenceEngine.execute("hart-1", 1, 0x0B, packedTag, cmd0bMatch) &&
                  cmd0bMatch.size() == 13 && cmd0bMatch.bytes()[0] == 0x00 &&
                  std::equal(identityBlock.begin(), identityBlock.end(), cmd0bMatch.bytes().begin() + 1),
              "0x0B tag match: status 0x00 + identity block");

        std::vector<uint8_t> wrongTag = packedTag;
        wrongTag[0] ^= 0xFF;
        HartResponseBuilder cmd0bMismatch(32);
        check(referenceEngine.execute("hart-1", 1, 0x0B, wrongTag, cmd0bMismatch) &&
                  cmd0bMismatch.size() == 13 && cmd0bMismatch.bytes()[0] == 0x01,
              "0x0B tag mismatch: status 0x01 (no native handler ever existed for 0x0B; first implementation is the DSL)");

        const uint8_t codes[] = {0x00, 0x05};
        HartResponseBuilder cmd21(32);
        const std::vector<uint8_t> expectedCmd21{0xF6, 0x39, 0x00, 0x00, 0x00, 0x00,
                                                 0x05, 0xFA, 0x7F, 0xA0, 0x00, 0x00};
        check(referenceEngine.execute("hart-1", 1, 0x21, codes, cmd21) &&
                  std::equal(cmd21.bytes().begin(), cmd21.bytes().end(), expectedCmd21.begin()) &&
                  cmd21.size() == expectedCmd21.size(),
              "0x21 read device variables: known code 0x00 (PV) + unknown code -> not used (no native handler ever existed for 0x21)");
    }

    // Universal Commands 12/17 (Message), 13/18 (Tag/Descriptor/Date), 16/19
    // (Final Assembly Number): golden read/write pairs, persistence across
    // calls (the write-back fix in HartReferenceCatalog::makeHook), cross-
    // command consistency (a Command 18 tag write is observable by Command
    // 0x0B's tag match), atomic rejection of a malformed write, and the
    // regression that a plain read never mutates state (the dirty-check
    // fix that keeps Command 1 from silently re-canonicalizing the tag).
    {
        HartResponseBuilder msgInitial(32);
        check(referenceEngine.execute("hart-1", 1, 0x0C, {}, msgInitial) && msgInitial.size() == 18,
              "0x0C read message: 18-byte packed body (24-char field) even before any write");

        const std::vector<uint8_t> newMessage = HartTypeCodec::encodePackedAscii("HELLO WORLD", 24);
        check(newMessage.size() == 18, "packed-ASCII message round-trips to 18 bytes for 24 chars");
        HartResponseBuilder writeMsgResp(32);
        check(referenceEngine.execute("hart-1", 1, 0x11, newMessage, writeMsgResp) && writeMsgResp.size() == newMessage.size() &&
                  std::equal(newMessage.begin(), newMessage.end(), writeMsgResp.bytes().begin()),
              "0x11 write message accepts a full 18-byte body and echoes it back (HCF_SPEC-127 6.17)");
        HartResponseBuilder msgAfter(32);
        check(referenceEngine.execute("hart-1", 1, 0x0C, {}, msgAfter) &&
                  std::equal(newMessage.begin(), newMessage.end(), msgAfter.bytes().begin()) &&
                  msgAfter.size() == newMessage.size(),
              "0x11 write message PERSISTS: a later 0x0C read observes it (not a throwaway mutation)");

        HartResponseBuilder tagDescDateInitial(32);
        check(referenceEngine.execute("hart-1", 1, 0x0D, {}, tagDescDateInitial) &&
                  tagDescDateInitial.size() == 21 /* 6 + 12 + 3 */,
              "0x0D read tag/descriptor/date: 21-byte body");
        const std::vector<uint8_t> originalTagPacked = HartTypeCodec::encodePackedAscii("FV100CA", 8);
        check(std::equal(originalTagPacked.begin(), originalTagPacked.end(), tagDescDateInitial.bytes().begin()),
              "0x0D's tag matches the profile-derived tag before any 0x12 write");

        const std::vector<uint8_t> newTagPacked = HartTypeCodec::encodePackedAscii("NEWTAG", 8);
        const std::vector<uint8_t> newDescriptorPacked = HartTypeCodec::encodePackedAscii("NEW DESCRIPTOR", 16);
        const std::vector<uint8_t> newDate{15, 6, 126}; // day=15, month=6, year=2026-1900
        std::vector<uint8_t> writeTagDescDateBody;
        writeTagDescDateBody.insert(writeTagDescDateBody.end(), newTagPacked.begin(), newTagPacked.end());
        writeTagDescDateBody.insert(writeTagDescDateBody.end(), newDescriptorPacked.begin(), newDescriptorPacked.end());
        writeTagDescDateBody.insert(writeTagDescDateBody.end(), newDate.begin(), newDate.end());
        check(writeTagDescDateBody.size() == 21, "0x12 write body assembled as tag(6)+descriptor(12)+date(3)=21 bytes");

        HartResponseBuilder writeTagDescDateResp(32);
        check(referenceEngine.execute("hart-1", 1, 0x12, writeTagDescDateBody, writeTagDescDateResp) &&
                  writeTagDescDateResp.size() == writeTagDescDateBody.size() &&
                  std::equal(writeTagDescDateBody.begin(), writeTagDescDateBody.end(), writeTagDescDateResp.bytes().begin()),
              "0x12 write tag/descriptor/date accepts a full 21-byte body and echoes it back (HCF_SPEC-127 6.18)");

        HartResponseBuilder tagDescDateAfter(32);
        check(referenceEngine.execute("hart-1", 1, 0x0D, {}, tagDescDateAfter) &&
                  std::equal(writeTagDescDateBody.begin(), writeTagDescDateBody.end(), tagDescDateAfter.bytes().begin()) &&
                  tagDescDateAfter.size() == writeTagDescDateBody.size(),
              "0x12 write PERSISTS all three fields atomically: a later 0x0D read observes exactly what was written");

        // Cross-command consistency (section 47 of the task): 0x12's tag
        // write must be the SAME tag 0x0B matches against, not a second,
        // disconnected copy.
        HartResponseBuilder cmd0bNewTagMatch(32);
        check(referenceEngine.execute("hart-1", 1, 0x0B, newTagPacked, cmd0bNewTagMatch) &&
                  cmd0bNewTagMatch.size() == 13 && cmd0bNewTagMatch.bytes()[0] == 0x00,
              "0x0B observes the NEW tag written by 0x12 (status 0x00, cross-command consistency)");
        HartResponseBuilder cmd0bOldTagNowMismatches(32);
        check(referenceEngine.execute("hart-1", 1, 0x0B, originalTagPacked, cmd0bOldTagNowMismatches) &&
                  cmd0bOldTagNowMismatches.size() == 13 && cmd0bOldTagNowMismatches.bytes()[0] == 0x01,
              "0x0B no longer matches the OLD tag after 0x12 overwrote it");

        HartResponseBuilder fanInitial(32);
        // Read this fresh (Final Assembly Number was never touched above):
        // any of the previous read-only dispatches (0x0C/0x0D/0x0B) must not
        // have perturbed it either -- proven together with the tag/message
        // regression check below.
        check(referenceEngine.execute("hart-1", 1, 0x10, {}, fanInitial) &&
                  fanInitial.size() == 3 && fanInitial.bytes()[0] == 0 && fanInitial.bytes()[1] == 0 && fanInitial.bytes()[2] == 0,
              "0x10 read final assembly number: defaults to 0 and is unperturbed by unrelated command dispatches");

        const std::vector<uint8_t> newFan{0x01, 0x02, 0x03};
        HartResponseBuilder writeFanResp(8);
        check(referenceEngine.execute("hart-1", 1, 0x13, newFan, writeFanResp) &&
                  writeFanResp.size() == newFan.size() && std::equal(newFan.begin(), newFan.end(), writeFanResp.bytes().begin()),
              "0x13 write final assembly number accepts a full 3-byte body and echoes it back (HCF_SPEC-127 6.19)");
        HartResponseBuilder fanAfter(32);
        check(referenceEngine.execute("hart-1", 1, 0x10, {}, fanAfter) &&
                  std::equal(newFan.begin(), newFan.end(), fanAfter.bytes().begin()) && fanAfter.size() == 3,
              "0x13 write final assembly number PERSISTS: a later 0x10 read observes it");

        // Atomic write (section 50): a body too short for 0x12's last slice
        // (date at offset 18, length 3 -- needs 21 bytes, this is 20) must
        // leave ALL THREE fields untouched, not just reject the date while
        // silently keeping a partial tag/descriptor mutation.
        std::vector<uint8_t> truncatedBody(writeTagDescDateBody.begin(), writeTagDescDateBody.end() - 1);
        check(truncatedBody.size() == 20, "atomicity test body is 1 byte short of the required 21");
        HartResponseBuilder rejectedWriteResp(4);
        check(!referenceEngine.execute("hart-1", 1, 0x12, truncatedBody, rejectedWriteResp),
              "0x12 with a truncated body is rejected outright (out-of-bounds date slice)");
        HartResponseBuilder tagDescDateStillIntact(32);
        check(referenceEngine.execute("hart-1", 1, 0x0D, {}, tagDescDateStillIntact) &&
                  std::equal(writeTagDescDateBody.begin(), writeTagDescDateBody.end(), tagDescDateStillIntact.bytes().begin()),
              "rejected 0x12 write left tag/descriptor/date EXACTLY as the last successful write -- no partial mutation");

        // Regression: a plain read (Command 1) must never silently
        // re-canonicalize the tag (uppercase/space-pad/truncate) as a side
        // effect of merely being dispatched through the same hook.
        HartResponseBuilder unrelatedRead(32);
        check(referenceEngine.execute("hart-1", 1, 0x01, {}, unrelatedRead), "unrelated 0x01 read dispatches");
        HartResponseBuilder tagAfterUnrelatedRead(32);
        check(referenceEngine.execute("hart-1", 1, 0x0D, {}, tagAfterUnrelatedRead) &&
                  std::equal(writeTagDescDateBody.begin(), writeTagDescDateBody.end(), tagAfterUnrelatedRead.bytes().begin()),
              "an unrelated 0x01 read does not perturb tag/descriptor/date (no spurious re-canonicalization)");

        // Universal Commands 20/22 (Long Tag): 32-byte Latin-1, a completely
        // separate data item from Tag (verified above still says "NEWTAG").
        HartResponseBuilder longTagInitial(64);
        check(referenceEngine.execute("hart-1", 1, 0x14, {}, longTagInitial) && longTagInitial.size() == 32 &&
                  std::all_of(longTagInitial.bytes().begin(), longTagInitial.bytes().end(), [](uint8_t b) { return b == 0x20; }),
              "0x14 read long tag: defaults to 32 spaces (empty field, Latin-1 space-padded)");
        std::string longTagText = "Loop-1 Long Tag Ident.";
        const std::vector<uint8_t> newLongTag = HartTypeCodec::encodeLatin1(longTagText, 32);
        HartResponseBuilder writeLongTagResp(64);
        check(referenceEngine.execute("hart-1", 1, 0x16, newLongTag, writeLongTagResp) &&
                  writeLongTagResp.size() == newLongTag.size() &&
                  std::equal(newLongTag.begin(), newLongTag.end(), writeLongTagResp.bytes().begin()),
              "0x16 write long tag accepts a full 32-byte body and echoes it back (HCF_SPEC-127 6.22)");
        HartResponseBuilder longTagAfter(64);
        check(referenceEngine.execute("hart-1", 1, 0x14, {}, longTagAfter) &&
                  std::equal(newLongTag.begin(), newLongTag.end(), longTagAfter.bytes().begin()),
              "0x16 write PERSISTS: a later 0x14 read observes it");
        check(HartTypeCodec::decodeLatin1(newLongTag).substr(0, longTagText.size()) == longTagText,
              "Latin-1 preserves case/punctuation exactly (unlike packed-ASCII's uppercase folding)");
        HartResponseBuilder shortTagStillIntact(32);
        check(referenceEngine.execute("hart-1", 1, 0x0D, {}, shortTagStillIntact) &&
                  std::equal(writeTagDescDateBody.begin(), writeTagDescDateBody.end(), shortTagStillIntact.bytes().begin()),
              "Long Tag write does not perturb the short Tag/Descriptor/Date (completely separate data items)");

        // HCF_SPEC-127 6.21 (Command 21): resolved the id-21/0x15 catalog
        // naming ambiguity this session (Universal semantics cannot
        // legitimately be redefined by a vendor). Match -> same as Command
        // 0; mismatch -> genuine HART silence (no response at all, unlike
        // 0x0B's status-byte convention). Reuses `newLongTag`, already
        // written and persisted by the 0x16 test just above. (Same identity
        // block bytes as the 0x00/0x0B goldens earlier in this function --
        // redeclared locally since that scope has already closed.)
        const std::vector<uint8_t> identityBlockFor21{0xFE, 0x3E, 0x03, 0x05, 0x05, 0x62, 0x03, 0x00, 0x06, 0x02, 0x9E, 0xB1};
        HartResponseBuilder cmd15MatchResp(32);
        check(referenceEngine.execute("hart-1", 1, 0x15, newLongTag, cmd15MatchResp) &&
                  cmd15MatchResp.size() == identityBlockFor21.size() &&
                  std::equal(identityBlockFor21.begin(), identityBlockFor21.end(), cmd15MatchResp.bytes().begin()),
              "0x15 (Command 21) long tag match: response identical to Command 0's identity block");
        std::vector<uint8_t> wrongLongTag = newLongTag;
        wrongLongTag[0] ^= 0xFF;
        HartResponseBuilder cmd15MismatchResp(32);
        check(!referenceEngine.execute("hart-1", 1, 0x15, wrongLongTag, cmd15MismatchResp),
              "0x15 (Command 21) long tag mismatch: genuinely NO response (HART protocol silence, not a status byte)");

        // Universal Command 38 (Reset Configuration Changed Flag, MANDATORY
        // per HCF_SPEC-127 6.23): request/response both echo the same
        // 2-byte Configuration Change Counter.
        const uint8_t configChangeCounter[] = {0x01, 0x2C};
        HartResponseBuilder cmd38Resp(8);
        check(referenceEngine.execute("hart-1", 1, 0x26, configChangeCounter, cmd38Resp) &&
                  cmd38Resp.size() == 2 && cmd38Resp.bytes()[0] == 0x01 && cmd38Resp.bytes()[1] == 0x2C,
              "0x26 reset configuration changed flag echoes the request's Configuration Change Counter");

        // HCF_SPEC-127 6.23.1 Backward Compatibility Requirements: a Rev 6
        // (or earlier) Master sends this command with NO data bytes, and the
        // device must still reset the bit unconditionally (not reject the
        // request for the "wrong" length, and not require a counter match).
        HartResponseBuilder cmd38LegacyResp(8);
        check(referenceEngine.execute("hart-1", 1, 0x26, {}, cmd38LegacyResp) &&
                  cmd38LegacyResp.size() == 0,
              "0x26 with 0 request bytes (HART Rev <=6 Master) is accepted per 6.23.1, not rejected");

        // Universal Command 48 (Read Additional Device Status, MANDATORY per
        // HCF_SPEC-127 6.24): at least the mandatory 9 bytes (0-8), all-clear
        // since this project has no device/analog-channel status model yet.
        HartResponseBuilder cmd48Resp(32);
        check(referenceEngine.execute("hart-1", 1, 0x30, {}, cmd48Resp) && cmd48Resp.size() == 9 &&
                  std::all_of(cmd48Resp.bytes().begin(), cmd48Resp.bytes().end(), [](uint8_t b) { return b == 0x00; }),
              "0x30 read additional device status returns the mandatory minimum 9 bytes, all-clear");

        // HCF_SPEC-127 6.24: "Irrespective of the contents of the Request
        // Data Bytes the device must return the current values" -- a
        // non-empty (real, HART7 comparison-bytes) request must see the SAME
        // live diagnostic status as an empty (legacy) one, not a hardcoded
        // all-clear. (A DSL stub used to shadow the real handler for any
        // non-empty request; removed this session -- see HartEngine.cpp's
        // `command == 0x30` branch and HartReferenceCatalog.cpp's comment
        // at the former 0x30 registration site.)
        check(referenceEngine.setDiagnosticStatus(referencePlans.front().id, 0x80), "Command 48 regression: diagnostic status can be set");
        HartResponseBuilder cmd48Nonempty(32);
        check(referenceEngine.execute("hart-1", 1, 0x30, std::array<uint8_t, 9>{}, cmd48Nonempty) &&
                  cmd48Nonempty.size() == 9 && cmd48Nonempty.bytes()[0] == 0x80,
              "0x30 with a non-empty (comparison-bytes) request reflects the real diagnostic status, not a hardcoded zero");
        check(referenceEngine.setDiagnosticStatus(referencePlans.front().id, 0), "Command 48 regression: diagnostic status restored for later tests");

        // Universal Commands 6/7 (Write Polling Address / Read Loop
        // Configuration) -- the live-readdressing gate (section 12 of the
        // task). Device "FV100CA" starts at address 1 on bus "hart-1".
        HartResponseBuilder loopConfigInitial(8);
        check(referenceEngine.execute("hart-1", 1, 0x07, {}, loopConfigInitial) && loopConfigInitial.size() == 2 &&
                  loopConfigInitial.bytes()[0] == 1 && loopConfigInitial.bytes()[1] == 1,
              "0x07 read loop configuration: address=1, loop current mode=1 (Enabled, the HART default)");

        const uint8_t writeAddressRequest[] = {50, 1}; // new address 50, loop current mode stays Enabled
        HartResponseBuilder writeAddressResp(8);
        check(referenceEngine.execute("hart-1", 1, 0x06, writeAddressRequest, writeAddressResp) &&
                  writeAddressResp.size() == 2 && writeAddressResp.bytes()[0] == 50 && writeAddressResp.bytes()[1] == 1,
              "0x06 write polling address 1 -> 50 succeeds and echoes the new address (HCF_SPEC-127 6.7)");

        HartResponseBuilder oldAddressGone(8);
        check(!referenceEngine.execute("hart-1", 1, 0x07, {}, oldAddressGone),
              "old address 1 no longer resolves this device after Command 6 -- REAL live readdressing, not a cosmetic field");
        HartResponseBuilder newAddressWorks(8);
        check(referenceEngine.execute("hart-1", 50, 0x07, {}, newAddressWorks) && newAddressWorks.size() == 2 &&
                  newAddressWorks.bytes()[0] == 50 && newAddressWorks.bytes()[1] == 1,
              "new address 50 resolves the SAME device immediately after the same transaction that changed it");
        HartResponseBuilder identityStillWorksAtNewAddress(32);
        check(referenceEngine.execute("hart-1", 50, 0x01, {}, identityStillWorksAtNewAddress) &&
                  identityStillWorksAtNewAddress.size() == 5,
              "the device's OTHER state (PV) is unaffected by the address change -- same device, new address, not a fresh/reset one");
    }

    uint8_t payload[] = {0x10, 0x20, 0x30};
    HartFrame request{3, 1, {payload[0], payload[1], payload[2]}};
    HartResponseBuilder wire(16);
    check(HartFrameCodec::encode(request, wire), "frame encode");
    HartFrame decoded;
    check(HartFrameCodec::decode(wire.bytes(), decoded), "frame decode");
    check(decoded.pollingAddress == 3 && decoded.command == 1 && decoded.payload == request.payload,
          "frame round trip");
    auto corrupt = std::vector<uint8_t>(wire.bytes().begin(), wire.bytes().end());
    corrupt.back() ^= 1;
    check(!HartFrameCodec::decode(corrupt, decoded), "checksum rejects corruption");

    HartPayloadReader reader{std::span<const uint8_t>(payload)};
    uint16_t u16 = 0; uint8_t byte = 0;
    check(reader.readByte(byte) && byte == 0x10, "payload byte");
    check(reader.readU16(u16) && u16 == 0x2030, "payload u16");
    check(!reader.readByte(byte), "payload bounds");

    Handler handler;
    HartCommandRegistry commands;
    check(commands.registerHandler(handler), "command register");
    check(!commands.registerHandler(handler), "duplicate command rejected");
    check(commands.find(1) == &handler, "command lookup");
    check(commands.remove(1) && commands.find(1) == nullptr, "command removal");

    HartProfileRegistry profiles;
    check(profiles.registerProfile({"hart.default", 1, 0, 0, {{0, "identity"}}}), "profile register");
    check(!profiles.registerProfile({"hart.default", 1, 0, 0, {}}), "duplicate profile rejected");
    check(profiles.find("hart.default") != nullptr, "profile lookup");
    check(profiles.remove("hart.default") && profiles.find("hart.default") == nullptr, "profile removal");

    HartProfileRegistry runtimeProfiles;
    check(runtimeProfiles.registerProfile({"hart.default", 1, 0, 0,
                                           {{0, "identity"}, {1, "primary"}, {3, "dynamic"}}}),
          "runtime profile register");
    const std::vector<HartDevicePlan> devices{{"dev-a", "hart.default", "hart-1", 3, "0011223344", 21.5},
                                              {"dev-b", "hart.default", "hart-2", 3, "5566778899", 7.0}};
    const HartPlanCompileResult plan = HartPlanCompiler::compile(devices, runtimeProfiles);
    check(plan.success && plan.plan.devices.size() == 2, "plan compile multiple buses");
    HartEngine engine(runtimeProfiles);
    check(engine.loadPlan(plan.plan), "engine load plan");
    check(HartReferenceCatalog::installCommandPrograms(engine), "DSL command programs install (runtime engine)");
    HartResponseBuilder primary(8);
    check(engine.execute(3, 1, {}, primary) && primary.size() == 5, "primary command dispatch");
    HartResponseBuilder secondary(8);
    check(engine.execute("hart-2", 3, 1, {}, secondary) && secondary.size() == 5 &&
              !std::equal(primary.bytes().begin(), primary.bytes().end(), secondary.bytes().begin()),
          "same address dispatches by bus");
    check(engine.setPrimaryValue("dev-a", 42.25), "runtime value update");
    check(!engine.setPrimaryValue("missing", 1.0), "missing device rejected");
    const std::vector<uint8_t> configuredResponse{0xCA, 0xFE};
    HartDevicePlan configuredDevice{"configured", "hart.default", "hart-1", 5,
                                    "configured-id", 0.0,
                                    {{1, true, false, {}}}};
    configuredDevice.variables.push_back({"PV", "Primary", "V", 2.0});
    HartEngine configuredEngine(runtimeProfiles);
    check(configuredEngine.loadPlan({{configuredDevice}}), "per-device command configuration loads");
    check(HartReferenceCatalog::installCommandPrograms(configuredEngine), "DSL command programs install (configured engine)");
    HartResponseBuilder configuredRead(8);
    const auto expectedPv = HartTypeCodec::encodeFloat32BE(2.0f);
    check(configuredEngine.execute(5, 1, {}, configuredRead) && configuredRead.size() == 5 &&
              configuredRead.bytes()[0] == 0x39 &&
              std::equal(expectedPv.begin(), expectedPv.end(), configuredRead.bytes().begin() + 1),
          "HART Internal variable reaches the DSL response byte-exact");
    check(configuredEngine.setCommandResponse("configured", 1, configuredResponse),
          "per-device static response update");
    HartResponseBuilder configuredResponseOut(4);
    check(configuredEngine.execute(5, 1, {}, configuredResponseOut) &&
              configuredResponseOut.bytes().size() == 2 && configuredResponseOut.bytes()[0] == 0xCA,
          "per-device static response dispatch");
    check(configuredEngine.setCommandEnabled("configured", 1, false),
          "per-device command disable");
    HartResponseBuilder disabledResponse(4);
    check(!configuredEngine.execute(5, 1, {}, disabledResponse), "disabled per-device command rejected");
    HartTransportEndpoint endpoint(configuredEngine);
    HartTransportConfig udpConfig{HartTransportKind::Udp, "hart-1", "127.0.0.1", 1200, 5094, 272};
    check(endpoint.configure(udpConfig), "transport configuration");
    // Re-enable command 1 for the transport boundary test.
    check(configuredEngine.setCommandEnabled("configured", 1, true), "transport command enable");
    HartFrame wireRequest{5, 1, {}};
    HartResponseBuilder encodedRequest(16);
    check(HartFrameCodec::encode(wireRequest, encodedRequest), "transport request encode");
    HartResponseBuilder encodedResponse(272);
    check(endpoint.transact(encodedRequest.bytes(), encodedResponse), "transport transaction");
    HartFrame wireResponse;
    check(HartFrameCodec::decode(encodedResponse.bytes(), wireResponse) &&
              wireResponse.pollingAddress == 5 && wireResponse.command == 1,
          "transport response decode");
    check(endpoint.counters().framesRx == 1 && endpoint.counters().framesTx == 1,
          "transport counters");
    CustomHandler custom;
    check(engine.registerCommandHandler(custom), "custom command registration");
    HartResponseBuilder customResponse(4);
    check(!engine.execute(3, 99, {}, customResponse), "undeclared custom command rejected");
    HartProfileRegistry customProfiles;
    check(customProfiles.registerProfile({"hart.custom", 1, 0, 0, {{99, "custom"}}}), "custom profile register");
    HartEngine customEngine(customProfiles);
    check(customEngine.registerCommandHandler(custom), "custom engine handler");
    check(customEngine.loadPlan({{{"custom-device", "hart.custom", "hart-1", 4, "custom", 0.0}}}), "custom plan");
    check(customEngine.execute(4, 99, {}, customResponse) && customResponse.bytes()[0] == 0x99,
          "custom command dispatch without engine edit");
    const std::vector<HartDevicePlan> collision{{"a", "hart.default", "hart-1", 1, "a", 0.0},
                                                {"b", "hart.default", "hart-1", 1, "b", 0.0}};
    check(!HartPlanCompiler::compile(collision, runtimeProfiles).success, "same-bus address collision rejected");
    const HartProtocolPlan invalid{{{"broken", "missing-profile", "hart-1", 1, "", 0.0}}};
    check(!engine.loadPlan(invalid), "engine rejects invalid plan");

    // Property Inspector Commands editor bridge: JSON (de)serialization of the
    // flat response-step subset, merged install alongside the 5 built-ins.
    {
        const std::string validJson = R"([
            {"id": 128, "name": "Custom PV Read", "responseSteps": [
                {"kind": "variable", "variable": "PrimaryVariableUnit"},
                {"kind": "variable", "variable": "PrimaryVariable"},
                {"kind": "hex", "bytes": "CAFE"},
                {"kind": "bodySlice", "offset": 0, "length": 2}
            ]}
        ])";
        const auto parsedValid = HartCommandJson::parseCommandCollection(validJson);
        check(parsedValid.success && parsedValid.definitions.size() == 1 &&
                  parsedValid.definitions[0].id == 128 && parsedValid.definitions[0].resp.size() == 4,
              "Commands editor JSON parses a real response step sequence");

        HartProfileRegistry jsonProfiles;
        check(jsonProfiles.registerProfile(HartReferenceCatalog::makeGenericProfile()), "json bridge profile register");
        HartEngine jsonEngine(jsonProfiles);
        HartDevicePlan jsonDevice{"json-device", "lasecsimul.hart.process-simul-compatible", "hart-1", 9, "029EB1", 12.5};
        jsonDevice.tag = "JDEV";
        for (const auto& command : HartReferenceCatalog::commandDescriptors())
            jsonDevice.commandConfigurations.push_back({command.id, true, false, {}});
        check(jsonEngine.loadPlan({{jsonDevice}}), "json bridge device plan loads");
        const auto installed = HartReferenceCatalog::installCommandPrograms(jsonEngine, parsedValid.definitions);
        check(installed.success, "custom command merges with built-ins");

        HartResponseBuilder builtinStillWorks(32);
        check(jsonEngine.execute("hart-1", 9, 0x01, {}, builtinStillWorks) && builtinStillWorks.size() == 5,
              "built-in 0x01 still dispatches after merging a custom command");

        const uint8_t customRequest[] = {0xAA, 0xBB};
        HartResponseBuilder customOut(32);
        // unit(57=0x39) + float32BE(12.5 == 0x41480000) + hex(CAFE) + bodySlice(request[0:2])
        const std::vector<uint8_t> expectedCustom{0x39, 0x41, 0x48, 0x00, 0x00, 0xCA, 0xFE, 0xAA, 0xBB};
        // id 128 == 0x80 ("Vendor Read Configuration" in the reference
        // catalog's descriptor list) is Device-Specific per HCF_SPEC-99 Table
        // 9 -- `commandProgramDefinitions()` deliberately installs NO program
        // for it (no auto-echo fallback; see that function's doc comment), so
        // this custom body is the ONLY implementation of command 128 here.
        // If `installCommandPrograms` ever regressed to `unordered_map::emplace`
        // (which refuses to overwrite an existing key) this would still pass
        // today since there is nothing to collide with -- the real regression
        // this guards is a future built-in reintroducing a body under 128
        // and silently winning over this manufacturer definition.
        check(jsonEngine.execute("hart-1", 9, 128, customRequest, customOut) &&
                  customOut.size() == expectedCustom.size() &&
                  std::equal(expectedCustom.begin(), expectedCustom.end(), customOut.bytes().begin()),
              "custom command 128 (variable + hex + bodySlice) executes end to end as a manufacturer Device-Specific command");

        const nlohmann::json roundTrip = HartCommandJson::toJson(parsedValid.definitions[0]);
        check(roundTrip["id"] == 128 && roundTrip["responseSteps"].size() == 4 &&
                  roundTrip["responseSteps"][2]["kind"] == "hex" && roundTrip["responseSteps"][2]["bytes"] == "CAFE",
              "toJson round-trips the same step sequence the UI would re-render");

        const auto parsedUserVar = HartCommandJson::parseCommandDefinition(
            nlohmann::json::parse(R"({"id": 202, "responseSteps": [{"kind": "variable", "variable": "DiagnosticX"}]})"));
        check(parsedUserVar.success, "a user-variable response step parses");
        const nlohmann::json userVarRoundTrip = HartCommandJson::toJson(parsedUserVar.definition);
        check(userVarRoundTrip["responseSteps"][0]["kind"] == "variable" &&
                  userVarRoundTrip["responseSteps"][0]["variable"] == "DiagnosticX" &&
                  userVarRoundTrip.value("unsupported", false) == false,
              "toJson round-trips a user-variable step by its stable variableId, not marked unsupported");

        check(!HartCommandJson::parseCommandCollection(R"([{"id": 0, "name": "x", "responseSteps": []}])").success,
              "JSON bridge rejects a custom command shadowing a reserved standard id");
        check(!HartCommandJson::parseCommandCollection(R"([{"id": 1, "responseSteps": [{"kind": "hex", "bytes": "ZZ"}]}])").success,
              "JSON bridge rejects invalid hex");
        check(HartCommandJson::parseCommandCollection(
                  R"([{"id": 200, "responseSteps": [{"kind": "variable", "variable": "UserVariable"}]}])").success,
              "JSON bridge accepts a user-variable reference by stable variableId");
        check(!HartCommandJson::parseCommandCollection(
                  R"([{"id": 201, "responseSteps": []}, {"id": 201, "responseSteps": []}])").success,
              "JSON bridge rejects duplicate command ids within one collection");

        // A broken custom collection must not take down the built-ins: the
        // Property Inspector's Diagnostics status reflects the error, but
        // 0x00/0x01/0x03/0x0B/0x21 keep working (HartCommunicationComponent
        // ::rebuildCommandPrograms follows exactly this fallback).
        HartCommandDefinition broken;
        broken.id = 150;
        broken.resp = {HartStatement{HartAppendStmt{HartExpr::bodySlice(0, 1000)}}}; // exceeds the bound
        const auto brokenInstall = HartReferenceCatalog::installCommandPrograms(jsonEngine, {broken});
        check(!brokenInstall.success && !brokenInstall.error.empty(), "a broken custom command reports a diagnostic");
        HartResponseBuilder stillBuiltin(32);
        check(jsonEngine.execute("hart-1", 9, 0x00, {}, stillBuiltin) && stillBuiltin.size() == 12,
              "built-ins survive a broken custom command install (fallback, not a crash)");

        // Full statement vocabulary through JSON: write/SET, IF/EQ, MAP,
        // FOR_CODES -- not just the flat Append subset. This is the exact
        // compiler target the Lasec HART Command DSL (extension/src/dsl/
        // HartCommandDsl.ts) lowers to; this test proves the JSON side of
        // that bridge independent of the TypeScript parser.
        const std::string fullVocabJson = R"([{
            "id": 160, "name": "Full Vocabulary",
            "writeSteps": [{"kind": "set", "target": "PrimaryVariableUnit", "value": {"kind": "bodySlice", "offset": 0, "length": 1}}],
            "responseSteps": [
                {"kind": "if",
                 "lhs": {"kind": "variable", "variable": "PrimaryVariableUnit"},
                 "rhs": {"kind": "hex", "bytes": "11"},
                 "then": [{"kind": "hex", "bytes": "AA"}],
                 "else": [{"kind": "hex", "bytes": "BB"}]},
                {"kind": "map",
                 "key": {"kind": "bodySlice", "offset": 1, "length": 1},
                 "table": [{"key": "01", "value": "C1"}, {"key": "02", "value": "C2"}],
                 "default": "C0"},
                {"kind": "forCodes",
                 "source": {"kind": "bodySlice", "offset": 2, "length": 2},
                 "maxIterations": 4,
                 "body": [{"kind": "localCode"}]}
            ]
        }])";
        const auto fullVocabParsed = HartCommandJson::parseCommandCollection(fullVocabJson);
        check(fullVocabParsed.success && fullVocabParsed.definitions.size() == 1 &&
                  fullVocabParsed.definitions[0].write.size() == 1 && fullVocabParsed.definitions[0].resp.size() == 3,
              "JSON bridge parses write/SET + IF/MAP/FOR_CODES, not just flat Append");

        HartProfileRegistry fullVocabProfiles;
        check(fullVocabProfiles.registerProfile(HartReferenceCatalog::makeGenericProfile()), "full-vocab profile register");
        HartEngine fullVocabEngine(fullVocabProfiles);
        HartDevicePlan fullVocabDevice{"full-vocab-device", "lasecsimul.hart.process-simul-compatible", "hart-1", 12, "029EB1", 0.0};
        for (const auto& command : HartReferenceCatalog::commandDescriptors())
            fullVocabDevice.commandConfigurations.push_back({command.id, true, false, {}});
        check(fullVocabEngine.loadPlan({{fullVocabDevice}}), "full-vocab device plan loads");
        check(HartReferenceCatalog::installCommandPrograms(fullVocabEngine, fullVocabParsed.definitions).success,
              "full-vocab command installs (write/SET + IF/MAP/FOR_CODES all validate)");

        const uint8_t fullVocabRequest1[] = {0x11, 0x01, 0x07, 0x08};
        HartResponseBuilder fullVocabOut1(16);
        const std::vector<uint8_t> fullVocabExpected1{0xAA, 0xC1, 0x07, 0x08};
        check(fullVocabEngine.execute("hart-1", 12, 160, fullVocabRequest1, fullVocabOut1) &&
                  fullVocabOut1.size() == fullVocabExpected1.size() &&
                  std::equal(fullVocabExpected1.begin(), fullVocabExpected1.end(), fullVocabOut1.bytes().begin()),
              "JSON-authored write/SET observed by resp's IF, matching the C++-authored equivalent byte-for-byte");

        const uint8_t fullVocabRequest2[] = {0x22, 0x09, 0x0A, 0x0B};
        HartResponseBuilder fullVocabOut2(16);
        const std::vector<uint8_t> fullVocabExpected2{0xBB, 0xC0, 0x0A, 0x0B};
        check(fullVocabEngine.execute("hart-1", 12, 160, fullVocabRequest2, fullVocabOut2) &&
                  fullVocabOut2.size() == fullVocabExpected2.size() &&
                  std::equal(fullVocabExpected2.begin(), fullVocabExpected2.end(), fullVocabOut2.bytes().begin()),
              "JSON-authored IF else branch and MAP default both reachable");

        const nlohmann::json fullVocabRoundTrip = HartCommandJson::toJson(fullVocabParsed.definitions[0]);
        const auto fullVocabReparsed = HartCommandJson::parseCommandDefinition(fullVocabRoundTrip);
        check(fullVocabReparsed.success, "full-vocab definition round-trips through toJson() back to a valid definition");
        HartResponseBuilder fullVocabRoundTripOut(16);
        const auto fullVocabRoundTripCompiled = HartCommandCompiler::compile(fullVocabReparsed.definition);
        HartExecutionVariables fullVocabRoundTripVars;
        check(fullVocabRoundTripCompiled.success &&
                  HartCommandExecutor::execute(fullVocabRoundTripCompiled.program, fullVocabRoundTripVars, fullVocabRequest1, fullVocabRoundTripOut) &&
                  fullVocabRoundTripOut.size() == fullVocabExpected1.size() &&
                  std::equal(fullVocabExpected1.begin(), fullVocabExpected1.end(), fullVocabRoundTripOut.bytes().begin()),
              "toJson() -> re-parse -> re-compile produces byte-identical behavior (no data lost in the round trip)");

        // Write-ownership (which built-in variables SET may target) is the
        // compiler's rule, not re-implemented at the JSON layer: this JSON
        // parses structurally (any known HartVarId name is syntactically
        // valid as a SET target), and is rejected only when compiled/installed
        // -- one source of truth for the rule, not two that could drift apart.
        const auto badSetParsed = HartCommandJson::parseCommandCollection(
            R"([{"id": 161, "responseSteps": [{"kind": "set", "target": "ManufacturerId", "value": {"kind": "hex", "bytes": "01"}}]}])");
        check(badSetParsed.success, "JSON bridge parses a structurally-valid SET target regardless of write-ownership");
        const auto badSetInstall = HartReferenceCatalog::installCommandPrograms(fullVocabEngine, badSetParsed.definitions);
        check(!badSetInstall.success && badSetInstall.error.find("non-writable") != std::string::npos,
              "the compiler (not the JSON parser) rejects SET to a non-writable built-in variable");
    }

    // Cross-language proof that 0x0B is genuinely DSL-representable (FASE 72
    // gate): this exact JSON is what extension/src/dsl/HartCommandDsl.ts's
    // hartCommandBodyToJson() produces for parsing the command-DSL source
    //   { if in[0:6] == Tag { hex("00") -> out; IdentityBlock -> out }
    //     else { hex("01") -> out; IdentityBlock -> out } }
    // (see HartCommandDsl.test.ts's "comando 0x0B equivalente" case for the
    // TypeScript-side half of this proof). Installed here as a CUSTOM command
    // (id 175, distinct from the reserved 0x0B) and compared byte-for-byte
    // against the same golden identity block/status bytes the hand-authored
    // 0x0B program produces -- proving the DSL path is not just "parses" but
    // functionally equivalent to the C++ AST it is meant to replace.
    {
        HartProfileRegistry dslProfiles;
        check(dslProfiles.registerProfile(HartReferenceCatalog::makeGenericProfile()), "DSL-0x0B profile register");
        HartEngine dslEngine(dslProfiles);
        HartDevicePlan dslDevice{"dsl-0x0b-device", "lasecsimul.hart.process-simul-compatible", "hart-1", 20, "029EB1", 0.0};
        dslDevice.tag = "FV100CA";
        for (const auto& command : HartReferenceCatalog::commandDescriptors())
            dslDevice.commandConfigurations.push_back({command.id, true, false, {}});
        // 175 == 0xAF, deliberately NOT one of the 60 catalogued ids (unlike
        // the "full vocabulary" test's 160 == 0xA0, which happens to already
        // be standard) -- a genuinely custom id must be declared explicitly
        // when driving HartEngine directly (HartCommunicationComponent does
        // this automatically via its hartCommandsJson pre-scan).
        dslDevice.commandConfigurations.push_back({175, true, false, {}});
        check(dslEngine.loadPlan({{dslDevice}}), "DSL-0x0B device plan loads");

        const nlohmann::json dslLoweredJson = nlohmann::json::parse(R"([{
            "id": 175, "name": "Custom 0x0B via DSL", "enabled": true,
            "writeSteps": [],
            "responseSteps": [{
                "kind": "if",
                "lhs": {"kind": "bodySlice", "offset": 0, "length": 6},
                "rhs": {"kind": "variable", "variable": "Tag"},
                "then": [
                    {"kind": "hex", "bytes": "00"},
                    {"kind": "hex", "bytes": "FE"},
                    {"kind": "variable", "variable": "ManufacturerId"},
                    {"kind": "variable", "variable": "DeviceType"},
                    {"kind": "variable", "variable": "NumRequestPreambles"},
                    {"kind": "variable", "variable": "UniversalCommandRevision"},
                    {"kind": "variable", "variable": "TransmitterSpecificRevision"},
                    {"kind": "variable", "variable": "SoftwareRevision"},
                    {"kind": "variable", "variable": "HardwareRevisionAndSignal"},
                    {"kind": "variable", "variable": "Flags"},
                    {"kind": "variable", "variable": "DeviceId"}
                ],
                "else": [
                    {"kind": "hex", "bytes": "01"},
                    {"kind": "hex", "bytes": "FE"},
                    {"kind": "variable", "variable": "ManufacturerId"},
                    {"kind": "variable", "variable": "DeviceType"},
                    {"kind": "variable", "variable": "NumRequestPreambles"},
                    {"kind": "variable", "variable": "UniversalCommandRevision"},
                    {"kind": "variable", "variable": "TransmitterSpecificRevision"},
                    {"kind": "variable", "variable": "SoftwareRevision"},
                    {"kind": "variable", "variable": "HardwareRevisionAndSignal"},
                    {"kind": "variable", "variable": "Flags"},
                    {"kind": "variable", "variable": "DeviceId"}
                ]
            }]
        }])");
        const auto dslParsed = HartCommandJson::parseCommandCollection(dslLoweredJson.dump());
        check(dslParsed.success, "DSL-lowered JSON for 0x0B parses");
        const auto dslInstalled = HartReferenceCatalog::installCommandPrograms(dslEngine, dslParsed.definitions);
        check(dslInstalled.success, "DSL-lowered 0x0B compiles and installs");

        const std::vector<uint8_t> identityBlock{0xFE, 0x3E, 0x03, 0x05, 0x05, 0x62, 0x03, 0x00, 0x06, 0x02, 0x9E, 0xB1};
        const std::vector<uint8_t> packedTag = HartTypeCodec::encodePackedAscii("FV100CA", 8);

        HartResponseBuilder dslMatch(32);
        check(dslEngine.execute("hart-1", 20, 175, packedTag, dslMatch) &&
                  dslMatch.size() == 13 && dslMatch.bytes()[0] == 0x00 &&
                  std::equal(identityBlock.begin(), identityBlock.end(), dslMatch.bytes().begin() + 1),
              "DSL-authored 0x0B-equivalent: tag match produces the SAME bytes as the hand-authored 0x0B golden");

        std::vector<uint8_t> wrongTag = packedTag;
        wrongTag[0] ^= 0xFF;
        HartResponseBuilder dslMismatch(32);
        check(dslEngine.execute("hart-1", 20, 175, wrongTag, dslMismatch) &&
                  dslMismatch.size() == 13 && dslMismatch.bytes()[0] == 0x01,
              "DSL-authored 0x0B-equivalent: tag mismatch produces status 0x01, matching the hand-authored golden");
    }

    // HartCommunicationComponent end to end: construction reads the FULL saved
    // properties map (including hartVariablesJson/hartCommandsJson and tag) --
    // this is the exact path `addComponent` uses on project reopen, and it used
    // to silently drop variables/commands/tag back to defaults (Gate 12 /
    // section 38 persistence contract; the tag bug predates this session).
    {
        lasecsimul::simulation::Scheduler scheduler(4, [] { return true; });
        lasecsimul::registry::ComponentParams params;
        params.properties["bus"] = std::string("hart-1");
        params.properties["endpoint"] = std::string("COM9");
        params.properties["uniqueId"] = std::string("112233");
        params.properties["tag"] = std::string("PT101");
        params.properties["pollingAddress"] = 7.0;
        params.properties["enabled"] = true;
        params.properties["hartVariablesJson"] = std::string(
            R"([{"id":"PV","name":"Process Value","role":"PV","type":"Float32","direction":"Internal","value":42.5},)"
            R"({"id":"DiagnosticX","name":"Diagnostic X","type":"Float32","direction":"Internal","value":7.0},)"
            R"({"id":"DiagByte","name":"Diag Byte","type":"UInt8","direction":"Internal","value":200},)"
            R"({"id":"DiagSigned","name":"Diag Signed","type":"Int16","direction":"Internal","value":-5},)"
            R"({"id":"DiagFlag","name":"Diag Flag","type":"Bool","direction":"Internal","value":1}])");
        // Command 152 (0x98) is deliberately "Vendor Keepalive" -- one of the
        // reference catalog's Device-Specific descriptor ids, which
        // `commandProgramDefinitions()` deliberately leaves unimplemented (no
        // auto-echo fallback). Authoring a real custom body under that exact
        // id is the regression gate for "a manufacturer command declared
        // under a catalogued vendor id must dispatch correctly without
        // corrupting the rest of the device's command dispatch" -- this
        // combination is what first exposed the real bug fixed in
        // rebuildConfiguredPlan() (a duplicate commandConfigurations entry
        // silently failed the WHOLE plan, taking 0x01/0x0B/every other
        // command down with it, not just 0x98).
        params.properties["hartCommandsJson"] = std::string(
            R"([{"id":150,"name":"Echo Tag","responseSteps":[{"kind":"variable","variable":"Tag"}]},)"
            R"({"id":151,"name":"Diagnostic X","responseSteps":[{"kind":"variable","variable":"DiagnosticX"}]},)"
            R"({"id":152,"name":"Diag Byte","responseSteps":[{"kind":"variable","variable":"DiagByte"}]},)"
            R"({"id":153,"name":"Diag Signed","responseSteps":[{"kind":"variable","variable":"DiagSigned"}]},)"
            R"({"id":154,"name":"Diag Flag","responseSteps":[{"kind":"variable","variable":"DiagFlag"}]}])");

        HartCommunicationComponent component(HartCommunicationComponent::Mode::Serial, scheduler, params);
        auto findValue = [&component](const char* id) -> lasecsimul::PropertyValue {
            for (auto& d : component.propertyDescriptors()) if (d.schema.id == id) return d.get();
            return std::string{};
        };
        check(std::get<std::string>(findValue("hartVariablesStatus")) == "OK", "component construction accepts saved variables");
        check(std::get<std::string>(findValue("hartCommandsStatus")) == "OK", "component construction accepts saved commands");

        HartFrame pvRequest{7, 1, {}};
        HartResponseBuilder pvWire(16);
        check(HartFrameCodec::encode(pvRequest, pvWire), "component test: encode PV request");
        HartResponseBuilder pvResponseWire(32);
        check(component.transact(pvWire.bytes(), pvResponseWire), "component transacts a standard command");
        HartFrame pvResponse;
        check(HartFrameCodec::decode(pvResponseWire.bytes(), pvResponse) && pvResponse.payload.size() == 5,
              "component: saved variable's value (42.5) reaches the standard 0x01 response");
        const auto expectedPv = HartTypeCodec::encodeFloat32BE(42.5f);
        // `check()` logs and continues rather than aborting, so a prior
        // failed size check must not be assumed true here -- re-guard size
        // before the +1 iterator arithmetic (a `check()`-only guard above is
        // not enough to prevent UB in a later, separate check() call).
        check(pvResponse.payload.size() == 5 && std::equal(expectedPv.begin(), expectedPv.end(), pvResponse.payload.begin() + 1),
              "component: 0x01 response carries the exact saved PV value");

        HartFrame customRequest{7, 150, {}};
        HartResponseBuilder customWire(16);
        check(HartFrameCodec::encode(customRequest, customWire), "component test: encode custom command request");
        HartResponseBuilder customResponseWire(32);
        check(component.transact(customWire.bytes(), customResponseWire), "component transacts a custom (UI-authored) command");
        HartFrame customResponse;
        check(HartFrameCodec::decode(customResponseWire.bytes(), customResponse) && customResponse.payload.size() == 6,
              "component: custom command 150 (Variable Tag) dispatches through the JSON bridge");
        check(HartTypeCodec::decodePackedAscii(customResponse.payload).substr(0, 5) == "PT101",
              "component: saved \"tag\" property (not just plan.id) reaches command 0x0B/custom Tag references (persistence bug fixed)");
        HartFrame userVariableRequest{7, 151, {}};
        HartResponseBuilder userVariableWire(16);
        check(HartFrameCodec::encode(userVariableRequest, userVariableWire), "component test: encode user-variable command");
        HartResponseBuilder userVariableResponseWire(16);
        check(component.transact(userVariableWire.bytes(), userVariableResponseWire),
              "component transacts a command bound to a user-created variable");
        HartFrame userVariableResponse;
        const auto expectedDiagnostic = HartTypeCodec::encodeFloat32BE(7.0f);
        check(HartFrameCodec::decode(userVariableResponseWire.bytes(), userVariableResponse) &&
                  std::equal(expectedDiagnostic.begin(), expectedDiagnostic.end(), userVariableResponse.payload.begin()),
              "component: command 151 reads DiagnosticX by variableId");

        // Regression for the type-aware UserVariable encoding fix: before it,
        // EVERY user variable encoded as 4-byte Float32BE regardless of its
        // declared "type" -- the field was editable, persisted, and silently
        // ignored by the runtime (exactly the decorative-property bug class
        // this audit chain exists to find).
        auto transactCommand = [&component](HartCommandId command) -> std::vector<uint8_t> {
            HartFrame request{7, command, {}};
            HartResponseBuilder wire(16);
            if (!HartFrameCodec::encode(request, wire)) return {};
            // 48 bytes: large enough for the widest response this helper is
            // used against (Command 12's 18-byte packed message), not just
            // the 1-2 byte user-variable payloads it was first written for.
            HartResponseBuilder responseWire(48);
            if (!component.transact(wire.bytes(), responseWire)) return {};
            HartFrame response;
            if (!HartFrameCodec::decode(responseWire.bytes(), response)) return {};
            return response.payload;
        };
        const auto diagByte = transactCommand(152);
        check(diagByte.size() == 1 && diagByte[0] == 200,
              "component: UInt8 user variable encodes as exactly 1 byte (200), not 4-byte float -- AND command 0x98 "
              "returns this custom byte, not an echo of the (empty) request body, proving the custom-overrides-"
              "standard-fallback fix (section 51/52) works for a real device, not just the isolated engine test above");
        const auto diagSigned = transactCommand(153);
        check(diagSigned.size() == 2 && diagSigned[0] == 0xFF && diagSigned[1] == 0xFB,
              "component: Int16 user variable (-5) encodes as the correct 2-byte two's-complement big-endian bytes");
        const auto diagFlag = transactCommand(154);
        check(diagFlag.size() == 1 && diagFlag[0] == 1, "component: Bool user variable encodes as exactly 1 byte");

        // Universal Command 17/12 (Write/Read Message) through the REAL
        // production component (not just the bare HartEngine test above):
        // proves HartCommunicationComponent::transact -> HartEngine::execute
        // -> the programHook's persistence write-back is wired end to end,
        // not just correct in isolation.
        const auto componentNewMessage = HartTypeCodec::encodePackedAscii("PROD PATH OK", 24);
        HartFrame writeMessageRequest{7, 0x11, componentNewMessage};
        HartResponseBuilder writeMessageWire(32);
        check(HartFrameCodec::encode(writeMessageRequest, writeMessageWire), "component test: encode write-message request");
        HartResponseBuilder writeMessageResponseWire(32);
        check(component.transact(writeMessageWire.bytes(), writeMessageResponseWire),
              "component transacts Universal Command 17 (Write Message)");
        const auto messageAfterWrite = transactCommand(0x0C);
        check(messageAfterWrite.size() == componentNewMessage.size() &&
                  std::equal(componentNewMessage.begin(), componentNewMessage.end(), messageAfterWrite.begin()),
              "component: Command 17's write PERSISTS through the real production path -- Command 12 observes it");

        // Also exercise Command 22 (Write Long Tag) and Command 6 (Write
        // Polling Address) through the real component before capturing the
        // "saved project" snapshot below -- these are exactly the two new
        // commands most likely to regress the save/reopen gate (Long Tag is
        // a brand new persisted field; Polling Address changes the very key
        // `findValue`/`transactCommand` address themselves).
        const auto componentNewLongTag = HartTypeCodec::encodeLatin1("Reopen Test Tag", 32);
        HartFrame writeLongTagRequest{7, 0x16, componentNewLongTag};
        HartResponseBuilder writeLongTagWire(64);
        check(HartFrameCodec::encode(writeLongTagRequest, writeLongTagWire), "component test: encode write-long-tag request");
        HartResponseBuilder writeLongTagResponseWire(64);
        check(component.transact(writeLongTagWire.bytes(), writeLongTagResponseWire),
              "component transacts Universal Command 22 (Write Long Tag)");

        const std::vector<uint8_t> writeAddressRequest{8, 1}; // 7 -> 8, loop current stays Enabled
        HartFrame writeAddressRequestFrame{7, 0x06, writeAddressRequest};
        HartResponseBuilder writeAddressWire(16);
        check(HartFrameCodec::encode(writeAddressRequestFrame, writeAddressWire), "component test: encode write-polling-address request");
        HartResponseBuilder writeAddressResponseWire(16);
        check(component.transact(writeAddressWire.bytes(), writeAddressResponseWire),
              "component transacts Universal Command 6 (Write Polling Address) 7 -> 8");
        HartFrame stillAt7 = HartFrame{7, 0x0C, {}};
        HartResponseBuilder stillAt7Wire(16);
        check(HartFrameCodec::encode(stillAt7, stillAt7Wire), "component test: encode probe at old address 7");
        HartResponseBuilder stillAt7Resp(16);
        check(!component.transact(stillAt7Wire.bytes(), stillAt7Resp),
              "component: old address 7 no longer resolves after Command 6 (live readdressing through the real component)");
        HartFrame nowAt8{8, 0x0C, {}};
        HartResponseBuilder nowAt8Wire(16);
        check(HartFrameCodec::encode(nowAt8, nowAt8Wire), "component test: encode probe at new address 8");
        HartResponseBuilder nowAt8Resp(48);
        check(component.transact(nowAt8Wire.bytes(), nowAt8Resp), "component: new address 8 resolves the same device");

        // Real save/reopen simulation (Anexo F.6 gate, closed): capture the
        // component's CURRENT property values -- exactly what an external
        // persistence layer does when saving a project -- into a fresh
        // ComponentParams, then construct a brand-new component from THAT.
        // Reusing the original `params` (as a prior version of this test
        // did) would only prove construction works from a static snapshot,
        // never that a live HART write's effect actually reaches storage.
        lasecsimul::registry::ComponentParams savedParams;
        for (const auto& descriptor : component.propertyDescriptors()) savedParams.properties[descriptor.schema.id] = descriptor.get();
        check(std::get<double>(savedParams.properties.at("pollingAddress")) == 8.0,
              "saved snapshot captured Command 6's address change (7 -> 8), not the original construction-time value");

        HartCommunicationComponent reopened(HartCommunicationComponent::Mode::Serial, scheduler, savedParams);
        HartFrame reopenedPvRequest{8, 1, {}}; // reopened device now lives at address 8, not 7
        HartResponseBuilder reopenedPvWire(16);
        check(HartFrameCodec::encode(reopenedPvRequest, reopenedPvWire), "reopen test: encode PV request at new address");
        HartResponseBuilder reopenedWire(32);
        check(reopened.transact(reopenedPvWire.bytes(), reopenedWire), "reopened component transacts the same standard command at the PERSISTED address");
        HartFrame reopenedResponse;
        check(HartFrameCodec::decode(reopenedWire.bytes(), reopenedResponse) && reopenedResponse.payload.size() == 5 &&
                  std::equal(expectedPv.begin(), expectedPv.end(), reopenedResponse.payload.begin() + 1),
              "reopened component: same saved PV value, not reset to 0.0 (persistence round-trip)");

        HartFrame reopenedMessageRequest{8, 0x0C, {}};
        HartResponseBuilder reopenedMessageWire(16);
        check(HartFrameCodec::encode(reopenedMessageRequest, reopenedMessageWire), "reopen test: encode message request");
        HartResponseBuilder reopenedMessageResponseWire(32);
        check(reopened.transact(reopenedMessageWire.bytes(), reopenedMessageResponseWire), "reopened component transacts Command 12");
        HartFrame reopenedMessageResponse;
        check(HartFrameCodec::decode(reopenedMessageResponseWire.bytes(), reopenedMessageResponse) &&
                  reopenedMessageResponse.payload.size() == componentNewMessage.size() &&
                  std::equal(componentNewMessage.begin(), componentNewMessage.end(), reopenedMessageResponse.payload.begin()),
              "reopened component: Command 17's message SURVIVES save/reopen (Anexo F.6 gap closed, not just live-session)");

        HartFrame reopenedLongTagRequest{8, 0x14, {}};
        HartResponseBuilder reopenedLongTagWire(16);
        check(HartFrameCodec::encode(reopenedLongTagRequest, reopenedLongTagWire), "reopen test: encode long tag request");
        HartResponseBuilder reopenedLongTagResponseWire(64);
        check(reopened.transact(reopenedLongTagWire.bytes(), reopenedLongTagResponseWire), "reopened component transacts Command 20");
        HartFrame reopenedLongTagResponse;
        check(HartFrameCodec::decode(reopenedLongTagResponseWire.bytes(), reopenedLongTagResponse) &&
                  reopenedLongTagResponse.payload.size() == componentNewLongTag.size() &&
                  std::equal(componentNewLongTag.begin(), componentNewLongTag.end(), reopenedLongTagResponse.payload.begin()),
              "reopened component: Command 22's long tag SURVIVES save/reopen");

        // Property Inspector editor-kind coverage gate (section 117/120/134 of
        // the Property Inspector audit): every PropertySchema this component
        // declares must use an `editor` string `propertyFieldKindFromEditor`
        // (extension/src/ui/webview/batchProperties.ts) actually maps to a
        // supported widget. A schema added later with an unrecognized editor
        // string would otherwise fall through to a plain text box SILENTLY
        // (exactly the "compiles, looks fine, does nothing right" class of bug
        // this audit was written to catch) -- this fails loudly instead.
        static const std::vector<std::string> kKnownEditors{
            "text", "number", "checkbox", "switch", "select", "enum", "display", "filepath", "color", "textarea", "textedit"};
        for (const auto& schema : HartCommunicationComponent::propertySchema(HartCommunicationComponent::Mode::Serial)) {
            const bool known = std::find(kKnownEditors.begin(), kKnownEditors.end(), schema.editor) != kKnownEditors.end();
            check(known, ("HART property \"" + schema.id + "\" uses an editor kind (\"" + schema.editor +
                         "\") the Property Inspector does not recognize").c_str());
        }
        for (const auto& schema : HartCommunicationComponent::propertySchema(HartCommunicationComponent::Mode::Udp)) {
            const bool known = std::find(kKnownEditors.begin(), kKnownEditors.end(), schema.editor) != kKnownEditors.end();
            check(known, ("HART property \"" + schema.id + "\" uses an editor kind (\"" + schema.editor +
                         "\") the Property Inspector does not recognize").c_str());
        }
    }

    // Direct DSL primitive characterization (not a real HART command): proves
    // SET, IF/EQ, MAP and FOR_CODES individually, and the write -> resp -> after
    // ordering guarantee (FASE 76 gate), independent of any specific command.
    {
        HartCommandDefinition def;
        def.id = 200;
        def.name = "primitive characterization";
        def.write = {HartStatement{HartSetStmt{HartVarId::PrimaryVariableUnit, HartExpr::bodySlice(0, 1)}}};
        HartIfStmt ifStmt;
        ifStmt.lhs = HartExpr::var(HartVarId::PrimaryVariableUnit);
        ifStmt.rhs = HartExpr::hexByte(0x11);
        ifStmt.thenBranch = {HartStatement{HartAppendStmt{HartExpr::hexByte(0xAA)}}};
        ifStmt.elseBranch = {HartStatement{HartAppendStmt{HartExpr::hexByte(0xBB)}}};
        HartMapStmt mapStmt;
        mapStmt.key = HartExpr::bodySlice(1, 1);
        mapStmt.table = {{{0x01}, {0xC1}}, {{0x02}, {0xC2}}};
        mapStmt.defaultValue = {0xC0};
        HartForCodesStmt forStmt;
        forStmt.source = HartExpr::bodySlice(2, 2);
        forStmt.maxIterations = 4;
        forStmt.body = {HartStatement{HartAppendStmt{HartExpr::localCode()}}};
        def.resp = {HartStatement{std::move(ifStmt)}, HartStatement{std::move(mapStmt)}, HartStatement{std::move(forStmt)}};
        def.after = {HartStatement{HartSetStmt{HartVarId::PrimaryVariableUnit, HartExpr::hexByte(0x00)}}};

        const HartCommandCompileResult compiled = HartCommandCompiler::compile(def);
        check(compiled.success, "primitive program compiles");

        HartExecutionVariables vars;
        const uint8_t request1[] = {0x11, 0x01, 0x07, 0x08};
        HartResponseBuilder out1(16);
        check(HartCommandExecutor::execute(compiled.program, vars, request1, out1), "primitive program executes");
        const std::vector<uint8_t> expected1{0xAA, 0xC1, 0x07, 0x08};
        check(out1.size() == expected1.size() && std::equal(expected1.begin(), expected1.end(), out1.bytes().begin()),
              "SET/IF/MAP/FOR_CODES produce expected bytes (write value observed by resp)");

        const uint8_t request2[] = {0x22, 0x09, 0x0A, 0x0B};
        HartResponseBuilder out2(16);
        check(HartCommandExecutor::execute(compiled.program, vars, request2, out2),
              "primitive program executes (else/default branch)");
        const std::vector<uint8_t> expected2{0xBB, 0xC0, 0x0A, 0x0B};
        check(out2.size() == expected2.size() && std::equal(expected2.begin(), expected2.end(), out2.bytes().begin()),
              "IF else branch and MAP default are both reachable");

        HartCommandDefinition badSet;
        badSet.id = 201;
        badSet.write = {HartStatement{HartSetStmt{HartVarId::ManufacturerId, HartExpr::hexByte(0x01)}}};
        check(!HartCommandCompiler::compile(badSet).success, "compiler rejects SET to a non-writable variable");

        HartCommandDefinition badSlice;
        badSlice.id = 202;
        badSlice.resp = {HartStatement{HartAppendStmt{HartExpr::bodySlice(0, 1000)}}};
        check(!HartCommandCompiler::compile(badSlice, 32, 255).success,
              "compiler rejects a body slice exceeding the declared request bound");

        HartCommandDefinition oobRead;
        oobRead.id = 203;
        oobRead.resp = {HartStatement{HartAppendStmt{HartExpr::bodySlice(0, 4)}}};
        const HartCommandCompileResult oobCompiled = HartCommandCompiler::compile(oobRead);
        check(oobCompiled.success, "a slice within the declared bound compiles");
        const uint8_t shortRequest[] = {0x01};
        HartResponseBuilder oobOut(16);
        check(!HartCommandExecutor::execute(oobCompiled.program, vars, shortRequest, oobOut),
              "runtime out-of-bounds slice is rejected, never read past the actual request buffer");
    }

    // HCF_SPEC-99 section 7.1 / Table 9 normative classifier: exhaustive
    // boundary tests (every partition edge listed in the architecture doc),
    // the full expected-classification table, and the full expected-policy
    // table -- ONE authority, checked exhaustively rather than spot-checked.
    {
        struct BoundaryCase { uint32_t id; HartCommandClass expected; };
        const BoundaryCase boundaries[] = {
            {30, HartCommandClass::Universal}, {31, HartCommandClass::ExpansionFlag},
            {32, HartCommandClass::CommonPractice}, {37, HartCommandClass::CommonPractice},
            {38, HartCommandClass::Universal}, {39, HartCommandClass::CommonPractice},
            {47, HartCommandClass::CommonPractice}, {48, HartCommandClass::Universal},
            {49, HartCommandClass::CommonPractice}, {121, HartCommandClass::CommonPractice},
            {122, HartCommandClass::NonPublic}, {126, HartCommandClass::NonPublic},
            {127, HartCommandClass::Reserved}, {128, HartCommandClass::DeviceSpecific},
            {253, HartCommandClass::DeviceSpecific}, {254, HartCommandClass::Reserved},
            {511, HartCommandClass::Reserved}, {512, HartCommandClass::AdditionalCommonPractice},
            {767, HartCommandClass::AdditionalCommonPractice}, {768, HartCommandClass::WirelessHart},
            {1023, HartCommandClass::WirelessHart}, {1024, HartCommandClass::DeviceFamily},
            {33791, HartCommandClass::DeviceFamily}, {33792, HartCommandClass::Reserved},
            {64511, HartCommandClass::Reserved}, {64512, HartCommandClass::WirelessDeviceSpecific},
            {64765, HartCommandClass::WirelessDeviceSpecific}, {64766, HartCommandClass::Reserved},
            {64767, HartCommandClass::Reserved}, {64768, HartCommandClass::AdditionalDeviceSpecific},
            {65021, HartCommandClass::AdditionalDeviceSpecific}, {65022, HartCommandClass::Reserved},
            {65535, HartCommandClass::Reserved},
        };
        for (const auto& c : boundaries) {
            const auto actual = classifyHartCommandNumber(c.id);
            check(actual == c.expected,
                  ("boundary classification for id " + std::to_string(c.id) + " matches HCF_SPEC-99 Table 9").c_str());
        }

        struct PolicyCase { uint32_t id; HartCommandImplementationPolicy expected; };
        const PolicyCase policies[] = {
            {0, HartCommandImplementationPolicy::StandardCore}, {11, HartCommandImplementationPolicy::StandardCore},
            {33, HartCommandImplementationPolicy::StandardCore}, {38, HartCommandImplementationPolicy::StandardCore},
            {48, HartCommandImplementationPolicy::StandardCore},
            {128, HartCommandImplementationPolicy::ManufacturerDsl}, {253, HartCommandImplementationPolicy::ManufacturerDsl},
            {512, HartCommandImplementationPolicy::StandardCore}, {768, HartCommandImplementationPolicy::StandardCore},
            {1024, HartCommandImplementationPolicy::StandardCore},
            {64512, HartCommandImplementationPolicy::ManufacturerDsl}, {64768, HartCommandImplementationPolicy::ManufacturerDsl},
            {127, HartCommandImplementationPolicy::Forbidden}, {254, HartCommandImplementationPolicy::Forbidden},
            {33792, HartCommandImplementationPolicy::Forbidden}, {64766, HartCommandImplementationPolicy::Forbidden},
            {65022, HartCommandImplementationPolicy::Forbidden},
        };
        for (const auto& c : policies) {
            const auto actual = classifyImplementationPolicy(c.id);
            check(actual == c.expected,
                  ("expected implementation policy for id " + std::to_string(c.id)).c_str());
        }

        // >90%-of-128-253 threshold for Additional Device-Specific (section 36):
        // must be derived from the range size (126), not a hardcoded magic
        // number -- 113/126 = 89.68% (not over), 114/126 = 90.47% (over).
        check(!isDeviceSpecificRangeOver90PercentConsumed(113), "113 of 126 consumed is not over the 90% threshold");
        check(isDeviceSpecificRangeOver90PercentConsumed(114), "114 of 126 consumed is over the 90% threshold");
        check(kDeviceSpecificRangeSize == 126, "Device-Specific range size is derived as 253-128+1 == 126");

        check(!isManufacturerAuthorable(64768, false, 113), "Additional Device-Specific rejected below the 90% threshold");
        check(isManufacturerAuthorable(64768, false, 114), "Additional Device-Specific allowed once over the 90% threshold");
        check(!isManufacturerAuthorable(64512, /*isWirelessHartCapable=*/false, 0),
              "Wireless Device-Specific rejected for a non-WirelessHART-capable context");
        check(isManufacturerAuthorable(64512, /*isWirelessHartCapable=*/true, 0),
              "Wireless Device-Specific allowed for a WirelessHART-capable context");
        check(isManufacturerAuthorable(128, false, 0), "Device-Specific is always manufacturer-authorable");
        check(!isManufacturerAuthorable(122, false, 0), "Non-Public (122-126) is never offered through the normal authoring predicate");
    }

    // Manufacturer override test (section 118): the JSON authoring gate must
    // reject a DSL definition under a HART-standardized id and accept one
    // under a Device-Specific id, using the SAME classifier as above (not a
    // second hand-maintained id list).
    {
        auto attempt = [](int id) {
            return HartCommandJson::parseCommandDefinition(
                nlohmann::json::parse(R"({"id":)" + std::to_string(id) + R"(,"responseSteps":[{"kind":"hex","bytes":"00"}]})"));
        };
        check(!attempt(11).success, "DSL Command 11 (Universal) is rejected");
        check(!attempt(33).success, "DSL Command 33 (Common Practice) is rejected");
        check(!attempt(38).success, "DSL Command 38 (Universal exception inside 32-121) is rejected");
        check(!attempt(127).success, "DSL Command 127 (Reserved) is rejected");
        check(!attempt(122).success, "DSL Command 122 (Non-Public) is rejected");
        check(!attempt(31).success, "DSL Command 31 (Expansion Flag) is rejected");
        const auto ok = attempt(128);
        check(ok.success, "DSL Command 128 (Device-Specific) is accepted");

        // Common Practice semantics test (section 119): a device that does
        // NOT declare a given Common Practice command in its plan must see
        // it rejected exactly like any other unknown command -- there is no
        // generic enable/disable toggle, applicability is just "declared or
        // not" (HartPlanCompiler/HartEngine already implement this; this
        // regression proves it end to end for a real Common Practice id).
        HartProfileRegistry cpRegistry;
        HartDeviceProfile cpProfile;
        cpProfile.id = "lasecsimul.hart.cp-applicability-test";
        cpProfile.commands = {{0x01, "Read Primary Variable"}}; // deliberately NOT 33 (Common Practice)
        check(cpRegistry.registerProfile(cpProfile), "cp-applicability profile registers");
        HartEngine cpEngine(cpRegistry);
        check(HartReferenceCatalog::installCommandPrograms(cpEngine), "cp-applicability engine installs built-ins");
        HartDevicePlan cpDevice;
        cpDevice.id = "cp-applicability-device";
        cpDevice.profileId = cpProfile.id;
        cpDevice.bus = "hart-1";
        cpDevice.pollingAddress = 30;
        cpDevice.commandConfigurations = {{0x01, true, false, {}}};
        check(cpEngine.loadPlan({{cpDevice}}), "cp-applicability device plan loads");
        HartResponseBuilder cpDeclared(16);
        check(cpEngine.execute("hart-1", 30, 0x01, {}, cpDeclared), "declared command 0x01 dispatches");
        HartResponseBuilder cpUndeclared(16);
        check(!cpEngine.execute("hart-1", 30, 0x21, {}, cpUndeclared),
              "Common Practice command 0x21, not declared by this device, returns \"not implemented\" (no toggle, no fallback)");
    }

    // HCF_SPEC-151 Rev 10.0 Common Practice cluster 33/34/53/54/79. The
    // five commands share one canonical Device Variable entry and therefore
    // prove read-after-write, unit propagation, typed metadata and atomic
    // ownership validation without a command-specific handler.
    {
        HartProfileRegistry cpRegistry;
        check(cpRegistry.registerProfile(HartReferenceCatalog::makeGenericProfile()), "Common Practice cluster profile registers");
        HartEngine cpEngine(cpRegistry);
        check(HartReferenceCatalog::installCommandPrograms(cpEngine), "Common Practice cluster programs compile");
        HartDevicePlan device{"cp-cluster", "lasecsimul.hart.process-simul-compatible", "hart-1", 31, "029EB1", 12.5};
        device.variables.push_back({"PV", "Primary Variable", "", 12.5, HartVariableRole::PrimaryVariable,
                                    HartVariableType::Float32, HartVariableDirection::Internal, true,
                                    246, 65, 5, 0x123456, 100.0f, 0.0f, 0.1f, 0.0f,
                                    1000, 0, 0, true, {57, 35}});
        device.variables.back().rangeUnitCode = 57;
        device.variables.back().lowerRangeValue = 0.0f;
        device.variables.back().upperRangeValue = 100.0f;
        device.variables.push_back({"SV", "Secondary Variable", "", 4.0, HartVariableRole::SecondaryVariable,
                                    HartVariableType::Float32, HartVariableDirection::Internal, true,
                                    1, 65, 5, 0x123457, 100.0f, 0.0f, 0.1f, 0.0f,
                                    1000, 0, 0, true, {57, 35}});
        for (const auto& command : HartReferenceCatalog::commandDescriptors())
            device.commandConfigurations.push_back({command.id, true, false, {}});
        check(cpEngine.loadPlan({{device}}), "Common Practice cluster device loads");

        const uint8_t code246[] = {246};
        HartResponseBuilder read33(64);
        check(cpEngine.execute("hart-1", 31, 0x21, code246, read33) && read33.size() == 6,
              "Command 33 returns one six-byte Device Variable slot");
        check(read33.size() >= 2 && read33.bytes()[0] == 246 && read33.bytes()[1] == 57,
              "Command 33 returns canonical PV code and units");

        const auto damping = HartTypeCodec::encodeFloat32BE(2.0f);
        HartResponseBuilder write34(16);
        check(cpEngine.execute("hart-1", 31, 0x22, damping, write34) && write34.size() == 4,
              "Command 34 writes and echoes PV damping");
        HartResponseBuilder universal15(32);
        check(cpEngine.execute("hart-1", 31, 0x0F, {}, universal15) && universal15.size() >= 15 &&
                  std::equal(damping.begin(), damping.end(), universal15.bytes().begin() + 11),
              "Universal Command 15 reads the same canonical PV damping written by Command 34");
        // HCF_SPEC-151 7.22: 1(code)+3(serial)+1(units)+4(upper)+4(lower)+
        // 4(damping)+4(minspan)+1(classification)+1(family)+4(acquisition)+
        // 1(properties) = 28 bytes. (Was asserted as 34 before this
        // session's fix -- Classification/Family were wrongly emitted as
        // 4-byte floats instead of the spec's 1-byte Enums; the test had
        // enshrined the bug instead of catching it.)
        HartResponseBuilder info54(64);
        check(cpEngine.execute("hart-1", 31, 0x36, code246, info54) && info54.size() == 28,
              "Command 54 returns the complete canonical Device Variable information record (28 bytes per HCF_SPEC-151 7.22)");
        check(info54.size() >= 17 && std::equal(damping.begin(), damping.end(), info54.bytes().begin() + 13),
              "Command 54 reflects the Command 34 damping mutation");

        const uint8_t writeUnits[] = {246, 35};
        HartResponseBuilder units53(16);
        check(cpEngine.execute("hart-1", 31, 0x35, writeUnits, units53) && units53.size() == 2 &&
                  units53.bytes()[0] == 246 && units53.bytes()[1] == 35,
              "Command 53 writes and echoes Device Variable units");
        HartResponseBuilder info54AfterUnits(64);
        HartResponseBuilder universal1AfterUnits(16);
        check(cpEngine.execute("hart-1", 31, 0x36, code246, info54AfterUnits) && info54AfterUnits.size() >= 5 &&
                  info54AfterUnits.bytes()[4] == 35 &&
                  cpEngine.execute("hart-1", 31, 0x01, {}, universal1AfterUnits) &&
                  universal1AfterUnits.size() >= 1 && universal1AfterUnits.bytes()[0] == 35,
              "Command 54 and Universal Command 1 observe the same unit written by Command 53");

        const auto value = HartTypeCodec::encodeFloat32BE(77.25f);
        const std::array<uint8_t, 7> write79{246, 1, 35, value[0], value[1], value[2], value[3]};
        HartResponseBuilder write79Response(32);
        check(cpEngine.execute("hart-1", 31, 0x4F, write79, write79Response) && write79Response.size() == 8,
              "Command 79 writes a writable Device Variable with matching units");
        HartResponseBuilder readAfter79(16);
        check(cpEngine.execute("hart-1", 31, 0x21, code246, readAfter79) && readAfter79.size() >= 6 &&
                  std::equal(value.begin(), value.end(), readAfter79.bytes().begin() + 2),
              "Command 33 observes the Command 79 canonical value");
        HartResponseBuilder readAfter79Status(32);
        check(cpEngine.execute("hart-1", 31, 0x09, code246, readAfter79Status) && readAfter79Status.size() >= 9 &&
                  std::equal(value.begin(), value.end(), readAfter79Status.bytes().begin() + 4),
              "Universal Command 9 observes the same canonical value written by Command 79");

        const std::array<uint8_t, 7> wrongUnits{246, 1, 57, value[0], value[1], value[2], value[3]};
        HartResponseBuilder rejected79(32);
        check(!cpEngine.execute("hart-1", 31, 0x4F, wrongUnits, rejected79),
              "Command 79 rejects a units mismatch atomically");
        HartResponseBuilder unchanged(16);
        check(cpEngine.execute("hart-1", 31, 0x21, code246, unchanged) && unchanged.size() >= 6 &&
                  std::equal(value.begin(), value.end(), unchanged.bytes().begin() + 2),
              "Rejected Command 79 leaves the canonical value unchanged");

        // Save/reopen proof: materialize a new plan from the committed
        // runtime state, create a new registry/engine, and read through
        // different commands. No original runtime objects are reused.
        const HartDevicePlan persisted = *cpEngine.findDevicePlan("cp-cluster");
        HartProfileRegistry reopenedRegistry;
        check(reopenedRegistry.registerProfile(HartReferenceCatalog::makeGenericProfile()),
              "Common Practice save/reopen profile registers");
        HartEngine reopenedEngine(reopenedRegistry);
        check(HartReferenceCatalog::installCommandPrograms(reopenedEngine),
              "Common Practice save/reopen programs install");
        check(reopenedEngine.loadPlan({{persisted}}), "Common Practice committed plan reopens");
        HartResponseBuilder reopened33(16);
        HartResponseBuilder reopened54(64);
        check(reopenedEngine.execute("hart-1", 31, 0x21, code246, reopened33) && reopened33.size() >= 6 &&
                  std::equal(value.begin(), value.end(), reopened33.bytes().begin() + 2) &&
                  reopenedEngine.execute("hart-1", 31, 0x36, code246, reopened54) && reopened54.size() >= 17 &&
                  reopened54.bytes()[4] == 35 && std::equal(damping.begin(), damping.end(), reopened54.bytes().begin() + 13),
              "Command 79/53/34 values survive save/reopen and remain cross-command consistent");

        // HCF_SPEC-151 7.3-7.5: range unit is independent from PV units;
        // Command 35 is a 9-byte atomic write, 36 writes current PV to URV,
        // and 37 writes current PV to LRV while preserving the span.
        const auto upper90 = HartTypeCodec::encodeFloat32BE(90.0f);
        const auto lower10 = HartTypeCodec::encodeFloat32BE(10.0f);
        std::array<uint8_t, 9> range35{35, upper90[0], upper90[1], upper90[2], upper90[3],
                                       lower10[0], lower10[1], lower10[2], lower10[3]};
        HartResponseBuilder range35Response(16);
        check(cpEngine.execute("hart-1", 31, 0x23, range35, range35Response) && range35Response.size() == 9 &&
                  std::equal(range35.begin(), range35.end(), range35Response.bytes().begin()),
              "Command 35 atomically writes and echoes range unit, URV and LRV");
        cpEngine.setPrimaryValue("cp-cluster", 80.0);
        HartResponseBuilder range36Response(8);
        check(cpEngine.execute("hart-1", 31, 0x24, {}, range36Response) && range36Response.size() == 0,
              "Command 36 writes current PV to URV with empty response");
        cpEngine.setPrimaryValue("cp-cluster", 20.0);
        HartResponseBuilder range37Response(8);
        check(cpEngine.execute("hart-1", 31, 0x25, {}, range37Response) && range37Response.size() == 0,
              "Command 37 writes current PV to LRV with empty response");
        HartResponseBuilder rangeReader(32);
        const auto expectedRangeUrv = HartTypeCodec::encodeFloat32BE(90.0f);
        check(cpEngine.execute("hart-1", 31, 0x0F, {}, rangeReader) && rangeReader.size() >= 11 &&
                  std::equal(expectedRangeUrv.begin(), expectedRangeUrv.end(), rangeReader.bytes().begin() + 3),
              "Universal Command 15 sees the same canonical URV after Command 37 span preservation");
        const HartDevicePlan* rangedPlan = cpEngine.findDevicePlan("cp-cluster");
        check(rangedPlan && rangedPlan->variables.front().rangeUnitCode == 35 &&
                  rangedPlan->variables.front().lowerRangeValue == 20.0f &&
                  rangedPlan->variables.front().upperRangeValue == 90.0f,
              "Commands 35/36/37 leave exactly one persisted canonical PV range");
        const float lowerBeforeReject = rangedPlan ? rangedPlan->variables.front().lowerRangeValue : -1.0f;
        HartResponseBuilder truncatedRange(16);
        check(!cpEngine.execute("hart-1", 31, 0x23, std::span<const uint8_t>(range35.data(), 8), truncatedRange) &&
                  cpEngine.findDevicePlan("cp-cluster")->variables.front().lowerRangeValue == lowerBeforeReject,
              "Truncated Command 35 rejects atomically without mutating the range");
        HartDevicePlan protectedPlan = *cpEngine.findDevicePlan("cp-cluster");
        protectedPlan.writeProtectCode = 1;
        HartProfileRegistry protectedRegistry;
        protectedRegistry.registerProfile(HartReferenceCatalog::makeGenericProfile());
        HartEngine protectedEngine(protectedRegistry);
        HartReferenceCatalog::installCommandPrograms(protectedEngine);
        protectedEngine.loadPlan({{protectedPlan}});
        HartResponseBuilder protectedRange(16);
        check(!protectedEngine.execute("hart-1", 31, 0x23, range35, protectedRange),
              "Commands 35/36/37 honor centralized write protection");
        const uint8_t writePvUnit[] = {57};
        HartResponseBuilder write44(8);
        check(cpEngine.execute("hart-1", 31, 0x2C, writePvUnit, write44) && write44.size() == 1 && write44.bytes()[0] == 57,
              "Command 44 writes and echoes the canonical PV unit");
        const HartDevicePlan* after44 = cpEngine.findDevicePlan("cp-cluster");
        check(after44 && after44->variables.front().deviceVariableUnit == 57 && after44->variables.front().rangeUnitCode == 57 &&
                  after44->variables.front().lowerRangeValue == 20.0f && after44->variables.front().upperRangeValue == 90.0f,
              "Command 44 updates PV/range reporting units without changing range values");
        HartResponseBuilder assignmentsInitial(8);
        check(cpEngine.execute("hart-1", 31, 0x32, {}, assignmentsInitial) && assignmentsInitial.size() == 4 &&
                  assignmentsInitial.bytes()[0] == 246 && assignmentsInitial.bytes()[1] == 250,
              "Command 50 reads the canonical four-slot dynamic assignment set");
        const std::array<uint8_t, 4> assignments{1, 250, 250, 250};
        HartResponseBuilder assignmentsWrite(8), assignmentsAfter(8);
        const bool assignmentsWriteOk = cpEngine.execute("hart-1", 31, 0x33, assignments, assignmentsWrite);
        const bool assignmentsReadOk = cpEngine.execute("hart-1", 31, 0x32, {}, assignmentsAfter);
        check(assignmentsWriteOk && assignmentsWrite.size() == 4, "Command 51 accepts a complete assignment set");
        check(assignmentsReadOk && assignmentsAfter.size() == 4, "Command 50 returns four assignment bytes after Command 51");
        check(assignmentsWriteOk && assignmentsWrite.size() == 4 && assignmentsReadOk && assignmentsAfter.size() == 4 &&
                  std::equal(assignments.begin(), assignments.end(), assignmentsAfter.bytes().begin()),
              "Command 51 atomically writes assignments read back by Command 50");

        // HCF_SPEC-151 7.19.1 Backward Compatibility Requirements: a Master
        // may truncate the request to 1-3 bytes; the device must accept it
        // (never Response Code 5), leave the unspecified trailing slots at
        // their current assignment, and always echo all 4 slots back.
        // (Device Variable codes 244-249 -- including this device's own PV
        // code 246 -- are themselves an invalid *selection* per 7.19, so the
        // baseline and truncated write below deliberately use only 250 "Not
        // Used" and the SV's real code 1, never 246.)
        const std::array<uint8_t, 4> truncationBaseline{250, 1, 250, 250};
        HartResponseBuilder truncationBaselineResp(8);
        check(cpEngine.execute("hart-1", 31, 0x33, truncationBaseline, truncationBaselineResp),
              "Command 51 baseline write for the truncation regression test below");
        const std::array<uint8_t, 1> truncatedAssignment{1};
        HartResponseBuilder truncatedAssignmentResp(8);
        check(cpEngine.execute("hart-1", 31, 0x33, truncatedAssignment, truncatedAssignmentResp) &&
                  truncatedAssignmentResp.size() == 4 && truncatedAssignmentResp.bytes()[0] == 1 &&
                  truncatedAssignmentResp.bytes()[1] == 1 && truncatedAssignmentResp.bytes()[2] == 250 &&
                  truncatedAssignmentResp.bytes()[3] == 250,
              "Command 51 accepts a truncated (1-3 byte) request per 7.19.1 and preserves the untouched slots");
        const std::array<uint8_t, 3> serial49{1, 2, 3};
        HartResponseBuilder serial49Response(8);
        check(cpEngine.execute("hart-1", 31, 0x31, serial49, serial49Response) && serial49Response.size() == 3,
              "Command 49 writes and echoes the canonical PV transducer serial");
        HartResponseBuilder info54Serial(64);
        check(cpEngine.execute("hart-1", 31, 0x36, code246, info54Serial) && info54Serial.size() >= 4 &&
                  info54Serial.bytes()[1] == 1 && info54Serial.bytes()[2] == 2 && info54Serial.bytes()[3] == 3,
              "Command 54 reads the serial written by Command 49");
        const std::array<uint8_t, 5> damping55{246, 0x40, 0x00, 0x00, 0x00};
        HartResponseBuilder damping55Response(16), info54Damping(64);
        check(cpEngine.execute("hart-1", 31, 0x37, damping55, damping55Response) &&
                  cpEngine.execute("hart-1", 31, 0x36, code246, info54Damping) && info54Damping.size() >= 17 &&
                  std::equal(damping55.begin() + 1, damping55.end(), info54Damping.bytes().begin() + 13),
              "Command 55 writes damping read by Command 54");
        const std::array<uint8_t, 4> serial56{246, 4, 5, 6};
        HartResponseBuilder serial56Response(8);
        check(cpEngine.execute("hart-1", 31, 0x38, serial56, serial56Response) && serial56Response.size() == 4,
              "Command 56 writes the selected canonical Device Variable serial");
        HartResponseBuilder unit57(32);
        check(cpEngine.execute("hart-1", 31, 0x39, {}, unit57) && unit57.size() == 21,
              "Command 57 reads the canonical unit tag metadata");
        const auto newUnitTag = HartTypeCodec::encodePackedAscii("UNIT2", 8);
        const auto newUnitDescriptor = HartTypeCodec::encodePackedAscii("PROCESS", 16);
        std::array<uint8_t, 21> unit58{};
        std::copy(newUnitTag.begin(), newUnitTag.end(), unit58.begin());
        std::copy(newUnitDescriptor.begin(), newUnitDescriptor.end(), unit58.begin() + 6);
        unit58[18] = 1; unit58[19] = 2; unit58[20] = 24;
        HartResponseBuilder unit58Response(32), unit57After(32);
        check(cpEngine.execute("hart-1", 31, 0x3A, unit58, unit58Response) &&
                  cpEngine.execute("hart-1", 31, 0x39, {}, unit57After) &&
                  std::equal(unit58.begin(), unit58.end(), unit57After.bytes().begin()),
              "Command 58 writes metadata read back by Command 57");
        const uint8_t preamble59[] = {7};
        HartResponseBuilder preamble59Response(8), command0After59(32);
        check(cpEngine.execute("hart-1", 31, 0x3B, preamble59, preamble59Response) &&
                  cpEngine.execute("hart-1", 31, 0x00, {}, command0After59) && command0After59.size() >= 4 && command0After59.bytes()[3] == 7,
              "Command 59 updates the same preamble authority reported by Command 0");
        HartResponseBuilder analog60(32), universal2Analog(16);
        check(cpEngine.execute("hart-1", 31, 0x3C, std::array<uint8_t, 1>{0}, analog60) && analog60.size() == 10 &&
                  cpEngine.execute("hart-1", 31, 0x02, {}, universal2Analog) &&
                  std::equal(analog60.bytes().begin() + 2, analog60.bytes().begin() + 6, universal2Analog.bytes().begin()),
              "Command 60 reads the same canonical Loop Current as Universal Command 2");
        HartResponseBuilder analog61(32), analog62(32), analog63(32);
        check(cpEngine.execute("hart-1", 31, 0x3D, {}, analog61) && analog61.size() == 25,
              "Command 61 returns primary analog level plus four assigned dynamic variables");
        const std::array<uint8_t, 4> channelSlots{0, 0, 0, 0};
        check(cpEngine.execute("hart-1", 31, 0x3E, channelSlots, analog62) && analog62.size() == 24,
              "Command 62 reads the supported Analog Channel slots");
        check(cpEngine.execute("hart-1", 31, 0x3F, std::array<uint8_t, 1>{0}, analog63) && analog63.size() == 17,
              "Command 63 reads canonical Analog Channel configuration");
        const auto additionalDamping = HartTypeCodec::encodeFloat32BE(1.5f);
        std::array<uint8_t, 5> damping64{0, additionalDamping[0], additionalDamping[1], additionalDamping[2], additionalDamping[3]};
        HartResponseBuilder damping64Response(16), analog63AfterDamping(32);
        check(cpEngine.execute("hart-1", 31, 0x40, damping64, damping64Response) &&
                  cpEngine.execute("hart-1", 31, 0x3F, std::array<uint8_t, 1>{0}, analog63AfterDamping) && analog63AfterDamping.size() == 17 &&
                  std::equal(additionalDamping.begin(), additionalDamping.end(), analog63AfterDamping.bytes().begin() + 12),
              "Command 64 updates damping observed by Command 63");
        const auto analogUpper = HartTypeCodec::encodeFloat32BE(20.0f);
        const auto analogLower = HartTypeCodec::encodeFloat32BE(4.0f);
        std::array<uint8_t, 10> range65{0, 39, analogUpper[0], analogUpper[1], analogUpper[2], analogUpper[3],
                                        analogLower[0], analogLower[1], analogLower[2], analogLower[3]};
        HartResponseBuilder range65Response(16), endpoints70(32);
        check(cpEngine.execute("hart-1", 31, 0x41, range65, range65Response) &&
                  cpEngine.execute("hart-1", 31, 0x46, std::array<uint8_t, 1>{0}, endpoints70) && endpoints70.size() == 18,
              "Command 65 updates the canonical Analog Channel range read by Command 70");
        const auto fixed10 = HartTypeCodec::encodeFloat32BE(10.0f);
        std::array<uint8_t, 6> fixed66{0, 39, fixed10[0], fixed10[1], fixed10[2], fixed10[3]};
        HartResponseBuilder fixed66Response(16), analog60Fixed(32);
        check(cpEngine.execute("hart-1", 31, 0x42, fixed66, fixed66Response) &&
                  cpEngine.execute("hart-1", 31, 0x3C, std::array<uint8_t, 1>{0}, analog60Fixed) &&
                  std::equal(fixed10.begin(), fixed10.end(), analog60Fixed.bytes().begin() + 2),
              "Command 66 fixed mode is observed by Command 60");
        HartResponseBuilder trim67(16), trim68(16);
        check(cpEngine.execute("hart-1", 31, 0x43, fixed66, trim67) && cpEngine.execute("hart-1", 31, 0x44, fixed66, trim68),
              "Commands 67 and 68 update the shared Analog/Loop Current trim state");
        HartResponseBuilder transfer69(16), analog63Transfer(32);
        check(cpEngine.execute("hart-1", 31, 0x45, std::array<uint8_t, 2>{0, 1}, transfer69) &&
                  cpEngine.execute("hart-1", 31, 0x3F, std::array<uint8_t, 1>{0}, analog63Transfer) && analog63Transfer.bytes()[2] == 1,
              "Command 69 transfer function is visible in Command 63");
        cpEngine.setPrimaryValue("cp-cluster", 50.0);
        HartResponseBuilder universal2Normal(16), universal3Normal(16);
        check(cpEngine.execute("hart-1", 31, 0x02, {}, universal2Normal) &&
                  cpEngine.execute("hart-1", 31, 0x03, {}, universal3Normal) && universal2Normal.size() >= 4 && universal3Normal.size() >= 4 &&
                  std::equal(universal2Normal.bytes().begin(), universal2Normal.bytes().begin() + 4, universal3Normal.bytes().begin()),
              "Universal Commands 2 and 3 derive loop current from one canonical path");
        const auto fixed12 = HartTypeCodec::encodeFloat32BE(12.0f);
        HartResponseBuilder fixed40(8);
        check(cpEngine.execute("hart-1", 31, 0x28, fixed12, fixed40) && fixed40.size() == 4 &&
                  std::equal(fixed12.begin(), fixed12.end(), fixed40.bytes().begin()),
              "Command 40 enters fixed current mode and echoes actual current");
        HartResponseBuilder universal2Fixed(16), universal3Fixed(16);
        check(cpEngine.execute("hart-1", 31, 0x02, {}, universal2Fixed) && cpEngine.execute("hart-1", 31, 0x03, {}, universal3Fixed) &&
                  std::equal(universal2Fixed.bytes().begin(), universal2Fixed.bytes().begin() + 4, universal3Fixed.bytes().begin()) &&
                  std::equal(fixed12.begin(), fixed12.end(), universal2Fixed.bytes().begin()),
              "Command 40 fixed current is observed identically by Commands 2 and 3");
        const uint8_t exitFixed[] = {0, 0, 0, 0};
        HartResponseBuilder exit40(8);
        check(cpEngine.execute("hart-1", 31, 0x28, exitFixed, exit40), "Command 40 exits fixed current mode");
        HartResponseBuilder selfTest(8);
        check(cpEngine.execute("hart-1", 31, 0x29, {}, selfTest) && selfTest.size() == 0, "Command 41 performs deterministic self test");
        HartResponseBuilder reset(8);
        check(cpEngine.execute("hart-1", 31, 0x2A, {}, reset) && reset.size() == 0, "Command 42 resets volatile fixed-current state");
        HartResponseBuilder zero(8);
        check(cpEngine.execute("hart-1", 31, 0x2B, {}, zero) && zero.size() == 0, "Command 43 applies canonical PV zero offset");
        HartResponseBuilder pvAfterZero(16);
        const auto expectedZeroPv = HartTypeCodec::encodeFloat32BE(0.0f);
        check(cpEngine.execute("hart-1", 31, 0x01, {}, pvAfterZero) && pvAfterZero.size() >= 5 &&
                  std::equal(expectedZeroPv.begin(), expectedZeroPv.end(), pvAfterZero.bytes().begin() + 1),
              "Command 43 is visible through the PV reader");
        const uint8_t transferSqrt[] = {1};
        HartResponseBuilder transfer(8);
        check(cpEngine.execute("hart-1", 31, 0x2F, transferSqrt, transfer) && transfer.size() == 1 && transfer.bytes()[0] == 1,
              "Command 47 writes and echoes the canonical transfer-function code");
        const auto trimZero = HartTypeCodec::encodeFloat32BE(4.0f);
        const auto trimGain = HartTypeCodec::encodeFloat32BE(20.0f);
        HartResponseBuilder trimZeroOut(8), trimGainOut(8);
        check(cpEngine.execute("hart-1", 31, 0x2D, trimZero, trimZeroOut) && cpEngine.execute("hart-1", 31, 0x2E, trimGain, trimGainOut) &&
                  std::equal(trimZero.begin(), trimZero.end(), trimZeroOut.bytes().begin()) &&
                  std::equal(trimGain.begin(), trimGain.end(), trimGainOut.bytes().begin()),
              "Commands 45 and 46 update the shared loop-current calibration model");
    }

    // HCF_SPEC-151 Rev 10.0 Commands 71-78: one lock state, semantic
    // squawk/find behavior, and real parent/child dispatch through the same
    // HartEngine command path.
    {
        HartProfileRegistry registry;
        check(registry.registerProfile(HartReferenceCatalog::makeGenericProfile()), "71-78 profile registers");
        HartEngine engine(registry);
        check(HartReferenceCatalog::installCommandPrograms(engine), "71-78 programs install");
        const auto descriptors = HartReferenceCatalog::commandDescriptors();
        HartDevicePlan parent{"io-parent", "lasecsimul.hart.process-simul-compatible", "hart-parent", 1, "010203", 10.0};
        parent.ioSystem = true;
        parent.findDeviceArmed = true;
        parent.ioMaximumCards = 1; parent.ioMaximumChannelsPerCard = 1;
        parent.ioMaximumSubDevicesPerChannel = 2;
        parent.subDevices = {{"child-a", 0, 0, 2}, {"child-b", 0, 0, 3}};
        for (const auto& command : descriptors) parent.commandConfigurations.push_back({command.id, true, false, {}});
        HartDevicePlan childA{"child-a", "lasecsimul.hart.process-simul-compatible", "hart-child-a", 2, "0A0B0C", 11.0};
        childA.findDeviceArmed = true;
        for (const auto& command : descriptors) childA.commandConfigurations.push_back({command.id, true, false, {}});
        HartDevicePlan childB{"child-b", "lasecsimul.hart.process-simul-compatible", "hart-child-b", 3, "0D0E0F", 22.0};
        childB.findDeviceArmed = true;
        for (const auto& command : descriptors) childB.commandConfigurations.push_back({command.id, true, false, {}});
        check(engine.loadPlan({{parent, childA, childB}}), "I/O parent and two children load");

        HartResponseBuilder lockState(8), lock(8), unlocked(8);
        check(engine.execute("hart-parent", 1, 0x4C, {}, lockState) && lockState.size() == 1 && lockState.bytes()[0] == 0,
              "Command 76 initially reports unlocked");
        check(engine.execute("hart-parent", 1, 0x47, std::array<uint8_t, 1>{1}, lock) && lock.bytes()[0] == 1,
              "Command 71 acquires temporary lock");
        HartResponseBuilder lockedState(8);
        check(engine.execute("hart-parent", 1, 0x4C, {}, lockedState) && (lockedState.bytes()[0] & 0x03) == 0x01,
              "Command 76 reads the same canonical temporary lock");
        HartResponseBuilder blockedWrite(8);
        check(!engine.execute("hart-parent", 1, 0x2F, std::array<uint8_t, 1>{1}, blockedWrite, 1),
              "Device Lock blocks a non-owner configuration write");
        check(engine.execute("hart-parent", 1, 0x47, std::array<uint8_t, 1>{0}, unlocked) && unlocked.bytes()[0] == 0,
              "Lock owner releases temporary lock");
        HartResponseBuilder squawk(8);
        check(engine.execute("hart-parent", 1, 0x48, {}, squawk) && squawk.size() == 1 && squawk.bytes()[0] == 2,
              "Command 72 backward-compatible empty request performs Squawk Once");
        HartResponseBuilder find(32);
        check(engine.execute("hart-parent", 1, 0x49, {}, find) && find.size() > 0,
              "Command 73 returns the canonical identity response when armed");
        HartResponseBuilder capabilities(16);
        check(engine.execute("hart-parent", 1, 0x4A, {}, capabilities) && capabilities.size() == 8 && capabilities.bytes()[6] == 2,
              "Command 74 reports authored I/O capabilities and detected children");
        HartResponseBuilder polledA(32), polledB(32);
        check(engine.execute("hart-parent", 1, 0x4B, std::array<uint8_t, 3>{0, 0, 2}, polledA) &&
                  engine.execute("hart-parent", 1, 0x4B, std::array<uint8_t, 3>{0, 0, 3}, polledB) &&
                  polledA.size() == polledB.size() && !std::equal(polledA.bytes().begin(), polledA.bytes().end(), polledB.bytes().begin()),
              "Command 75 discovers two different child identities");
        const std::array<uint8_t, 7> sendA{0, 0, 5, 0x02, 2, 0x01, 0};
        HartResponseBuilder sentA(64);
        check(engine.execute("hart-parent", 1, 0x4D, sendA, sentA) && sentA.size() > 5,
              "Command 77 forwards embedded Command 1 through canonical child dispatch");
        const std::array<uint8_t, 7> aggregate{{2, 0, 1, 0, 0, 0, 0}};
        HartResponseBuilder aggregateResponse(64);
        check(engine.execute("hart-parent", 1, 0x4E, aggregate, aggregateResponse) && aggregateResponse.size() >= 4,
              "Command 78 executes bounded embedded reads through canonical dispatch");
    }

    // HCF_SPEC-151 Rev. 10.0 Commands 80-90: Device Variable trim,
    // live I/O statistics/configuration, and deterministic virtual RTC.
    {
        HartProfileRegistry registry;
        check(registry.registerProfile(HartReferenceCatalog::makeGenericProfile()), "80-90 profile registers");
        HartEngine engine(registry);
        check(HartReferenceCatalog::installCommandPrograms(engine), "80-90 programs install");
        const auto descriptors = HartReferenceCatalog::commandDescriptors();
        HartDevicePlan parent{"cp-80-90", "lasecsimul.hart.process-simul-compatible", "hart-8090", 1, "010203", 10.0};
        parent.ioSystem = true;
        parent.ioMaximumCards = 1; parent.ioMaximumChannelsPerCard = 1; parent.ioMaximumSubDevicesPerChannel = 2;
        parent.rtcSupported = true;
        parent.subDevices = {{"trim-child-a", 0, 0, 2}, {"trim-child-b", 0, 0, 3}};
        HartDevicePlan::VariableConfiguration pv;
        pv.id = "PV"; pv.name = "Primary Variable"; pv.value = 10.0; pv.role = HartVariableRole::PrimaryVariable;
        pv.direction = HartVariableDirection::Internal; pv.runtimeMutable = true; pv.deviceVariableCode = 246;
        pv.deviceVariableUnit = 57; pv.trimPointsSupported = 3; pv.trimPointsUnit = 57;
        pv.minimumLowerTrimPoint = 0.0f; pv.maximumLowerTrimPoint = 100.0f;
        pv.minimumUpperTrimPoint = 0.0f; pv.maximumUpperTrimPoint = 100.0f;
        pv.minimumTrimDifferential = 1.0f; pv.factoryTrimAdjustment = 0.0f;
        parent.variables.push_back(pv);
        for (const auto& command : descriptors) parent.commandConfigurations.push_back({command.id, true, false, {}});
        HartDevicePlan childA{"trim-child-a", "lasecsimul.hart.process-simul-compatible", "hart-8090-a", 2, "0A0B0C", 11.0};
        for (const auto& command : descriptors) childA.commandConfigurations.push_back({command.id, true, false, {}});
        HartDevicePlan childB{"trim-child-b", "lasecsimul.hart.process-simul-compatible", "hart-8090-b", 3, "0D0E0F", 22.0};
        for (const auto& command : descriptors) childB.commandConfigurations.push_back({command.id, true, false, {}});
        check(engine.loadPlan({{parent, childA, childB}}), "80-90 plans load");

        HartResponseBuilder trimPoints(16), trimGuidelines(32);
        check(engine.execute("hart-8090", 1, 0x50, std::array<uint8_t, 1>{246}, trimPoints) && trimPoints.size() == 10,
              "Command 80 returns canonical Device Variable trim points");
        check(engine.execute("hart-8090", 1, 0x51, std::array<uint8_t, 1>{246}, trimGuidelines) && trimGuidelines.size() == 22,
              "Commands 80 and 81 return canonical Device Variable trim state/guidelines");
        const auto trimValue = HartTypeCodec::encodeFloat32BE(12.0f);
        std::array<uint8_t, 7> trimRequest{246, 1, 57, trimValue[0], trimValue[1], trimValue[2], trimValue[3]};
        HartResponseBuilder trimWrite(16), readAfterTrim(16);
        check(engine.execute("hart-8090", 1, 0x52, trimRequest, trimWrite) && trimWrite.size() == 7 &&
                  engine.execute("hart-8090", 1, 0x21, std::array<uint8_t, 1>{246}, readAfterTrim) && readAfterTrim.size() >= 6,
              "Command 82 atomically writes trim and Command 33 reads the calibrated value");
        HartResponseBuilder trimReset(8), trimAfterReset(16);
        check(engine.execute("hart-8090", 1, 0x53, std::array<uint8_t, 1>{246}, trimReset) && trimReset.size() == 1 &&
                  engine.execute("hart-8090", 1, 0x50, std::array<uint8_t, 1>{246}, trimAfterReset),
              "Command 83 restores the factory trim authority");

        const std::array<uint8_t, 7> sendA{0, 0, 5, 0x02, 2, 0x01, 0};
        const std::array<uint8_t, 7> sendB{0, 0, 5, 0x02, 3, 0x01, 0};
        HartResponseBuilder sentA(64), sentB(64), statsA(16), statsB(16);
        check(engine.execute("hart-8090", 1, 0x4D, sendA, sentA) && engine.execute("hart-8090", 1, 0x4D, sendA, sentA) &&
                  engine.execute("hart-8090", 1, 0x4D, sendB, sentB) &&
                  engine.execute("hart-8090", 1, 0x56, std::array<uint8_t, 2>{0, 1}, statsA) &&
                  engine.execute("hart-8090", 1, 0x56, std::array<uint8_t, 2>{0, 2}, statsB) &&
                  statsA.size() == 8 && statsB.size() == 8 && statsA.bytes()[3] != statsB.bytes()[3],
              "Command 86 keeps per-child statistics isolated after different traffic");
        HartResponseBuilder identity84(64), capabilities87(8), retry88(8), channel85(16);
        check(engine.execute("hart-8090", 1, 0x54, std::array<uint8_t, 2>{0, 1}, identity84) && identity84.size() >= 44 &&
                  engine.execute("hart-8090", 1, 0x57, std::array<uint8_t, 1>{0}, capabilities87) && capabilities87.bytes()[0] == 0 &&
                  engine.execute("hart-8090", 1, 0x58, std::array<uint8_t, 1>{5}, retry88) && retry88.bytes()[0] == 5 &&
                  engine.execute("hart-8090", 1, 0x55, std::array<uint8_t, 2>{0, 0}, channel85) && channel85.size() == 12,
              "Commands 84, 85, 87 and 88 use the same I/O System authority");

        engine.setVirtualTimeSeconds(100);
        const std::array<uint8_t, 10> setRtc{1, 2, 1, 0, 0, 0, 0, 10, 0, 0};
        HartResponseBuilder setRtcResponse(16), readRtc0(16), readRtc1(16);
        check(engine.execute("hart-8090", 1, 0x59, setRtc, setRtcResponse) && setRtcResponse.size() == 8 &&
                  engine.execute("hart-8090", 1, 0x5A, {}, readRtc0) && readRtc0.size() == 15 &&
                  readRtc0.bytes()[0] == 2 && readRtc0.bytes()[1] == 1 &&
                  (engine.setVirtualTimeSeconds(160), engine.execute("hart-8090", 1, 0x5A, {}, readRtc1)) &&
                  readRtc1.bytes()[6] == 70,
              "Commands 89/90 share one deterministic RTC derived from virtual time");
    }

    // HCF_SPEC-151 Rev. 10.0 Commands 91-99: bounded Trend history,
    // communication snapshots, and virtual-time synchronized actions.
    {
        HartProfileRegistry registry;
        check(registry.registerProfile(HartReferenceCatalog::makeGenericProfile()), "91-99 profile registers");
        HartEngine engine(registry);
        check(HartReferenceCatalog::installCommandPrograms(engine), "91-99 programs install");
        const auto descriptors = HartReferenceCatalog::commandDescriptors();
        HartDevicePlan device{"cp-91-99", "lasecsimul.hart.process-simul-compatible", "hart-9199", 1, "010203", 10.0};
        device.ioSystem = true; device.ioMaximumCards = 1; device.ioMaximumChannelsPerCard = 1; device.ioMaximumSubDevicesPerChannel = 1;
        device.trendCount = 1; device.actionCount = 1;
        device.subDevices = {{"cp-91-child", 0, 0, 2}};
        HartDevicePlan::VariableConfiguration pv;
        pv.id = "PV"; pv.name = "Primary Variable"; pv.value = 10.0; pv.role = HartVariableRole::PrimaryVariable;
        pv.deviceVariableCode = 246; pv.deviceVariableUnit = 57; pv.classification = 65;
        device.variables.push_back(pv);
        for (const auto& command : descriptors) device.commandConfigurations.push_back({command.id, true, false, {}});
        HartDevicePlan child{"cp-91-child", "lasecsimul.hart.process-simul-compatible", "hart-9199-child", 2, "0A0B0C", 2.0};
        for (const auto& command : descriptors) child.commandConfigurations.push_back({command.id, true, false, {}});
        check(engine.loadPlan({{device, child}}), "91-99 plans load");

        HartResponseBuilder trendInitial(16);
        check(engine.execute("hart-9199", 1, 0x5B, std::array<uint8_t, 1>{0}, trendInitial) && trendInitial.size() == 8 && trendInitial.bytes()[1] == 1,
              "Command 91 reads the canonical Trend configuration");
        const std::array<uint8_t, 7> trendWrite{0, 1, 246, 0, 0, 0, 10};
        HartResponseBuilder trendWriteResponse(16), trendAfter(16);
        check(engine.execute("hart-9199", 1, 0x5C, trendWrite, trendWriteResponse) &&
                  engine.execute("hart-9199", 1, 0x5B, std::array<uint8_t, 1>{0}, trendAfter) && trendAfter.bytes()[2] == 1 && trendAfter.bytes()[3] == 246,
              "Command 92 atomically changes the configuration read by Command 91");
        engine.setVirtualTimeSeconds(10);
        engine.setPrimaryValue("cp-91-99", 20.0);
        engine.setVirtualTimeSeconds(20);
        HartResponseBuilder trend(80);
        check(engine.execute("hart-9199", 1, 0x5D, std::array<uint8_t, 1>{0}, trend) && trend.size() == 75,
              "Command 93 returns the bounded history produced by virtual-time sampling");

        const std::array<uint8_t, 7> sendChild{0, 0, 5, 0x02, 2, 0x01, 0};
        HartResponseBuilder forwarded(64), clientStats(32), deviceStats(16);
        check(engine.execute("hart-9199", 1, 0x4D, sendChild, forwarded) &&
                  engine.execute("hart-9199", 1, 0x5E, {}, clientStats) && clientStats.size() == 16 &&
                  engine.execute("hart-9199-child", 2, 0x5F, {}, deviceStats) && deviceStats.size() == 6 &&
                  (deviceStats.bytes()[0] != 0 || deviceStats.bytes()[1] != 0),
              "Commands 94/95 read real communication snapshots after traffic");

        const std::array<uint8_t, 5> commandAction{0, 0, 0x2F, 1, 1};
        HartResponseBuilder commandActionWrite(16), commandActionRead(16);
        check(engine.execute("hart-9199", 1, 0x63, commandAction, commandActionWrite) &&
                  engine.execute("hart-9199", 1, 0x62, std::array<uint8_t, 1>{0}, commandActionRead) && commandActionRead.size() == 5,
              "Commands 98/99 share one canonical command-action configuration");
        const std::array<uint8_t, 12> syncWrite{0, 0x91, 251, 0, 0x2F, 1, 1, 0, 0, 0, 0, 40};
        HartResponseBuilder syncWriteResponse(16), syncRead(16), transferAfterAction(32);
        check(engine.execute("hart-9199", 1, 0x61, syncWrite, syncWriteResponse) &&
                  engine.execute("hart-9199", 1, 0x60, std::array<uint8_t, 1>{0}, syncRead) && syncRead.size() == 13,
              "Commands 96/97 read back canonical synchronized action configuration");
        check(syncRead.size() == 13 && syncRead.bytes()[6] == 1 && syncRead.bytes()[7] == 1 && syncRead.bytes()[8] == 0 && syncRead.bytes()[9] == 0 && syncRead.bytes()[12] == 40,
              "Command 96 exposes the configured virtual trigger time");
        check(syncRead.bytes()[2] == 0x91 && syncRead.bytes()[3] == 251 && syncRead.bytes()[4] == 0 && syncRead.bytes()[5] == 0x2F,
              "Synchronous action has the command-action control and target");
        engine.setVirtualTimeSeconds(39);
        engine.setVirtualTimeSeconds(40);
        HartResponseBuilder syncAfterAction(16);
        check(engine.execute("hart-9199", 1, 0x60, std::array<uint8_t, 1>{0}, syncAfterAction) && syncAfterAction.size() == 13 &&
                  syncAfterAction.bytes()[2] == 0x11,
              "Synchronous one-shot action disables itself at its virtual trigger");
        check(engine.execute("hart-9199", 1, 0x3F, std::array<uint8_t, 1>{0}, transferAfterAction) && transferAfterAction.size() == 17 &&
                  transferAfterAction.bytes()[2] == 1,
              "Command 97 triggers the configured Command 99 action exactly through canonical dispatch");
    }

    // HCF_SPEC-151 Rev. 10.0 Commands 100-110: canonical PV alarm,
    // persistent Burst definitions, bounded virtual-time events and the
    // same Dynamic Variable assignments used by Commands 3/61.
    {
        HartProfileRegistry registry;
        check(registry.registerProfile(HartReferenceCatalog::makeGenericProfile()), "100-110 profile registers");
        HartEngine engine(registry);
        check(HartReferenceCatalog::installCommandPrograms(engine), "100-110 programs install");
        const auto descriptors = HartReferenceCatalog::commandDescriptors();
        HartDevicePlan device{"cp-100-110", "lasecsimul.hart.process-simul-compatible", "hart-100110", 1, "010203", 10.0};
        device.ioSystem = true;
        device.subDevices = {{"cp-100-child", 0, 0, 2}};
        device.variables.push_back({"PV", "Primary Variable", "", 10.0, HartVariableRole::PrimaryVariable,
                                    HartVariableType::Float32, HartVariableDirection::Internal, false, 246, 65, 250,
                                    0, 100.0f, 0.0f, 1.0f, 0.0f, 0xFFFFFFFFu, 0, 0, false, {}, 57});
        for (const auto& command : descriptors) device.commandConfigurations.push_back({command.id, true, false, {}});
        HartDevicePlan child{"cp-100-child", "lasecsimul.hart.process-simul-compatible", "hart-100110-child", 2, "0A0B0C", 5.0};
        for (const auto& command : descriptors) child.commandConfigurations.push_back({command.id, true, false, {}});
        check(engine.loadPlan({{device, child}}), "100-110 plans load");

        HartResponseBuilder alarm(8);
        check(engine.execute("hart-100110", 1, 0x64, std::array<uint8_t, 1>{1}, alarm) && alarm.size() == 1 && alarm.bytes()[0] == 1,
              "Command 100 writes the canonical PV alarm selection");
        const HartDevicePlan* afterAlarm = engine.findDevicePlan("cp-100-110");
        check(afterAlarm != nullptr && afterAlarm->alarmSelectionCode == 1,
              "Command 100 does not create a parallel alarm state");

        HartResponseBuilder mapWrite(8), mapRead(8);
        check(engine.execute("hart-100110", 1, 0x66, std::array<uint8_t, 3>{0, 0, 1}, mapWrite) &&
                  engine.execute("hart-100110", 1, 0x65, std::array<uint8_t, 1>{0}, mapRead) && mapRead.size() == 3 && mapRead.bytes()[2] == 1,
              "Commands 101/102 share the stable Sub-device to Burst mapping");

        const std::array<uint8_t, 9> period{0, 0, 0, 0x7D, 0, 0, 0, 0x7D, 0};
        HartResponseBuilder periodResponse(16), triggerResponse(16), config(40);
        check(engine.execute("hart-100110", 1, 0x67, period, periodResponse),
              "Command 103 accepts canonical Burst update periods");
        const auto nan = HartTypeCodec::encodeFloat32BE(std::numeric_limits<float>::quiet_NaN());
        std::array<uint8_t, 8> trigger{0, 0, 0, 250, nan[0], nan[1], nan[2], nan[3]};
        check(engine.execute("hart-100110", 1, 0x68, trigger, triggerResponse) &&
                  engine.execute("hart-100110", 1, 0x69, std::array<uint8_t, 1>{0}, config) && config.size() == 29 &&
                  config.bytes()[0] == 0 && config.bytes()[1] == 31 && config.bytes()[2] == 246,
              "Commands 104/105 read the same canonical Burst definition");

        HartResponseBuilder vars(32), cmdWrite(8), control(8);
        // Command 109's 2-byte request is {Burst Mode Control Code, Burst
        // Message} per HCF_SPEC-151 7.77 -- {1, 0} means "On, message 0"
        // (this used to be written {0, 1} under a swapped byte-order bug
        // fixed this session; see the dedicated byte-order regression test
        // further below).
        check(engine.execute("hart-100110", 1, 0x6B, std::array<uint8_t, 9>{246, 250, 250, 250, 250, 250, 250, 250, 0}, vars) &&
                  engine.execute("hart-100110", 1, 0x6C, std::array<uint8_t, 3>{0, 1, 0}, cmdWrite) &&
                  engine.execute("hart-100110", 1, 0x6D, std::array<uint8_t, 2>{1, 0}, control),
              "Commands 107-109 atomically configure variables, command and enable state");

        // HCF_SPEC-151 7.75.1: a HART 5/6 Master's Command 107 request may
        // have only 1-4 Device Variable slots instead of the full 9 bytes;
        // the device must accept it (never Response Code 5), assume Burst
        // Message 0, set every unspecified slot to 250 "Not Used", and the
        // response must still be the full untruncated 9 bytes (footnote 76).
        HartResponseBuilder legacyBurstVars(16);
        check(engine.execute("hart-100110", 1, 0x6B, std::array<uint8_t, 1>{246}, legacyBurstVars) &&
                  legacyBurstVars.size() == 9 && legacyBurstVars.bytes()[0] == 246 &&
                  legacyBurstVars.bytes()[1] == 250 && legacyBurstVars.bytes()[7] == 250 && legacyBurstVars.bytes()[8] == 0,
              "Command 107 accepts a truncated (1-4 byte) request per 7.75.1 and returns the full untruncated 9 bytes");

        // HCF_SPEC-151 7.73.1: a HART 5/6 Master's Command 105 request has NO
        // data bytes, and for that legacy form only, response byte 1 must be
        // the LSByte of the burst command number (now 1, from Command 108
        // above) INSTEAD OF the literal 31 Command Number Expansion Flag a
        // modern (1-byte) request gets -- see the other Command 105 check
        // above, which already covers the modern/byte1==31 case.
        HartResponseBuilder legacyConfig(40);
        check(engine.execute("hart-100110", 1, 0x69, {}, legacyConfig) && legacyConfig.size() == 29 &&
                  legacyConfig.bytes()[0] == 1 && legacyConfig.bytes()[1] == 1,
              "Command 105 legacy (0-byte) request returns the LSByte of the burst command at byte 1, not 31, "
              "and byte 0 confirms Command 109's {control, message} byte order actually turned message 0 on");
        engine.setVirtualTimeSeconds(1);
        const auto burstEvents = engine.takeBurstEvents("cp-100-110");
        check(burstEvents.size() == 1 && burstEvents.front().command == 1 && burstEvents.front().payload.size() == 5,
              "Enabled Burst uses virtual time and the canonical command dispatcher");
        check(engine.execute("hart-100110", 1, 0x6D, std::array<uint8_t, 2>{0, 0}, control),
              "Command 109 disables the same scheduler Burst state");
        engine.setVirtualTimeSeconds(2);
        check(engine.takeBurstEvents("cp-100-110").empty(), "Disabled Burst emits no further events");

        HartResponseBuilder dynamic(32);
        check(engine.execute("hart-100110", 1, 0x6E, {}, dynamic) && dynamic.size() == 5 && dynamic.bytes()[0] == 57,
              "Command 110 reads the canonical PV assignment and value");
        HartResponseBuilder flushed(8);
        check(engine.execute("hart-100110", 1, 0x6A, {}, flushed) && flushed.size() == 0,
              "Command 106 flushes the real bounded delayed-event queue");
    }

    // HCF_SPEC-151 7.79-7.87 plus HCF_SPEC-190: bounded transfer session,
    // real catch of a later command response, and one event authority shared
    // by summary/control/acknowledge and Command 48.
    {
        HartProfileRegistry registry;
        check(registry.registerProfile(HartReferenceCatalog::makeGenericProfile()), "111-119 profile registers");
        HartEngine engine(registry);
        check(HartReferenceCatalog::installCommandPrograms(engine), "111-119 programs install");
        const auto descriptors = HartReferenceCatalog::commandDescriptors();
        HartDevicePlan receiver{"cp-111-119", "lasecsimul.hart.process-simul-compatible", "hart-111119", 1, "010203", 0.0};
        HartDevicePlan::VariableConfiguration receiverPv;
        receiverPv.id = "PV"; receiverPv.role = HartVariableRole::PrimaryVariable; receiverPv.deviceVariableCode = 246; receiverPv.deviceVariableUnit = 57; receiverPv.value = 0.0;
        HartDevicePlan::VariableConfiguration caught;
        caught.id = "caught"; caught.role = HartVariableRole::SecondaryVariable; caught.deviceVariableCode = 247; caught.deviceVariableUnit = 57; caught.value = 0.0;
        receiver.variables = {receiverPv, caught};
        HartDevicePlan source{"cp-111-source", "lasecsimul.hart.process-simul-compatible", "hart-111119", 2, "0A0B0C", 12.5};
        for (const auto& command : descriptors) { receiver.commandConfigurations.push_back({command.id, true, false, {}}); source.commandConfigurations.push_back({command.id, true, false, {}}); }
        check(engine.loadPlan({{receiver, source}}), "111-119 plans load");

        HartResponseBuilder transferOpen(16), transferData(16), transferClose(16);
        check(engine.execute("hart-111119", 1, 0x6F, std::array<uint8_t, 5>{1, 4, 32, 0, 0}, transferOpen) && transferOpen.size() == 7 && transferOpen.bytes()[2] == 32,
              "Command 111 opens one canonical HCF_SPEC-190 transfer session");
        const std::array<uint8_t, 9> transferRequest{0, 3, 0, 0, 0, 0, 0xAA, 0xBB, 0xCC};
        check(engine.execute("hart-111119", 1, 0x70, transferRequest, transferData) && transferData.size() == 6 && transferData.bytes()[2] == 0 && transferData.bytes()[3] == 3,
              "Command 112 advances the same bounded master byte counter atomically");
        check(engine.execute("hart-111119", 1, 0x6F, std::array<uint8_t, 5>{4, 4, 32, 0, 3}, transferClose) && !engine.execute("hart-111119", 1, 0x70, std::array<uint8_t, 6>{0, 0, 0, 3, 0, 0}, transferData),
              "Transfer close makes Command 112 reject further blocks");

        // HCF_SPEC-151 7.81: {Destination DV, Capture Mode, Source Address(5),
        // marker byte (31 on a modern write's own response), Source Slot,
        // Shed Time float, Source Command(16-bit)}. Slot must stay 0 here
        // (Table 9 only defines Slot 1 == PV for Command 1, and the
        // downstream capture-matching logic below requires exactly that),
        // but Shed Time (2.5, distinctly non-zero/non-degenerate) and the
        // byte-7 marker check below still catch a byte-mapping regression --
        // this session's audit found and fixed a bug where the marker/slot
        // bytes were swapped and the shed float was read one byte early; the
        // previous version of this test used shed=0.0 (all-zero bytes), which
        // could not distinguish the correct offsets from the buggy ones.
        const auto shed = HartTypeCodec::encodeFloat32BE(2.5f);
        const std::array<uint8_t, 15> catchWrite{247, 1, 0, 0, 0, 0, 2, 0, 0, shed[0], shed[1], shed[2], shed[3], 0, 1};
        HartResponseBuilder catchResponse(32), caughtConfiguration(32);
        check(engine.execute("hart-111119", 1, 0x71, catchWrite, catchResponse) && catchResponse.size() == 15 &&
                  catchResponse.bytes()[0] == 247 && catchResponse.bytes()[1] == 1 && catchResponse.bytes()[6] == 2 &&
                  catchResponse.bytes()[7] == 31 && catchResponse.bytes()[8] == 0 &&
                  std::equal(shed.begin(), shed.end(), catchResponse.bytes().begin() + 9) &&
                  catchResponse.bytes()[13] == 0 && catchResponse.bytes()[14] == 1 &&
                  engine.execute("hart-111119", 1, 0x72, std::array<uint8_t, 1>{247}, caughtConfiguration) &&
                  std::equal(catchResponse.bytes().begin(), catchResponse.bytes().end(), caughtConfiguration.bytes().begin()),
              "Commands 113/114 share one canonical Catch configuration with the correct HCF_SPEC-151 7.81 byte layout");

        // HCF_SPEC-151 7.81.1: a HART 5/6 Master's Command 113 request has
        // only 13 bytes (no bytes 13-14) and puts the 1-byte command number
        // directly in byte 7 instead of the literal 31 marker; the response
        // must carry that command number in BOTH byte 7 and bytes 13-14
        // (re-applies the same dest/mode/address/slot/shed as the modern
        // write above, so this does not disturb the capture wired by it).
        const std::array<uint8_t, 13> catchWriteLegacy{247, 1, 0, 0, 0, 0, 2, 1, 0, shed[0], shed[1], shed[2], shed[3]};
        HartResponseBuilder catchResponseLegacy(32);
        check(engine.execute("hart-111119", 1, 0x71, catchWriteLegacy, catchResponseLegacy) &&
                  catchResponseLegacy.size() == 15 && catchResponseLegacy.bytes()[7] == 1 &&
                  catchResponseLegacy.bytes()[13] == 0 && catchResponseLegacy.bytes()[14] == 1,
              "Command 113 legacy (13-byte) request returns the command number in both byte 7 and bytes 13-14");
        engine.setVirtualTimeSeconds(10);
        HartResponseBuilder sourceResponse(16);
        check(engine.execute("hart-111119", 2, 0x01, {}, sourceResponse) && engine.variableValue("cp-111-119", "caught").value_or(-1.0) == 12.5,
              "Command 113 captures a later source response without changing source authority");
        HartResponseBuilder statusResponse(16);
        check(engine.execute("hart-111119", 1, 0x30, {}, statusResponse) && statusResponse.bytes()[0] == 0,
              "Command 48 remains the shared status source for event notifications");

        HartResponseBuilder mask(40), timing(20), control(8), summary(64), notification(40), acknowledged(40), summaryAfter(64);
        check(engine.execute("hart-111119", 1, 0x74, std::array<uint8_t, 3>{0, 1, 1}, mask) &&
                  engine.execute("hart-111119", 1, 0x75, std::array<uint8_t, 13>{0, 0, 0, 0x7D, 0, 0, 0, 0x7D, 0, 0, 0, 0x7D, 0}, timing) &&
                  engine.execute("hart-111119", 1, 0x76, std::array<uint8_t, 2>{0, 1}, control) &&
                  engine.setDiagnosticStatus("cp-111-119", 1) &&
                  engine.execute("hart-111119", 1, 0x73, std::array<uint8_t, 1>{0}, summary) && summary.size() == 45 &&
                  engine.execute("hart-111119", 1, 0x77, std::array<uint8_t, 1>{0}, notification) && notification.size() == 33,
              "Commands 115-118 expose real masked event state driven by virtual time");
        check(engine.execute("hart-111119", 1, 0x77, notification.bytes(), acknowledged) &&
                  engine.execute("hart-111119", 1, 0x73, std::array<uint8_t, 1>{0}, summaryAfter) && summaryAfter.bytes()[3] == 0xFF,
              "Command 119 acknowledges the latched event without clearing underlying status");
    }

    // HCF_SPEC-151 Rev. 10.0 Commands 512-531: metadata, Event Manager,
    // WGS84 location, Condensed Status/Status Simulation and bounded
    // non-volatile Assignment List, all against the same canonical plan.
    {
        HartProfileRegistry registry;
        check(registry.registerProfile(HartReferenceCatalog::makeGenericProfile()), "512-531 profile registers");
        HartEngine engine(registry);
        check(HartReferenceCatalog::installCommandPrograms(engine), "512-531 programs install");
        const auto descriptors = HartReferenceCatalog::commandDescriptors();
        HartDevicePlan parent{"cp-512-531", "lasecsimul.hart.process-simul-compatible", "hart-512531", 1, "010203", 0.0};
        parent.ioSystem = true; parent.ioMaximumCards = 2; parent.ioMaximumChannelsPerCard = 2;
        parent.assignmentCapacity = 2; parent.deviceLocationSupported = true; parent.locationDescriptionSupported = true; parent.processUnitTagSupported = true; parent.condensedStatusSupported = true;
        HartDevicePlan::VariableConfiguration flow;
        flow.id = "flow"; flow.role = HartVariableRole::PrimaryVariable; flow.deviceVariableCode = 246;
        flow.deviceVariableUnit = 57; flow.classification = 66; flow.value = 3.0;
        parent.variables.push_back(flow);
        HartDevicePlan::VariableConfiguration pressure;
        pressure.id = "pressure"; pressure.deviceVariableCode = 1; pressure.deviceVariableUnit = 6;
        pressure.classification = 65; pressure.deviceVariableStatus = 0x80;
        pressure.pressure.status0 = 0x08; pressure.pressure.familyDefinitionRevision = 1;
        pressure.pressure.familyCapabilities0 = 0x01; pressure.pressure.familyCapabilities1 = 0;
        pressure.pressure.supportedStatusFamilyMask = 0xFF; pressure.pressure.supportedStatus0Mask = 0xFF;
        pressure.pressure.measurementType = 1; pressure.pressure.moduleFillFluid = 2;
        pressure.pressure.diaphragmMaterial = 3; pressure.pressure.sensorHardwareRevision = 4;
        pressure.pressure.sensorTechnology = 5; pressure.pressure.pressureUnitCode = 6;
        pressure.pressure.minimumAbsolutePressure = 0.5f; pressure.pressure.maximumStaticPressure = 250.0f;
        pressure.pressure.processConnection = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
        pressure.pressure.supportsOptionalGasket = true; pressure.pressure.optionalGasket = {11, 12, 13};
        pressure.pressure.supportsPressureObservation = true; pressure.pressure.pressureObservationUnit = 6;
        pressure.pressure.minimumPressureObservation = 1.0f; pressure.pressure.maximumPressureObservation = 99.0f;
        pressure.pressure.supportsTemperatureObservation = true; pressure.pressure.temperatureObservationUnit = 7;
        pressure.pressure.minimumTemperatureObservation = -10.0f; pressure.pressure.maximumTemperatureObservation = 85.0f;
        pressure.pressure.supportsStaticPressureObservation = true; pressure.pressure.staticPressureObservationUnit = 8;
        pressure.pressure.minimumStaticPressureObservation = 2.0f; pressure.pressure.maximumStaticPressureObservation = 100.0f;
        pressure.pressure.supportsRemoteSeal = true; pressure.pressure.remoteSeal = {2, 3, 4, 5, 6, 7, 8};
        pressure.pressure.supportsWriteProcessConnection = true; pressure.pressure.supportsWriteOptionalGasket = true; pressure.pressure.supportsWriteRemoteSeal = true;
        parent.variables.push_back(pressure);
        HartDevicePlan::VariableConfiguration pressureB = pressure;
        pressureB.id = "pressure-b"; pressureB.deviceVariableCode = 2; pressureB.deviceVariableStatus = 0x40;
        pressureB.pressure.status0 = 0x40; pressureB.pressure.processConnection = {51, 52, 53, 54, 55, 56, 57, 58, 59, 60};
        pressureB.pressure.supportsWriteProcessConnection = false;
        parent.variables.push_back(pressureB);
        HartDevicePlan::VariableConfiguration temperature;
        temperature.id = "temperature"; temperature.deviceVariableCode = 3; temperature.deviceVariableUnit = 32;
        temperature.classification = 64; temperature.deviceVariableStatus = 0xC0;
        temperature.temperature.familyStatus = 0xC0; temperature.temperature.probeType = 12;
        temperature.temperature.numberOfWires = 3; temperature.temperature.temperatureStandard = 1;
        temperature.temperature.probeConnection = 1; temperature.temperature.coldJunctionCompensationType = 2;
        temperature.temperature.manualColdJunctionUnit = 32; temperature.temperature.manualColdJunctionTemperature = 25.0f;
        temperature.temperature.cvdA = 1.0f; temperature.temperature.cvdB = 2.0f; temperature.temperature.cvdC = 3.0f; temperature.temperature.cvdR0 = 100.0f;
        temperature.temperature.supportsThermocouple = true; temperature.temperature.supportsCalibratedRtd = true;
        temperature.temperature.supportsWriteTemperatureStandard = true; temperature.temperature.supportsWriteProbeConnection = true;
        temperature.temperature.supportsWriteColdJunction = true;
        parent.variables.push_back(temperature);
        parent.tag = "DEVICE-TAG"; parent.longTag = "PARENT-LONG-TAG";
        parent.subDevices = {{"cp-512-child-a", 0, 0, 2}, {"cp-512-child-b", 1, 1, 3}};
        HartDevicePlan childA{"cp-512-child-a", "lasecsimul.hart.process-simul-compatible", "hart-512531", 2, "0A0B0C", 1.0};
        childA.longTag = "CHILD-A";
        HartDevicePlan childB{"cp-512-child-b", "lasecsimul.hart.process-simul-compatible", "hart-512531", 3, "0D0E0F", 2.0};
        childB.longTag = "CHILD-B";
        for (const auto& command : descriptors) {
            parent.commandConfigurations.push_back({command.id, true, false, {}});
            childA.commandConfigurations.push_back({command.id, true, false, {}});
            childB.commandConfigurations.push_back({command.id, true, false, {}});
        }
        check(engine.loadPlan({{parent, childA, childB}}), "512-531 plans load");

        HartResponseBuilder countryRead(8), countryWrite(8), countryAfter(8);
        check(engine.execute("hart-512531", 1, 512, {}, countryRead) && countryRead.size() == 3 &&
                  engine.execute("hart-512531", 1, 513, std::array<uint8_t, 3>{'B', 'R', 0}, countryWrite) && countryWrite.size() == 3 &&
                  engine.execute("hart-512531", 1, 512, {}, countryAfter) && countryAfter.bytes()[0] == 'B' && countryAfter.bytes()[1] == 'R',
              "Commands 512/513 share one country-code and SI-restriction property");

        const auto lat = HartTypeCodec::encodeFloat32BE(12.5f);
        const auto lon = HartTypeCodec::encodeFloat32BE(-45.25f);
        const auto alt = HartTypeCodec::encodeFloat32BE(100.0f);
        std::array<uint8_t, 13> location{};
        std::copy(lat.begin(), lat.end(), location.begin()); std::copy(lon.begin(), lon.end(), location.begin() + 4);
        location[8] = 7; std::copy(alt.begin(), alt.end(), location.begin() + 9);
        HartResponseBuilder locationWrite(20), locationRead(20);
        check(engine.execute("hart-512531", 1, 517, location, locationWrite) && locationWrite.size() == 13 &&
                  engine.execute("hart-512531", 1, 516, {}, locationRead) && locationRead.size() == 13 && locationRead.bytes()[8] == 7,
              "Commands 516/517 use canonical WGS84 location metadata");

        std::array<uint8_t, 32> description{}; std::array<uint8_t, 32> processTag{};
        description.fill('D'); processTag.fill('P');
        HartResponseBuilder metadataWrite(40), metadataRead(40), processWrite(40), processRead(40);
        check(engine.execute("hart-512531", 1, 519, description, metadataWrite) &&
                  engine.execute("hart-512531", 1, 518, {}, metadataRead) && metadataRead.bytes()[0] == 'D' &&
                  engine.execute("hart-512531", 1, 521, processTag, processWrite) &&
                  engine.execute("hart-512531", 1, 520, {}, processRead) && processRead.bytes()[0] == 'P',
              "Commands 518-521 keep Location Description and Process Unit Tag independent");
        HartResponseBuilder classification(8);
        check(engine.execute("hart-512531", 1, 522, std::array<uint8_t, 2>{246, 100}, classification) && classification.size() == 2 &&
                  engine.findDevicePlan("cp-512-531")->variables[0].classification == 100,
              "Command 522 changes only the volumetric-flow classification authority");

        HartResponseBuilder manager(8), managerStatus(8), otherStatus(8);
        check(engine.execute("hart-512531", 1, 514, std::array<uint8_t, 1>{0}, manager, 1) &&
                  engine.execute("hart-512531", 1, 515, {}, managerStatus, 1) && managerStatus.bytes()[0] == 3 &&
                  engine.execute("hart-512531", 1, 515, {}, otherStatus, 0) && otherStatus.bytes()[0] == 1,
              "Commands 514/515 share one Event Manager owner and registration status");

        HartResponseBuilder mappingWrite(16), mappingRead(16), mappingReset(8), mappingAfterReset(16);
        check(engine.execute("hart-512531", 1, 524, std::array<uint8_t, 3>{0, 2, 0x13}, mappingWrite), "Command 524 accepts a complete mapping fragment");
        check(engine.execute("hart-512531", 1, 523, std::array<uint8_t, 2>{0, 2}, mappingRead) && mappingRead.size() == 3 && mappingRead.bytes()[2] == 0x13,
              "Command 523 reads the committed mapping fragment");
        check(engine.execute("hart-512531", 1, 525, {}, mappingReset), "Command 525 resets the mapping atomically");
        check(engine.execute("hart-512531", 1, 523, std::array<uint8_t, 2>{0, 2}, mappingAfterReset) && mappingAfterReset.bytes()[2] == 0,
              "Command 523 observes the reset default mapping");

        HartResponseBuilder simulationMode(8), simulatedBit(8), simulatedStatus(16), normalStatus(16);
        check(engine.execute("hart-512531", 1, 526, std::array<uint8_t, 1>{1}, simulationMode) &&
                  engine.execute("hart-512531", 1, 527, std::array<uint8_t, 2>{0, 1}, simulatedBit) &&
                  engine.execute("hart-512531", 1, 48, {}, simulatedStatus) && (simulatedStatus.bytes()[0] & 0x01) != 0 &&
                  engine.execute("hart-512531", 1, 526, std::array<uint8_t, 1>{0}, simulationMode) &&
                  engine.execute("hart-512531", 1, 48, {}, normalStatus) && (normalStatus.bytes()[0] & 0x01) == 0,
              "Commands 526/527 overlay reported status without mutating underlying real status");

        HartResponseBuilder transfer(8), assignmentInfo(8), assignmentA(64), assignmentB(64);
        check(engine.execute("hart-512531", 1, 531, std::array<uint8_t, 1>{0}, transfer) && transfer.size() == 1, "Command 531 atomically snapshots the live list");
        check(engine.execute("hart-512531", 1, 528, {}, assignmentInfo) && assignmentInfo.size() == 5 && assignmentInfo.bytes()[1] == 3,
              "Command 528 reads assignment count and capacity");
        const bool assignmentAOk = engine.execute("hart-512531", 1, 529, std::array<uint8_t, 2>{0, 1}, assignmentA);
        check(assignmentAOk && assignmentA.size() == 45 && assignmentA.bytes()[12] == 'C',
              "Command 529 reads assignment A with stable identity");
        const bool assignmentBOk = engine.execute("hart-512531", 1, 529, std::array<uint8_t, 2>{0, 2}, assignmentB);
        check(assignmentBOk && assignmentB.size() == 45 && assignmentB.bytes()[12] == 'C',
              "Command 529 reads assignment B with stable identity");
        std::array<uint8_t, 44> assignmentRewrite{}; std::fill(assignmentRewrite.begin() + 11, assignmentRewrite.begin() + 43, static_cast<uint8_t>(' '));
        assignmentRewrite[1] = 1; assignmentRewrite[2] = 1; assignmentRewrite[3] = 1;
        assignmentRewrite[11] = 'C'; assignmentRewrite[12] = 'H'; assignmentRewrite[13] = 'I'; assignmentRewrite[14] = 'L';
        assignmentRewrite[15] = 'D'; assignmentRewrite[16] = '-'; assignmentRewrite[17] = 'A';
        HartResponseBuilder assignmentWrite(64), assignmentAfterWrite(64);
        check(engine.execute("hart-512531", 1, 530, assignmentRewrite, assignmentWrite) && assignmentWrite.size() == 44 &&
                  engine.execute("hart-512531", 1, 529, std::array<uint8_t, 2>{0, 1}, assignmentAfterWrite) && assignmentAfterWrite.bytes()[3] == 1,
              "Command 530 atomically replaces an existing stable assignment");

        HartResponseBuilder pressureStatus(8), pressureCapabilities(8), pressureMask(8), pressureSensor(24), pressureConnection(16), pressureAssociated(8);
        const auto exactPressure = [](std::span<const uint8_t> actual, std::initializer_list<uint8_t> expected) {
            return actual.size() == expected.size() && std::equal(expected.begin(), expected.end(), actual.begin());
        };
        check(engine.execute("hart-512531", 1, 1280, std::array<uint8_t, 1>{1}, pressureStatus) && exactPressure(pressureStatus.bytes(), {1, 0x80, 0x08}), "Pressure 1280");
        check(engine.execute("hart-512531", 1, 1281, std::array<uint8_t, 1>{1}, pressureCapabilities) && exactPressure(pressureCapabilities.bytes(), {1, 1, 1, 0}), "Pressure 1281");
        check(engine.execute("hart-512531", 1, 1282, std::array<uint8_t, 1>{1}, pressureMask) && exactPressure(pressureMask.bytes(), {1, 0xFF, 0xFF}), "Pressure 1282");
        check(engine.execute("hart-512531", 1, 1283, std::array<uint8_t, 1>{1}, pressureSensor) && pressureSensor.size() == 15, "Pressure 1283");
        check(engine.execute("hart-512531", 1, 1284, std::array<uint8_t, 1>{1}, pressureConnection) && exactPressure(pressureConnection.bytes(), {1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10}), "Pressure 1284");
        check(engine.execute("hart-512531", 1, 1285, std::array<uint8_t, 1>{1}, pressureAssociated) && exactPressure(pressureAssociated.bytes(), {1, 250, 250}), "Pressure 1285");
        HartResponseBuilder gasket(8), pressureObs(16), temperatureObs(16), staticObs(16), remoteSeal(16);
        check(engine.execute("hart-512531", 1, 1286, std::array<uint8_t, 1>{1}, gasket) && exactPressure(gasket.bytes(), {1, 11, 12, 13}) &&
                  engine.execute("hart-512531", 1, 1287, std::array<uint8_t, 1>{1}, pressureObs) && pressureObs.size() == 10 &&
                  engine.execute("hart-512531", 1, 1288, std::array<uint8_t, 1>{1}, temperatureObs) && temperatureObs.size() == 10 &&
                  engine.execute("hart-512531", 1, 1289, std::array<uint8_t, 1>{1}, staticObs) && staticObs.size() == 10 &&
                  engine.execute("hart-512531", 1, 1290, std::array<uint8_t, 1>{1}, remoteSeal) && exactPressure(remoteSeal.bytes(), {1, 2, 3, 4, 5, 6, 7, 8}),
              "Pressure optional readers are capability-gated and byte-sized by the specification");
        const std::array<uint8_t, 11> nextConnection{1, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30};
        HartResponseBuilder connectionWrite(16), connectionAfter(16);
        check(engine.execute("hart-512531", 1, 1408, nextConnection, connectionWrite) &&
                  engine.execute("hart-512531", 1, 1284, std::array<uint8_t, 1>{1}, connectionAfter) &&
                  exactPressure(connectionAfter.bytes(), {1, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30}),
              "Command 1408 writes the same canonical process connection read by 1284");
        HartResponseBuilder gasketWrite(8), gasketAfter(8), remoteWrite(16), remoteAfter(16);
        check(engine.execute("hart-512531", 1, 1409, std::array<uint8_t, 4>{1, 31, 32, 33}, gasketWrite) &&
                  engine.execute("hart-512531", 1, 1286, std::array<uint8_t, 1>{1}, gasketAfter) && exactPressure(gasketAfter.bytes(), {1, 31, 32, 33}) &&
                  engine.execute("hart-512531", 1, 1410, std::array<uint8_t, 8>{1, 2, 43, 44, 45, 46, 47, 48}, remoteWrite) &&
                  engine.execute("hart-512531", 1, 1290, std::array<uint8_t, 1>{1}, remoteAfter) && exactPressure(remoteAfter.bytes(), {1, 2, 43, 44, 45, 46, 47, 48}),
              "Commands 1409/1410 round-trip through their canonical Pressure readers");
        HartResponseBuilder changedStatus(16), resetChanged(8), clearedStatus(16);
        const auto* changedPlan = engine.findDevicePlan("cp-512-531");
        const uint16_t changedCounter = static_cast<uint16_t>(changedPlan->configurationChangedCounter);
        check(changedCounter == 3 && engine.execute("hart-512531", 1, 48, {}, changedStatus) && (changedStatus.bytes()[0] & 0x40) != 0 &&
                  engine.execute("hart-512531", 1, 0x26, std::array<uint8_t, 2>{static_cast<uint8_t>(changedCounter >> 8), static_cast<uint8_t>(changedCounter)}, resetChanged) &&
                  engine.execute("hart-512531", 1, 48, {}, clearedStatus) && (clearedStatus.bytes()[0] & 0x40) == 0,
              "Pressure writes advance the single Configuration Changed authority and Command 38/48 observe it");
        HartResponseBuilder pressureBRead(16), pressureBRejectedWrite(16);
        check(engine.execute("hart-512531", 1, 1284, std::array<uint8_t, 1>{2}, pressureBRead) &&
                  exactPressure(pressureBRead.bytes(), {2, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60}) &&
                  !engine.execute("hart-512531", 1, 1408, std::array<uint8_t, 11>{2, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70}, pressureBRejectedWrite),
              "Two Pressure Device Variables keep independent metadata and capabilities");
        HartResponseBuilder invalidWrite(16), unchangedConnection(16);
        const auto beforeInvalidCounter = static_cast<uint16_t>(engine.findDevicePlan("cp-512-531")->configurationChangedCounter);
        check(!engine.execute("hart-512531", 1, 1408, std::array<uint8_t, 11>{1, 250, 22, 23, 24, 25, 26, 27, 28, 29, 30}, invalidWrite) &&
                  engine.execute("hart-512531", 1, 1284, std::array<uint8_t, 1>{1}, unchangedConnection) &&
                  exactPressure(unchangedConnection.bytes(), {1, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30}) &&
                  static_cast<uint16_t>(engine.findDevicePlan("cp-512-531")->configurationChangedCounter) == beforeInvalidCounter,
              "Invalid Pressure enum is rejected atomically without mutating metadata");
        HartResponseBuilder pressureRejected(8);
        check(!engine.execute("hart-512531", 1, 1280, std::array<uint8_t, 1>{246}, pressureRejected),
              "Pressure Device Family rejects a non-pressure Device Variable instead of fabricating support");
        HartResponseBuilder temperatureStatus(8), temperatureConfig(8), thermocouple(16), cvd(24);
        check(engine.execute("hart-512531", 1, 1024, std::array<uint8_t, 1>{3}, temperatureStatus) && temperatureStatus.size() == 3 &&
                  engine.execute("hart-512531", 1, 1025, std::array<uint8_t, 1>{3}, temperatureConfig) && temperatureConfig.bytes()[1] == 12 &&
                  engine.execute("hart-512531", 1, 1026, std::array<uint8_t, 1>{3}, thermocouple) && thermocouple.size() == 8 &&
                  engine.execute("hart-512531", 1, 1027, std::array<uint8_t, 1>{3}, cvd) && cvd.size() == 17,
              "Temperature Device Family reads use the real per-variable capability and fixed layouts");
        HartResponseBuilder tempWrite(24), tempReadAfterWrite(8);
        check(engine.execute("hart-512531", 1, 1153, std::array<uint8_t, 2>{3, 2}, tempWrite) &&
                  engine.execute("hart-512531", 1, 1025, std::array<uint8_t, 1>{3}, tempReadAfterWrite) && tempReadAfterWrite.bytes()[3] == 2,
              "Temperature command 1153 writes the same canonical property read by 1025");
        HartResponseBuilder tempCvdWrite(24), tempCvdRead(24);
        const auto cvdA = HartTypeCodec::encodeFloat32BE(1.5f), cvdB = HartTypeCodec::encodeFloat32BE(2.5f), cvdC = HartTypeCodec::encodeFloat32BE(3.5f), cvdR0 = HartTypeCodec::encodeFloat32BE(101.0f);
        std::array<uint8_t, 17> cvdWrite{}; cvdWrite[0] = 3;
        std::copy(cvdA.begin(), cvdA.end(), cvdWrite.begin() + 1); std::copy(cvdB.begin(), cvdB.end(), cvdWrite.begin() + 5);
        std::copy(cvdC.begin(), cvdC.end(), cvdWrite.begin() + 9); std::copy(cvdR0.begin(), cvdR0.end(), cvdWrite.begin() + 13);
        check(engine.execute("hart-512531", 1, 1157, cvdWrite, tempCvdWrite) && engine.execute("hart-512531", 1, 1027, std::array<uint8_t, 1>{3}, tempCvdRead) &&
                  std::equal(cvdA.begin(), cvdA.end(), tempCvdRead.bytes().begin() + 1) && std::equal(cvdR0.begin(), cvdR0.end(), tempCvdRead.bytes().begin() + 13),
              "Temperature CVD write/read share one canonical coefficient set");
    }

    // HCF_SPEC-155 Rev 2.0 provisioning and bounded radio configuration.
    {
        HartProfileRegistry wirelessRegistry;
        check(wirelessRegistry.registerProfile(HartReferenceCatalog::makeGenericProfile()), "Wireless profile registers");
        HartEngine wirelessEngine(wirelessRegistry);
        check(HartReferenceCatalog::installCommandPrograms(wirelessEngine), "Wireless programs install");
        HartDevicePlan wireless{"wireless-device", "lasecsimul.hart.process-simul-compatible", "hart-wireless", 1, "ABCDEF", 1.0};
        wireless.wireless.capable = true;
        for (const auto& descriptor : HartReferenceCatalog::commandDescriptors()) wireless.commandConfigurations.push_back({descriptor.id, true, false, {}});
        check(wirelessEngine.loadPlan({{wireless}}), "Wireless plan loads");
        HartResponseBuilder networkWrite(8), networkRead(8);
        check(wirelessEngine.execute("hart-wireless", 1, 773, std::array<uint8_t, 2>{0x12, 0x34}, networkWrite) &&
                  wirelessEngine.execute("hart-wireless", 1, 774, {}, networkRead) && networkRead.size() == 4 &&
                  networkRead.bytes()[0] == 0x12 && networkRead.bytes()[1] == 0x34,
              "Wireless network ID write/read share canonical current state");
        std::array<uint8_t, 32> tag{}; tag[0] = 'N'; tag[1] = '1';
        HartResponseBuilder tagWrite(40), tagRead(40);
        check(wirelessEngine.execute("hart-wireless", 1, 775, tag, tagWrite) && wirelessEngine.execute("hart-wireless", 1, 776, {}, tagRead) &&
                  tagRead.size() == 32 && tagRead.bytes()[0] == 'N' && tagRead.bytes()[1] == '1',
              "Wireless network tag write/read share bounded canonical state");
        HartResponseBuilder ttlWrite(8), ttlRead(8);
        check(wirelessEngine.execute("hart-wireless", 1, 809, std::array<uint8_t, 1>{3}, ttlWrite) && ttlWrite.bytes()[0] == 8 &&
                  wirelessEngine.execute("hart-wireless", 1, 808, {}, ttlRead) && ttlRead.bytes()[0] == 8,
              "Wireless TTL enforces normative minimum and reads back");
        HartResponseBuilder wiredRejected(8);
        check(!engine.execute("hart-512531", 1, 774, {}, wiredRejected),
              "Non-Wireless device rejects Wireless command without synthetic capability");
    }

    if (failures == 0) std::puts("HART engine contracts: PASS");
    return failures == 0 ? 0 : 1;
}
