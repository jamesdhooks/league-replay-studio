/*
 * capture_wgc.cpp  --  Windows Graphics Capture implementation
 * -------------------------------------------------------------
 * Captures an application window HWND via the Windows.Graphics.Capture
 * WinRT API.  Frames arrive in a callback, are stored as a D3D11 texture,
 * and are converted BGRA -> BGR24 in grabFrame() for the shared-memory
 * transport.
 *
 * C++/WinRT is used (part of the Windows SDK >= 10.0.17763).
 */

// ── MUST come before any WinRT headers ────────────────────────────────────
#include <unknwn.h>

// ── C++/WinRT headers ─────────────────────────────────────────────────────
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
// COM interop headers that expose WGC factory + D3D exchange interfaces
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#pragma comment(lib, "windowsapp")

// ── Standard Win32 / D3D11 ────────────────────────────────────────────────
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

#include "capture_wgc.h"
#include "frame_buffer.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>

namespace wrt   = winrt;
namespace wgc   = winrt::Windows::Graphics::Capture;
namespace wgdx  = winrt::Windows::Graphics::DirectX;
namespace wgd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

// ── Helper: D3D11 device -> WinRT IDirect3DDevice ─────────────────────────
static HRESULT WrapD3DDevice(
    ID3D11Device*              d3d_device,
    wgd3d::IDirect3DDevice&    out)
{
    wrt::com_ptr<IDXGIDevice> dxgi;
    HRESULT hr = d3d_device->QueryInterface(IID_PPV_ARGS(dxgi.put()));
    if (FAILED(hr)) return hr;

    wrt::com_ptr<IInspectable> inspectable;
    hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put());
    if (FAILED(hr)) return hr;

    out = inspectable.as<wgd3d::IDirect3DDevice>();
    return S_OK;
}

// ── Pimpl ─────────────────────────────────────────────────────────────────
struct WGCCapture::Impl {
    // D3D11 (created once; shared for entire lifetime)
    wrt::com_ptr<ID3D11Device>         device;
    wrt::com_ptr<ID3D11DeviceContext>   context;
    wgd3d::IDirect3DDevice             winrt_device{ nullptr };

    // CPU-readable staging texture (recreated on resolution change)
    wrt::com_ptr<ID3D11Texture2D>       staging;
    int staging_w = 0, staging_h = 0;

    // Active WGC objects
    wgc::GraphicsCaptureItem            capture_item{ nullptr };
    wgc::Direct3D11CaptureFramePool     frame_pool{ nullptr };
    wgc::GraphicsCaptureSession         session{ nullptr };
    wrt::event_token                    frame_token{};
    bool                                running = false;

    // Latest captured frame (written by WGC callback, read by grabFrame)
    std::mutex                          mtx;
    wrt::com_ptr<ID3D11Texture2D>       pending_tex;
    bool                                has_new   = false;
    int                                 frame_w   = 0;
    int                                 frame_h   = 0;

    // Monotonic counter used to detect new frames
    uint64_t grab_seq = 0;
};

// ── WGCCapture ────────────────────────────────────────────────────────────
WGCCapture::WGCCapture() : impl_(new Impl{}) {
    // Initialise a multi-threaded WinRT apartment for this thread.
    // If the process has already called RoInitialize, this is a no-op.
    try {
        wrt::init_apartment(wrt::apartment_type::multi_threaded);
    } catch (...) {}
}

WGCCapture::~WGCCapture() {
    shutdown();
    delete impl_;
}

// static
bool WGCCapture::isAvailable() {
    // VerifyVersionInfoW lies about the OS version unless the application has
    // a Windows 10 compatibility manifest entry.  RtlGetVersion (ntdll) always
    // returns the true build number, so use it instead.
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return false;
    using PFN_RtlGetVersion = NTSTATUS(WINAPI*)(PRTL_OSVERSIONINFOW);
    auto fn = reinterpret_cast<PFN_RtlGetVersion>(
        GetProcAddress(ntdll, "RtlGetVersion"));
    if (!fn) return false;
    RTL_OSVERSIONINFOW vi{};
    vi.dwOSVersionInfoSize = sizeof(vi);
    if (fn(&vi) != 0 /* STATUS_SUCCESS */) return false;
    // WGC requires Windows 10 build 17134+ (1803)
    return vi.dwMajorVersion > 10 ||
           (vi.dwMajorVersion == 10 && vi.dwBuildNumber >= 17134);
}

