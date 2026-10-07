# The C++ build: one CMake target per layer (domain ← usecases ← adapters), the tests, and the strict flags they all compile with.
# In the app: nothing at runtime; `pnpm cpp:build` / `cpp:test` (so `pnpm check` and CI) configure it through CMakePresets.json.
# Used by: CMakePresets.json, stacks/cpp/run.mjs, stacks/cpp/gates.mjs, the edit hook (stacks/cpp/check-edited.mjs).
# Uses: cpp/** sources, cpp-layers.json (read by stacks/cpp/evaluated.mjs, not by CMake), GoogleTest (pinned by URL + sha256).
#
# A layer may link only the layers its cpp-layers.json row allows, so the linker and the include
# path are the first gate: domain has no other layer's headers on its include path. The build is
# not the whole check: stacks/cpp/evaluated.mjs reads what CMake actually configured (the File
# API), what the compiler actually included (ninja's deps), and what each layer's objects call
# (nm), so a relative #include, a stray include_directories, or a flag dropped in a preset fails
# there. Warnings are errors with a named set (CPP_WARNINGS); the sanitizers come from the presets.

cmake_minimum_required(VERSION 3.28)
project(notesync LANGUAGES CXX)

# Knob: the language floor (cpp.mdc → Toolchain). C++20: clang 18 and gcc 13 build all of it.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# No GNU dialect: the code must build the same on clang and gcc.
set(CMAKE_CXX_EXTENSIONS OFF)
# compile_commands.json is what clang-tidy reads.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
# No C++20 modules here. Scanning for them makes each compile command name a .modmap file that
# only a build writes, so clang-tidy on a configured but unbuilt tree (`pnpm cpp:lint` first) fails.
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)

# Knob: the warning set every first-party target compiles with. stacks/cpp/evaluated.mjs holds the
# floor (REQUIRED_WARNINGS) and refuses any -Wno-* or -w, so dropping one here fails the check.
set(CPP_WARNINGS
    -Wall
    -Wextra
    -Wpedantic
    -Wconversion
    -Wsign-conversion
    -Wshadow
    -Wold-style-cast
    -Wnon-virtual-dtor
    -Woverloaded-virtual
    -Wimplicit-fallthrough
    -Werror)

# Gives a first-party target its home directory's headers (PUBLIC, so a dependent sees them) and the warning set.
function(cpp_layer name)
  target_include_directories(${name} PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/cpp/${name}/include)
  target_compile_options(${name} PRIVATE ${CPP_WARNINGS})
endfunction()

# The layers. Each lists its own sources by name, so a file outside cpp/<layer>/ is never compiled in by a glob.
add_library(domain STATIC cpp/domain/src/note.cpp)
cpp_layer(domain)

add_library(usecases STATIC cpp/usecases/src/note_sync.cpp)
cpp_layer(usecases)
target_link_libraries(usecases PUBLIC domain)

add_library(adapters STATIC cpp/adapters/src/system_clock.cpp)
cpp_layer(adapters)
target_link_libraries(adapters PUBLIC usecases)

# Tests: GoogleTest through CTest. Pinned by release URL and sha256 (a replaced asset fails the
# download); SYSTEM keeps its headers out of our warning set. The presets set
# FETCHCONTENT_UPDATES_DISCONNECTED, so a configured tree never fetches again.
include(FetchContent)
FetchContent_Declare(
  googletest
  URL https://github.com/google/googletest/releases/download/v1.17.0/googletest-1.17.0.tar.gz
  URL_HASH SHA256=65fab701d9829d38cb77c14acdc431d2108bfdbf8979e40eb8ae567edf10b27c
  SYSTEM)
# gmock is not used; skipping it halves the dependency's build.
set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)
set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

enable_testing()
include(GoogleTest)

# A test executable over cpp/tests/<dir>; LABEL lets the TSan leg pick the fault tests (stacks/cpp/run.mjs).
function(cpp_test name label)
  add_executable(${name} ${ARGN})
  target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/cpp/tests)
  target_compile_options(${name} PRIVATE ${CPP_WARNINGS})
  target_link_libraries(${name} PRIVATE adapters GTest::gtest_main)
  # PRE_TEST: the list is read when CTest runs, so a test added since the last build is still found.
  gtest_discover_tests(${name} DISCOVERY_MODE PRE_TEST PROPERTIES LABELS ${label})
endfunction()

cpp_test(domain_tests unit cpp/tests/domain/note_test.cpp)
cpp_test(
  notesync_chaos_tests
  chaos
  cpp/tests/usecases/note_sync_chaos_test.cpp
  cpp/tests/chaos/fault_server.cpp
  cpp/tests/chaos/memory_outbox.cpp)
