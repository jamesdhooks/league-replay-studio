/*
 * main.cpp -- LRS Native Capture Service
 * ----------------------------------------
 * Standalone executable that:
 *   1. Creates a shared-memory region for frame transport
 *   2. Initialises DXGI Desktop Duplication capture
 *   3. Runs a capture loop writing frames into shared memory
 *   4. Listens on a named pipe for control commands from Python
 *
 * Frame flow:
 *   DXGI Desktop Dup → GPU texture → staging (CPU) → shared memory → Python reads
 *
 * IPC commands (JSON):
 *   {"cmd": "set_region", "x": 0, "y": 0, "w": 1920, "h": 1080}
 *   {"cmd": "status"}
 *   {"cmd": "stop"}
 *
 * Build:
 *   cmake -B build -S . && cmake --build build --config Release
 */

#include <cstdio>
#include <cstring>
#include <thread>
#include <atomic>
#include <string>
#include <chrono>
#include <windows.h>

#include "frame_buffer.h"
#include "capture_dxgi.h"
#include "ipc_server.h"

// ── Globals ──────────────────────────────────────────────────────────────

static std::atomic<bool> g_running{true};
static std::atomic<uint64_t> g_frame_count{0};
static std::atomic<double>   g_fps{0.0};
static DXGICapture g_capture;
static HANDLE g_shm_handle = nullptr;
static void*  g_shm_ptr    = nullptr;

// ── Shared memory setup ──────────────────────────────────────────────────

static bool createSharedMemory() {
    g_shm_handle = CreateFileMappingA(
        INVALID_HANDLE_VALUE,       // backed by page file
        nullptr,                    // default security
        PAGE_READWRITE,
        0, static_cast<DWORD>(SHM_SIZE),
        SHM_NAME
    );
    if (!g_shm_handle) {
        fprintf(stderr, "[SHM] CreateFileMapping failed: %lu\n", GetLastError());
        return false;
    }

    g_shm_ptr = MapViewOfFile(g_shm_handle, FILE_MAP_ALL_ACCESS, 0, 0, SHM_SIZE);
    if (!g_shm_ptr) {
        fprintf(stderr, "[SHM] MapViewOfFile failed: %lu\n", GetLastError());
        CloseHandle(g_shm_handle);
        g_shm_handle = nullptr;
        return false;
    }

    // Zero-initialise the header
    memset(g_shm_ptr, 0, sizeof(FrameHeader));
    fprintf(stderr, "[SHM] Created shared memory: %s (%zu bytes)\n",
            SHM_NAME, SHM_SIZE);
    return true;
}

static void destroySharedMemory() {
    if (g_shm_ptr)    { UnmapViewOfFile(g_shm_ptr); g_shm_ptr = nullptr; }
    if (g_shm_handle) { CloseHandle(g_shm_handle);  g_shm_handle = nullptr; }
}

// ── Capture thread ───────────────────────────────────────────────────────

static void captureThread() {
    fprintf(stderr, "[Capture] Thread started\n");

    auto fps_start = std::chrono::steady_clock::now();
    uint64_t fps_frames = 0;

    while (g_running) {
        auto* header = static_cast<FrameHeader*>(g_shm_ptr);
        uint8_t* pixel_data = static_cast<uint8_t*>(g_shm_ptr) + sizeof(FrameHeader);

        bool got_frame = g_capture.grabFrame(header, pixel_data);

        if (got_frame) {
            // Atomically publish the new frame
            header->frame_id = g_frame_count.fetch_add(1) + 1;
            fps_frames++;
        }

        // FPS calculation every second
        auto now = std::chrono::steady_clock::now();
        double elapsed = std::chrono::duration<double>(now - fps_start).count();
        if (elapsed >= 1.0) {
            g_fps.store(fps_frames / elapsed);
            fps_frames = 0;
            fps_start = now;
        }

        if (!got_frame) {
            // No new frame from DXGI; yield briefly
            Sleep(1);
        }
    }

    fprintf(stderr, "[Capture] Thread stopped\n");
}

