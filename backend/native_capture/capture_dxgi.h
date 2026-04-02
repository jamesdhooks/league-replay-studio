#pragma once
/*
 * capture_dxgi.h -- DXGI Desktop Duplication capture engine
 * ---------------------------------------------------------
 * Captures the desktop region where iRacing renders using the
 * Desktop Duplication API (DXGI 1.2+, Windows 8+).
 *
 * This captures whatever is ON SCREEN at the specified coordinates,
 * which means it works regardless of window focus.
 *
 * The captured texture is copied to a CPU-readable staging texture,
 * then memcpy'd into the shared memory frame buffer.
 */

#include <cstdint>
#include <string>
#include <atomic>
#include <d3d11.h>
#include <dxgi1_2.h>

struct FrameHeader;

class DXGICapture {
public:
    DXGICapture();
    ~DXGICapture();

    // Initialise D3D11 device and output duplication for the given region.
    // Returns true on success.
    bool init(int output_index = 0);

    // Capture one frame into the provided shared-memory buffer.
    // Returns true if a new frame was written.
    // MUST be called only from the capture thread.
    bool grabFrame(FrameHeader* header, uint8_t* pixel_data);

    // Set the crop region (iRacing window rect in desktop coordinates).
    // Thread-safe: stores the values atomically; the staging texture is
    // recreated inside grabFrame() on the next call from the capture thread.
    void setRegion(int x, int y, int w, int h);

    // Release all COM resources.
    void shutdown();

    std::string lastError() const { return last_error_; }

private:
    bool initDevice(int output_index);
    bool initDuplication();

    ID3D11Device*           device_      = nullptr;
    ID3D11DeviceContext*    context_     = nullptr;
    IDXGIOutputDuplication* duplication_ = nullptr;
    ID3D11Texture2D*        staging_     = nullptr;

    // Crop region (desktop coordinates) — read/written only on the capture thread
    int region_x_ = 0, region_y_ = 0;
    int region_w_ = 0, region_h_ = 0;
    bool has_region_ = false;

    // Pending region update written by setRegion() (any thread),
    // consumed and applied by grabFrame() (capture thread only).
    std::atomic<int>  pending_x_{0}, pending_y_{0};
    std::atomic<int>  pending_w_{0}, pending_h_{0};
    std::atomic<bool> region_dirty_{false};

    // Full output dimensions
    int output_w_ = 0, output_h_ = 0;

    std::string last_error_;
};
