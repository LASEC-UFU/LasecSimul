cmake_minimum_required(VERSION 3.20)
project(SimulideComplexDevices C)

add_library(device SHARED src/lib.c)
target_include_directories(device PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)
set_target_properties(device PROPERTIES C_VISIBILITY_PRESET hidden)

include(CTest)
if(BUILD_TESTING)
    add_executable(oled_atomic_frame_test test/oled_atomic_frame_test.c)
    target_include_directories(oled_atomic_frame_test PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)
    add_test(NAME oled_atomic_frame COMMAND oled_atomic_frame_test)
endif()