bool WGCCapture::init(HWND hwnd) {
    if (!isAvailable()) {
        last_error_ = "Windows Graphics Capture requires Windows 10 1803+";
        return false;
    }

    // Create D3D11 device with BGRA support (mandatory for WGC)
    if (!impl_->device) {
        D3D_FEATURE_LEVEL feat_level;
        HRESULT hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr, 0,
            D3D11_SDK_VERSION,
            impl_->device.put(),
            &feat_level,
            impl_->context.put());
        if (FAILED(hr)) {
            last_error_ = "[WGC] D3D11CreateDevice failed: " + std::to_string(hr);
            return false;
        }

        hr = WrapD3DDevice(impl_->device.get(), impl_->winrt_device);
        if (FAILED(hr)) {
            last_error_ = "[WGC] WrapD3DDevice failed: " + std::to_string(hr);
            impl_->device  = nullptr;
            impl_->context = nullptr;
            return false;
        }
    }

    return startCapture(hwnd);
}

bool WGCCapture::setHwnd(HWND hwnd) {
    if (hwnd == hwnd_ && impl_->running) return true;  // nothing to do
    if (!impl_->device) return init(hwnd);
    stopCapture();
    return startCapture(hwnd);
}

bool WGCCapture::startCapture(HWND hwnd) {
    try {
        // Get the WGC interop factory and create a capture item for the HWND
        auto interop = wrt::get_activation_factory<
            wgc::GraphicsCaptureItem,
            IGraphicsCaptureItemInterop>();

        wgc::GraphicsCaptureItem item{ nullptr };
        HRESULT hr = interop->CreateForWindow(
            hwnd,
            wrt::guid_of<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem>(),
            wrt::put_abi(item));
        if (FAILED(hr)) {
            last_error_ = "[WGC] CreateForWindow HWND=" +
                          std::to_string(reinterpret_cast<uintptr_t>(hwnd)) +
                          " failed: " + std::to_string(hr);
            return false;
        }

        auto size = item.Size();
        fprintf(stderr, "[WGC] Capturing HWND %p  (%dx%d)\n",
                (void*)hwnd, size.Width, size.Height);

        // Create a frame pool using CreateFreeThreaded so that FrameArrived
        // callbacks are delivered on a WinRT thread-pool thread.  The regular
        // Create() requires a DispatcherQueue (message pump), which a console
        // app does not have — causing callbacks to never fire.
        auto pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
            impl_->winrt_device,
            wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size);

        // Register frame-arrived callback
        // The lambda captures impl_ (raw pointer -- safe as long as the
        // WGCCapture object outlives the session, which shutdown() ensures).
        auto* pimpl = impl_;
        auto token = pool.FrameArrived(
            [pimpl](wgc::Direct3D11CaptureFramePool const& sender,
                    wrt::Windows::Foundation::IInspectable const&)
            {
                auto frame = sender.TryGetNextFrame();
                if (!frame) return;

                // Extract the underlying D3D11 texture from the WGC surface
                auto surface = frame.Surface();
                auto access  = surface.as<
                    ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
                wrt::com_ptr<ID3D11Texture2D> tex;
                if (FAILED(access->GetInterface(IID_PPV_ARGS(tex.put())))) return;

                auto cs = frame.ContentSize();
                {
                    std::lock_guard<std::mutex> lk(pimpl->mtx);
                    pimpl->pending_tex = tex;
                    pimpl->has_new     = true;
                    pimpl->frame_w     = cs.Width;
                    pimpl->frame_h     = cs.Height;
                }
            });

        // Create session -- disable cursor so we see clean game content
        auto session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled(false);

        // Win11+: remove the yellow capture border if available
        try { session.IsBorderRequired(false); } catch (...) {}

        // Store everything and start
        impl_->capture_item  = item;
        impl_->frame_pool    = pool;
        impl_->session       = session;
        impl_->frame_token   = token;
        impl_->running       = true;
        hwnd_                = hwnd;

        session.StartCapture();
        fprintf(stderr, "[WGC] Capture started for HWND %p\n", (void*)hwnd);
        return true;

    } catch (wrt::hresult_error const& e) {
        last_error_ = "[WGC] hresult_error: " + wrt::to_string(e.message());
        return false;
    } catch (std::exception const& e) {
        last_error_ = std::string("[WGC] exception: ") + e.what();
        return false;
    }
}

