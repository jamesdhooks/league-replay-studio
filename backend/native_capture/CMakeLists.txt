cmake_minimum_required(VERSION 3.20)
project(lrs_capture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(lrs_capture
    main.cpp
    capture_dxgi.cpp
    capture_dxgi.h
    ipc_server.cpp
    ipc_server.h
    frame_buffer.h
)

# Link Windows desktop duplication / GDI / D3D11
target_link_libraries(lrs_capture PRIVATE
    d3d11
    dxgi
    user32
    gdi32
)

# Static CRT so the exe is self-contained (no vcruntime DLL needed)
set_property(TARGET lrs_capture PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
