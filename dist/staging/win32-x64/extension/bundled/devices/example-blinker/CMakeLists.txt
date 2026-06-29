cmake_minimum_required(VERSION 3.20)
project(ExampleBlinkerDevice C)

add_library(device SHARED src/lib.c)
target_include_directories(device PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)

set_target_properties(device PROPERTIES C_VISIBILITY_PRESET hidden)

# lasecsimul-cli build copia o artefato gerado para build/<plataforma>/device.{dll,so,dylib}
# conforme device.json (ver .spec/lasecsimul-native-devices.spec, secao 18).
