/*
 * capture_dxgi.cpp -- DXGI Desktop Duplication implementation
 * -----------------------------------------------------------
 * Uses the Desktop Duplication API to capture frames from a
 * specific monitor output region.
 */

#include "capture_dxgi.h"
#include "frame_buffer.h"
#include <cstring>
#include <algorithm>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

DXGICapture::DXGICapture() = default;

DXGICapture::~DXGICapture() {
    shutdown();
}

bool DXGICapture::init(int output_index) {
    if (!initDevice(output_index)) return false;
    if (!initDuplication())        return false;
    return true;
}

bool DXGICapture::initDevice(int output_index) {
    // Create D3D11 device
    D3D_FEATURE_LEVEL feature_level;
    HRESULT hr = D3D11CreateDevice(
        nullptr,                    // default adapter
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,                    // no software rasterizer
        0,                          // flags
        nullptr, 0,                 // default feature levels
        D3D11_SDK_VERSION,
        &device_,
        &feature_level,
        &context_
    );
    if (FAILED(hr)) {
        last_error_ = "D3D11CreateDevice failed: " + std::to_string(hr);
        return false;
    }

    // Get DXGI device -> adapter -> output
    IDXGIDevice* dxgi_device = nullptr;
    hr = device_->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgi_device);
    if (FAILED(hr)) {
        last_error_ = "QueryInterface(IDXGIDevice) failed";
        return false;
    }

    IDXGIAdapter* adapter = nullptr;
    hr = dxgi_device->GetParent(__uuidof(IDXGIAdapter), (void**)&adapter);
    dxgi_device->Release();
    if (FAILED(hr)) {
        last_error_ = "GetParent(IDXGIAdapter) failed";
        return false;
    }

    IDXGIOutput* output = nullptr;
    hr = adapter->EnumOutputs(output_index, &output);
    adapter->Release();
    if (FAILED(hr)) {
        last_error_ = "EnumOutputs(" + std::to_string(output_index) + ") failed";
        return false;
    }

    // Get output dimensions
    DXGI_OUTPUT_DESC desc;
    output->GetDesc(&desc);
    output_w_ = desc.DesktopCoordinates.right  - desc.DesktopCoordinates.left;
    output_h_ = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;

    // Duplicate output
    IDXGIOutput1* output1 = nullptr;
    hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1);
    output->Release();
    if (FAILED(hr)) {
        last_error_ = "QueryInterface(IDXGIOutput1) failed (need Win8+)";
        return false;
    }

    hr = output1->DuplicateOutput(device_, &duplication_);
    output1->Release();
    if (FAILED(hr)) {
        last_error_ = "DuplicateOutput failed: " + std::to_string(hr);
        return false;
    }

    return true;
}