// ── Simple JSON parsing helpers (no external deps) ───────────────────────

// Extract a string value for a key from a JSON object (minimal, no nesting)
static std::string jsonGetString(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    auto pos = json.find(search);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos);
    if (pos == std::string::npos) return "";
    pos = json.find('"', pos);
    if (pos == std::string::npos) return "";
    auto end = json.find('"', pos + 1);
    if (end == std::string::npos) return "";
    return json.substr(pos + 1, end - pos - 1);
}

// Extract an integer value for a key
static int jsonGetInt(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    auto pos = json.find(search);
    if (pos == std::string::npos) return 0;
    pos = json.find(':', pos);
    if (pos == std::string::npos) return 0;
    // Skip whitespace
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    try { return std::stoi(json.substr(pos)); }
    catch (...) { return 0; }
}

// ── Command handler ──────────────────────────────────────────────────────

static std::string handleCommand(const std::string& json_cmd) {
    std::string cmd = jsonGetString(json_cmd, "cmd");

    if (cmd == "set_region") {
        int x = jsonGetInt(json_cmd, "x");
        int y = jsonGetInt(json_cmd, "y");
        int w = jsonGetInt(json_cmd, "w");
        int h = jsonGetInt(json_cmd, "h");
        g_capture.setRegion(x, y, w, h);
        fprintf(stderr, "[CMD] set_region: %d,%d %dx%d\n", x, y, w, h);
        return "{\"status\":\"ok\"}";
    }

    if (cmd == "status") {
        char buf[256];
        snprintf(buf, sizeof(buf),
            "{\"status\":\"ok\",\"running\":true,\"frames\":%llu,\"fps\":%.1f}",
            static_cast<unsigned long long>(g_frame_count.load()),
            g_fps.load());
        return std::string(buf);
    }

    if (cmd == "stop") {
        g_running = false;
        return "{\"status\":\"ok\",\"message\":\"stopping\"}";
    }

    if (cmd == "ping") {
        return "{\"status\":\"ok\",\"message\":\"pong\"}";
    }

    return "{\"status\":\"error\",\"message\":\"unknown command\"}";
}

// ── CTRL+C handler ───────────────────────────────────────────────────────

static BOOL WINAPI ctrlHandler(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
        fprintf(stderr, "[Main] Shutdown signal received\n");
        g_running = false;
        return TRUE;
    }
    return FALSE;
}

// ── Entry point ──────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
    fprintf(stderr, "=== LRS Native Capture Service ===\n");
    SetConsoleCtrlHandler(ctrlHandler, TRUE);

    // Parse optional --output flag (monitor index, default 0)
    int output_idx = 0;
    for (int i = 1; i < argc; i++) {
        if (std::string(argv[i]) == "--output" && i + 1 < argc) {
            output_idx = std::atoi(argv[i + 1]);
            i++;
        }
    }

    // 1. Create shared memory
    if (!createSharedMemory()) {
        return 1;
    }

    // 2. Initialise DXGI capture
    if (!g_capture.init(output_idx)) {
        fprintf(stderr, "[Main] DXGI init failed: %s\n", g_capture.lastError().c_str());
        destroySharedMemory();
        return 1;
    }
    fprintf(stderr, "[Main] DXGI capture initialised on output %d\n", output_idx);

    // 3. Start capture thread
    std::thread cap_thread(captureThread);

    // 4. Run IPC server on main thread (blocks until stop)
    IPCServer ipc;
    std::thread ipc_thread([&ipc]() {
        ipc.run(handleCommand);
    });

    // Print ready marker for Python to detect
    fprintf(stdout, "READY\n");
    fflush(stdout);

    // Wait for shutdown signal
    while (g_running) {
        Sleep(100);
    }

    // Cleanup
    fprintf(stderr, "[Main] Shutting down...\n");
    ipc.stop();
    if (ipc_thread.joinable()) ipc_thread.join();
    if (cap_thread.joinable())  cap_thread.join();
    g_capture.shutdown();
    destroySharedMemory();

    fprintf(stderr, "[Main] Clean exit\n");
    return 0;
}
