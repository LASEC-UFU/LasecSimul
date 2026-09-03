#ifndef LASECSIMUL_ARTIFACT_TRANSPORT_ABI_H
#define LASECSIMUL_ARTIFACT_TRANSPORT_ABI_H

#include <stdint.h>

#define LASEC_AT_MAGIC UINT64_C(0x4C415443564E4251)
#define LASEC_AT_ABI_MAJOR 1u
#define LASEC_AT_ABI_MINOR 0u
#define LASEC_AT_MAX_LANES 16u
#define LASEC_AT_MAX_ENDPOINTS 64u
#define LASEC_AT_MAX_RESPONSES 16u
#define LASEC_AT_MAX_SNAPSHOTS 64u
#define LASEC_AT_EVENT_PAYLOAD 64u
#define LASEC_AT_SNAPSHOT_BYTES 64u
#define LASEC_AT_BATCH_MAX_SEGMENTS 16u
#define LASEC_AT_CAP_KNOWN_MASK UINT64_C(0)
#define LASEC_AT_CAP_REQUIRED_MASK UINT64_C(0)

typedef enum lasec_at_state { LASEC_AT_CREATED=0, LASEC_AT_STARTING=1, LASEC_AT_READY=2,
  LASEC_AT_RUNNING=3, LASEC_AT_STOPPING=4, LASEC_AT_STOPPED=5, LASEC_AT_FAILED=6 } lasec_at_state;

typedef struct lasec_at_event {
  uint64_t timestamp_ns;
  uint64_t lane_sequence;
  uint32_t kind;
  uint32_t flags;
  uint32_t endpoint_id;
  uint32_t payload_bytes;
  uint8_t payload[LASEC_AT_EVENT_PAYLOAD];
} lasec_at_event;

typedef struct lasec_at_endpoint_descriptor {
  uint32_t endpoint_id;
  uint32_t kind;
  uint64_t q2c_offset;
  uint64_t c2a_offset;
  uint64_t snapshot_offset;
  uint32_t q2c_depth;
  uint32_t event_stride;
  uint32_t payload_limit;
  uint32_t reserved;
} lasec_at_endpoint_descriptor;

typedef struct lasec_at_region_descriptor { uint64_t offset; uint64_t bytes; uint32_t stride; uint32_t count; } lasec_at_region_descriptor;
typedef struct lasec_at_lane_descriptor { lasec_at_region_descriptor metadata; lasec_at_region_descriptor events; uint32_t depth; uint32_t event_stride; } lasec_at_lane_descriptor;
typedef struct lasec_at_snapshot_descriptor { lasec_at_region_descriptor storage; uint32_t schema_id; uint32_t reserved; } lasec_at_snapshot_descriptor;
typedef struct lasec_at_c2a_descriptor { lasec_at_region_descriptor metadata; lasec_at_region_descriptor events; uint32_t depth; uint32_t event_stride; } lasec_at_c2a_descriptor;

typedef struct lasec_at_control_page {
  uint64_t magic;
  uint32_t abi_major;
  uint32_t abi_minor;
  uint64_t mapping_bytes;
  uint64_t execution_id;
  uint32_t lane_count;
  uint32_t response_slot_count;
  uint32_t descriptor_count;
  uint32_t descriptor_capacity;
  uint64_t descriptor_offset;
  uint64_t q2c_offset;
  uint64_t c2a_offset;
  uint64_t snapshot_offset;
  uint64_t core_progress_ns;
  uint64_t artifact_progress_ns;
  uint32_t core_state;
  uint32_t artifact_state;
  uint32_t core_fatal_code;
  uint32_t artifact_fatal_code;
  uint64_t core_fatal_seq;
  uint64_t artifact_fatal_seq;
  uint64_t capability_bits;
  uint32_t endpoint_count;
  uint32_t snapshot_count;
  uint64_t lane_descriptor_offset;
  uint64_t response_slot_offset;
  uint64_t snapshot_descriptor_offset;
  uint64_t c2a_descriptor_offset;
} lasec_at_control_page;

typedef struct lasec_at_response_slot {
  uint64_t request_seq;
  uint64_t response_seq;
  int32_t status;
  uint32_t payload_bytes;
  uint8_t payload[LASEC_AT_EVENT_PAYLOAD];
} lasec_at_response_slot;

typedef struct lasec_at_ring_header { uint64_t write_seq; uint64_t read_seq; } lasec_at_ring_header;
typedef struct lasec_at_snapshot { uint64_t publish_seq; uint8_t data[LASEC_AT_SNAPSHOT_BYTES]; } lasec_at_snapshot;

#endif
