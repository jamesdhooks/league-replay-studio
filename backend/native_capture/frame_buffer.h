#pragma once
/*
 * frame_buffer.h -- Shared-memory frame transport
 * ------------------------------------------------
 * Layout of the shared memory region used to pass frames from the C++
 * capture service to the Python host.
 *
 * The Python side maps the same region and reads frame data directly --
 * zero-copy, no serialization, no pipe throughput limits.
 *
 * Synchronisation: the producer (C++) atomically increments frame_id
 * after writing the frame.  The consumer (Python) polls frame_id and
 * reads only when it changes.  Because there is exactly one producer
 * and one consumer, a simple atomic counter is sufficient.
 */

#include <cstdint>

// Shared memory object name (must match Python side)
static constexpr const char* SHM_NAME = "Local\\LRS_CaptureFrame";

// Maximum frame size: 4K BGRA = 3840 * 2160 * 4 = ~33 MB
// We allocate a generous fixed region; actual frame may be smaller.
static constexpr uint32_t MAX_FRAME_BYTES = 3840 * 2160 * 4;

#pragma pack(push, 1)
struct FrameHeader {
    volatile uint64_t frame_id;     // incremented by producer after each frame
    uint32_t          width;        // frame width in pixels
    uint32_t          height;       // frame height in pixels
    uint32_t          stride;       // bytes per row (may include padding)
    uint32_t          pixel_format; // 0 = BGR24, 1 = BGRA32
    uint32_t          data_size;    // actual byte count of frame data
    uint32_t          _reserved[3]; // alignment padding
};
#pragma pack(pop)

// Total shared memory size: header + max payload
static constexpr size_t SHM_SIZE = sizeof(FrameHeader) + MAX_FRAME_BYTES;
