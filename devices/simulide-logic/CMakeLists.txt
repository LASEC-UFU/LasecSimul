cmake_minimum_required(VERSION 3.20)
project(SimulideLogicDevices C)

add_library(device SHARED src/lib.c)
target_include_directories(device PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)
set_target_properties(device PROPERTIES C_VISIBILITY_PRESET hidden)

include(CTest)
if(BUILD_TESTING)
    add_executable(i2c_slave_timing_test test/i2c_slave_timing_test.c)
    target_include_directories(i2c_slave_timing_test PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)
    add_test(NAME i2c_slave_timing COMMAND i2c_slave_timing_test)
endif()