void WGCCapture::stopCapture() {
    try {
        if (impl_->frame_pool) {
            impl_->frame_pool.FrameArrived(impl_->frame_token);  // unregister
        }
        if (impl_->session) {
            impl_->session.Close();
            impl_->session = nullptr;
        }
        if (impl_->frame_pool) {
            impl_->frame_pool.Close();
            impl_->frame_pool = nullptr;
        }
    } catch (...) {}

    impl_->capture_item = nullptr;
    impl_->frame_token  = {};
    impl_->running      = false;
    hwnd_               = nullptr;

    std::lock_guard<std::mutex> lk(impl_->mtx);
    impl_->pending_tex = nullptr;
    impl_->has_new     = false;
}

bool WGCCapture::grabFrame(FrameHeader* header, uint8_t* pixel_data) {
    // Collect latest pending frame under lock
    wrt::com_ptr<ID3D11Texture2D> tex;
    int w, h;
    {
        std::lock_guard<std::mutex> lk(impl_->mtx);
        if (!impl_->has_new || !impl_->pending_tex) return false;
        tex            = impl_->pending_tex;
        w              = impl_->frame_w;
        h              = impl_->frame_h;
        impl_->has_new = false;
    }

    if (w <= 0 || h <= 0) return false;

    // (Re)create staging texture when dimensions change
    if (w != impl_->staging_w || h != impl_->staging_h || !impl_->staging) {
        impl_->staging = nullptr;

        D3D11_TEXTURE2D_DESC desc{};
        desc.Width            = static_cast<UINT>(w);
        desc.Height           = static_cast<UINT>(h);
        desc.MipLevels        = 1;
        desc.ArraySize        = 1;
        desc.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.Usage            = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags   = D3D11_CPU_ACCESS_READ;

        HRESULT hr = impl_->device->CreateTexture2D(
            &desc, nullptr, impl_->staging.put());
        if (FAILED(hr)) {
            last_error_ = "[WGC] CreateTexture2D(staging) failed: " +
                          std::to_string(hr);
            return false;
        }
        impl_->staging_w = w;
        impl_->staging_h = h;
        fprintf(stderr, "[WGC] Staging texture (re)created: %dx%d\n", w, h);
    }

    // GPU copy: WGC texture -> CPU-readable staging
    impl_->context->CopyResource(impl_->staging.get(), tex.get());

    // Map the staging texture
    D3D11_MAPPED_SUBRESOURCE mapped{};
    HRESULT hr = impl_->context->Map(
        impl_->staging.get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
        last_error_ = "[WGC] Map staging failed: " + std::to_string(hr);
        return false;
    }

    // Convert BGRA32 -> BGR24 row by row
    const uint32_t dst_stride = static_cast<uint32_t>(w) * 3;
    const uint32_t data_size  = dst_stride * static_cast<uint32_t>(h);

    if (data_size > MAX_FRAME_BYTES) {
        impl_->context->Unmap(impl_->staging.get(), 0);
        last_error_ = "[WGC] Frame too large for SHM buffer";
        return false;
    }

    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    uint8_t*       dst = pixel_data;
    for (int row = 0; row < h; ++row) {
        const uint8_t* sr = src + static_cast<ptrdiff_t>(row) * mapped.RowPitch;
        uint8_t*       dr = dst + static_cast<ptrdiff_t>(row) * dst_stride;
        for (int col = 0; col < w; ++col) {
            dr[col * 3 + 0] = sr[col * 4 + 0]; // B
            dr[col * 3 + 1] = sr[col * 4 + 1]; // G
            dr[col * 3 + 2] = sr[col * 4 + 2]; // R
        }
    }

    impl_->context->Unmap(impl_->staging.get(), 0);

    header->width        = static_cast<uint32_t>(w);
    header->height       = static_cast<uint32_t>(h);
    header->stride       = dst_stride;
    header->pixel_format = 0;   // BGR24
    header->data_size    = data_size;

    return true;
}

void WGCCapture::shutdown() {
    stopCapture();
    impl_->staging     = nullptr;
    impl_->staging_w   = impl_->staging_h = 0;
    impl_->winrt_device = nullptr;
    impl_->context     = nullptr;
    impl_->device      = nullptr;
}
