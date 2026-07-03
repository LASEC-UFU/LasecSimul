cmake_minimum_required(VERSION 3.20)
project(SimulideSensors C)

add_library(device SHARED src/lib.c)
target_include_directories(device PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)
target_link_libraries(device PRIVATE m)
set_target_properties(device PROPERTIES C_VISIBILITY_PRESET hidden)
