#pragma once

#include "artifact_transport_abi.h"
#include <cstddef>
#include <cstdint>
#include <limits>

namespace lasecsimul::mcu::vnext {

struct MappingView {
    const lasec_at_control_page* control = nullptr;
    const lasec_at_endpoint_descriptor* endpoints = nullptr;
    const lasec_at_lane_descriptor* lanes = nullptr;
    const lasec_at_response_slot* responses = nullptr;
    const lasec_at_snapshot_descriptor* snapshots = nullptr;
    const lasec_at_c2a_descriptor* c2a = nullptr;
};

inline bool mappingRange(uint64_t offset, uint64_t bytes, uint64_t total,
                         uint64_t alignment = 8) {
    return alignment != 0 && offset % alignment == 0 && offset <= total &&
           bytes <= total - offset;
}

inline bool mappingRing(const lasec_at_region_descriptor& metadata,
                        const lasec_at_region_descriptor& events,
                        uint32_t depth, uint32_t stride, uint64_t total) {
    return depth >= 2 && depth <= 1024 && (depth & (depth - 1)) == 0 &&
           stride == sizeof(lasec_at_event) && metadata.count == 1 &&
           metadata.stride == sizeof(lasec_at_ring_header) &&
           events.count == depth && events.stride == sizeof(lasec_at_event) &&
           metadata.bytes == sizeof(lasec_at_ring_header) &&
           events.bytes == uint64_t(depth) * sizeof(lasec_at_event) &&
           mappingRange(metadata.offset, metadata.bytes, total, 8) &&
           mappingRange(events.offset, events.bytes, total, 64);
}

inline bool validateMappingView(const void* base, uint64_t size, MappingView& view) {
    view = {};
    if (!base || size < sizeof(lasec_at_control_page)) return false;
    auto* bytes = static_cast<const uint8_t*>(base);
    auto* c = reinterpret_cast<const lasec_at_control_page*>(bytes);
    if (c->magic != LASEC_AT_MAGIC || c->abi_major != LASEC_AT_ABI_MAJOR ||
        c->abi_minor > LASEC_AT_ABI_MINOR || c->mapping_bytes != size ||
        c->execution_id == 0 || c->lane_count == 0 ||
        c->lane_count > LASEC_AT_MAX_LANES ||
        c->endpoint_count > c->descriptor_capacity ||
        c->endpoint_count > LASEC_AT_MAX_ENDPOINTS ||
        c->response_slot_count != c->lane_count ||
        c->response_slot_count > LASEC_AT_MAX_RESPONSES ||
        c->snapshot_count > LASEC_AT_MAX_SNAPSHOTS) return false;
    if (!mappingRange(c->descriptor_offset,
                      uint64_t(c->descriptor_capacity) * sizeof(lasec_at_endpoint_descriptor), size, 64) ||
        !mappingRange(c->lane_descriptor_offset,
                      uint64_t(c->lane_count) * sizeof(lasec_at_lane_descriptor), size, 64) ||
        !mappingRange(c->response_slot_offset,
                      uint64_t(c->response_slot_count) * sizeof(lasec_at_response_slot), size, 64) ||
        !mappingRange(c->snapshot_descriptor_offset,
                      uint64_t(c->snapshot_count) * sizeof(lasec_at_snapshot_descriptor), size, 64) ||
        !mappingRange(c->c2a_descriptor_offset, sizeof(lasec_at_c2a_descriptor), size, 64)) return false;
    auto* lanes = reinterpret_cast<const lasec_at_lane_descriptor*>(bytes + c->lane_descriptor_offset);
    for (uint32_t i = 0; i < c->lane_count; ++i) {
        if (!mappingRing(lanes[i].metadata,
                         lanes[i].events, lanes[i].depth, lanes[i].event_stride, size)) return false;
    }
    auto* c2a = reinterpret_cast<const lasec_at_c2a_descriptor*>(bytes + c->c2a_descriptor_offset);
    if (c2a->metadata.offset + sizeof(lasec_at_ring_header) > size ||
        !mappingRing(c2a->metadata,
                     c2a->events, c2a->depth, c2a->event_stride, size)) return false;
    auto* endpoints = reinterpret_cast<const lasec_at_endpoint_descriptor*>(bytes + c->descriptor_offset);
    for (uint32_t i = 0; i < c->endpoint_count; ++i) {
        const auto& e = endpoints[i];
        if (e.endpoint_id != i || e.q2c_depth == 0 || e.q2c_depth > 1024 ||
            e.event_stride != sizeof(lasec_at_event) || e.payload_limit > LASEC_AT_EVENT_PAYLOAD ||
            !mappingRange(e.q2c_offset, uint64_t(e.q2c_depth) * e.event_stride, size, 64)) return false;
        bool owner = false;
        for (uint32_t j = 0; j < c->lane_count; ++j)
            owner = owner || (e.q2c_offset == lanes[j].events.offset && e.q2c_depth == lanes[j].depth);
        if (!owner) return false;
    }
    view = {c, endpoints, lanes,
            reinterpret_cast<const lasec_at_response_slot*>(bytes + c->response_slot_offset),
            reinterpret_cast<const lasec_at_snapshot_descriptor*>(bytes + c->snapshot_descriptor_offset), c2a};
    return true;
}

} // namespace lasecsimul::mcu::vnext
