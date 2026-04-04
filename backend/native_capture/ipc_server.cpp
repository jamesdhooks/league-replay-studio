/*
 * ipc_server.cpp -- Named-pipe IPC implementation
 * ------------------------------------------------
 * Simple synchronous named pipe server.  One client at a time
 * (our Python host).  Protocol: 4-byte LE length prefix + JSON.
 */

#include "ipc_server.h"
#include <cstdio>
#include <cstring>
#include <vector>

IPCServer::IPCServer() = default;

IPCServer::~IPCServer() {
    stop();
}

void IPCServer::run(CommandHandler handler) {
    running_ = true;

    while (running_) {
        // Create named pipe instance
        pipe_ = CreateNamedPipeA(
            PIPE_NAME,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,  // allow rapid reconnects
            65536,      // out buffer
            65536,      // in buffer
            100,        // default timeout ms
            nullptr     // default security
        );

        if (pipe_ == INVALID_HANDLE_VALUE) {
            fprintf(stderr, "[IPC] CreateNamedPipe failed: %lu\n", GetLastError());
            Sleep(1000);
            continue;
        }

        // Wait for a client to connect
        BOOL connected = ConnectNamedPipe(pipe_, nullptr)
                         ? TRUE
                         : (GetLastError() == ERROR_PIPE_CONNECTED);

        if (!connected || !running_) {
            CloseHandle(pipe_);
            pipe_ = INVALID_HANDLE_VALUE;
            continue;
        }

        fprintf(stderr, "[IPC] Client connected\n");

        // Read/write loop
        while (running_) {
            // Read 4-byte length prefix
            uint32_t msg_len = 0;
            DWORD bytes_read = 0;
            BOOL ok = ReadFile(pipe_, &msg_len, 4, &bytes_read, nullptr);
            if (!ok || bytes_read != 4) break;

            if (msg_len == 0 || msg_len > 1024 * 1024) break;  // sanity

            // Read JSON payload
            std::vector<char> buf(msg_len);
            DWORD total_read = 0;
            while (total_read < msg_len) {
                DWORD chunk = 0;
                ok = ReadFile(pipe_, buf.data() + total_read,
                              msg_len - total_read, &chunk, nullptr);
                if (!ok || chunk == 0) break;
                total_read += chunk;
            }
            if (total_read != msg_len) break;

            std::string cmd(buf.data(), msg_len);

            // Dispatch to handler
            std::string response = handler(cmd);

            // Write length-prefixed response
            uint32_t resp_len = static_cast<uint32_t>(response.size());
            DWORD written = 0;
            WriteFile(pipe_, &resp_len, 4, &written, nullptr);
            WriteFile(pipe_, response.data(), resp_len, &written, nullptr);
            FlushFileBuffers(pipe_);
        }

        fprintf(stderr, "[IPC] Client disconnected\n");
        DisconnectNamedPipe(pipe_);
        CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }
}

void IPCServer::stop() {
    running_ = false;
    if (pipe_ != INVALID_HANDLE_VALUE) {
        // Unblock ConnectNamedPipe / ReadFile by closing the handle
        CancelIoEx(pipe_, nullptr);
        CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }
}
