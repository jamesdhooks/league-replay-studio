#pragma once
/*
 * capture_wgc.h  --  Windows Graphics Capture (WGC) window capture
 * -----------------------------------------------------------------
 * Uses the modern Windows.Graphics.Capture WinRT API to capture a
 * specific application window (by HWND) directly from DWM.
 *
 * Unlike DXGI Desktop Duplication (which captures the entire monitor
 * and then crops), WGC captures only the target window's compositor
 * surface -- so it always shows the correct window content regardless
 * of what windows are in front or what focus state iRacing is in.
 *
 * Requirements:
 *   - Windows 10 version 1803 (build 17134) or later
 *   - D3D11_CREATE_DEVICE_BGRA_SUPPORT
 *   - Linked against: d3d11, dxgi, windowsapp
 *   - Compiled with /std:c++17
 *
 * Thread-safety:
 *   grabFrame() may be called from any thread.
 *   setHwnd() must NOT be called concurrently with grabFrame(); the
 *   caller (capture thread) should serialise them.
 */

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdint>
#include <string>

struct FrameHeader;

class WGCCapture {
public:
    WGCCapture();
    ~WGCCapture();

    // Returns true if WGC is available on this system (Win 10 1803+).
    static bool isAvailable();

    // Start capturing hwnd.  Returns true on success.
    // Initialises D3D11 + WGC objects on first call.
    bool init(HWND hwnd);

    // Switch to a different target window without tearing down D3D.
    // Safe to call when already running; no-op if hwnd is unchanged.
    bool setHwnd(HWND hwnd);

    // Copy the latest frame into the shared-memory layout.
    // Returns true when a new frame was written (frame_id will increment
    // on the caller side).
    bool grabFrame(FrameHeader* header, uint8_t* pixel_data);

    // Release all WGC and D3D11 resources.
    void shutdown();

    std::string lastError() const { return last_error_; }

private:
    bool startCapture(HWND hwnd);
    void stopCapture();

    // Pimpl -- keeps WinRT headers out of this header.
    struct Impl;
    Impl*       impl_    = nullptr;
    HWND        hwnd_    = nullptr;
    std::string last_error_;
};