bool DXGICapture::initDuplication() {
    // Create a CPU-readable staging texture sized to the crop region
    int w = has_region_ ? region_w_ : output_w_;
    int h = has_region_ ? region_h_ : output_h_;

    if (w <= 0 || h <= 0) {
        last_error_ = "Invalid dimensions for staging texture";
        return false;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width              = w;
    desc.Height             = h;
    desc.MipLevels          = 1;
    desc.ArraySize          = 1;
    desc.Format             = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count   = 1;
    desc.Usage              = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags     = D3D11_CPU_ACCESS_READ;

    HRESULT hr = device_->CreateTexture2D(&desc, nullptr, &staging_);
    if (FAILED(hr)) {
        last_error_ = "CreateTexture2D(staging) failed: " + std::to_string(hr);
        return false;
    }

    return true;
}

void DXGICapture::setRegion(int x, int y, int w, int h) {
    region_x_ = x;
    region_y_ = y;
    region_w_ = w;
    region_h_ = h;
    has_region_ = (w > 0 && h > 0);

    // Recreate staging texture if duplication is already active
    if (staging_) {
        staging_->Release();
        staging_ = nullptr;
    }
    if (device_) {
        initDuplication();
    }
}

bool DXGICapture::grabFrame(FrameHeader* header, uint8_t* pixel_data) {
    if (!duplication_ || !staging_) return false;

    IDXGIResource* resource = nullptr;
    DXGI_OUTDUPL_FRAME_INFO frame_info;

    // Try to acquire a frame (timeout 16ms ≈ 60 FPS)
    HRESULT hr = duplication_->AcquireNextFrame(16, &frame_info, &resource);

    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        return false;  // No new frame -- normal
    }

    if (hr == DXGI_ERROR_ACCESS_LOST) {
        // Desktop mode change (resolution, fullscreen toggle, etc.)
        last_error_ = "Access lost -- need reinit";
        if (resource) resource->Release();
        shutdown();
        return false;
    }

    if (FAILED(hr)) {
        last_error_ = "AcquireNextFrame failed: " + std::to_string(hr);
        if (resource) resource->Release();
        return false;
    }

    // Get the desktop texture
    ID3D11Texture2D* desktop_tex = nullptr;
    hr = resource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&desktop_tex);
    resource->Release();
    if (FAILED(hr)) {
        duplication_->ReleaseFrame();
        return false;
    }

    int crop_x = has_region_ ? region_x_ : 0;
    int crop_y = has_region_ ? region_y_ : 0;
    int crop_w = has_region_ ? region_w_ : output_w_;
    int crop_h = has_region_ ? region_h_ : output_h_;

    // Clamp to output bounds
    crop_w = (std::min)(crop_w, output_w_ - crop_x);
    crop_h = (std::min)(crop_h, output_h_ - crop_y);

    // Copy the cropped region from desktop texture to staging
    D3D11_BOX box = {};
    box.left   = crop_x;
    box.top    = crop_y;
    box.right  = crop_x + crop_w;
    box.bottom = crop_y + crop_h;
    box.front  = 0;
    box.back   = 1;

    context_->CopySubresourceRegion(staging_, 0, 0, 0, 0, desktop_tex, 0, &box);
    desktop_tex->Release();

    // Map the staging texture to CPU memory
    D3D11_MAPPED_SUBRESOURCE mapped;
    hr = context_->Map(staging_, 0, D3D11_MAP_READ, 0, &mapped);
    duplication_->ReleaseFrame();

    if (FAILED(hr)) {
        last_error_ = "Map staging texture failed: " + std::to_string(hr);
        return false;
    }

    // Convert BGRA (32-bit) → BGR (24-bit) row by row into shared memory
    uint32_t dst_stride = crop_w * 3;
    uint32_t data_size  = dst_stride * crop_h;

    if (data_size > MAX_FRAME_BYTES) {
        context_->Unmap(staging_, 0);
        last_error_ = "Frame too large for shared memory buffer";
        return false;
    }

    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    uint8_t* dst = pixel_data;

    for (int row = 0; row < crop_h; ++row) {
        const uint8_t* src_row = src + row * mapped.RowPitch;
        uint8_t* dst_row = dst + row * dst_stride;
        for (int col = 0; col < crop_w; ++col) {
            dst_row[col * 3 + 0] = src_row[col * 4 + 0]; // B
            dst_row[col * 3 + 1] = src_row[col * 4 + 1]; // G
            dst_row[col * 3 + 2] = src_row[col * 4 + 2]; // R
        }
    }

    context_->Unmap(staging_, 0);

    // Fill the header
    header->width        = crop_w;
    header->height       = crop_h;
    header->stride       = dst_stride;
    header->pixel_format = 0;  // BGR24
    header->data_size    = data_size;

    return true;
}

void DXGICapture::shutdown() {
    if (staging_)     { staging_->Release();     staging_     = nullptr; }
    if (duplication_) { duplication_->Release(); duplication_ = nullptr; }
    if (context_)     { context_->Release();     context_     = nullptr; }
    if (device_)      { device_->Release();      device_      = nullptr; }
}
