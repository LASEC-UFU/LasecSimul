cmake_minimum_required(VERSION 3.20)
project(Esp32McuAdapter CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(adapter SHARED src/Esp32Adapter.cpp)
target_include_directories(adapter PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)

set_target_properties(adapter PROPERTIES CXX_VISIBILITY_PRESET hidden)

# lasecsimul-cli build copia o artefato gerado para build/<plataforma>/adapter.{dll,so,dylib}
# conforme mcu.json (ver .spec/lasecsimul-native-devices.spec, secao 18).
