#pragma once
/*
 * ipc_server.h -- Named-pipe IPC for Python ↔ C++ commands
 * ---------------------------------------------------------
 * The Python host sends JSON commands; the C++ service responds
 * with JSON status messages.
 *
 * Protocol: length-prefixed JSON messages.
 *   [4 bytes little-endian uint32: message length][JSON payload]
 */

#include <string>
#include <functional>
#include <windows.h>

class IPCServer {
public:
    using CommandHandler = std::function<std::string(const std::string& json_cmd)>;

    IPCServer();
    ~IPCServer();

    // Start listening on the named pipe. Blocks until stop() is called.
    // handler is called for each incoming command; its return value is
    // sent back to the client.
    void run(CommandHandler handler);

    // Signal the server to stop.
    void stop();

    static constexpr const char* PIPE_NAME = "\\\\.\\pipe\\LRS_CaptureControl";

private:
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    volatile bool running_ = false;
};
