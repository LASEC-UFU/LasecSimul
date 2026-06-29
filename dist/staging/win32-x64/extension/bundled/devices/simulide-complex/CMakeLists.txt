cmake_minimum_required(VERSION 3.20)
project(SimulideComplexDevices C)

add_library(device SHARED src/lib.c)
target_include_directories(device PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)
set_target_properties(device PROPERTIES C_VISIBILITY_PRESET hidden)

