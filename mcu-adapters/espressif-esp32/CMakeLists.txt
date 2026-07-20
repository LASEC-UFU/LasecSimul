cmake_minimum_required(VERSION 3.20)
project(Esp32McuAdapter CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(adapter SHARED src/Esp32Adapter.cpp)
if(WIN32)
  target_compile_definitions(adapter PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
endif()
target_include_directories(adapter PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)

set_target_properties(adapter PROPERTIES CXX_VISIBILITY_PRESET hidden)

# dladdr() (resolveOwnModuleDirectory em Esp32Adapter.cpp -- acha o romDir do QEMU relativo ao
# proprio .so, nunca ao CWD do processo do Core) exige linkar libdl explicitamente em glibc.
if(NOT WIN32)
  target_link_libraries(adapter PRIVATE ${CMAKE_DL_LIBS})
endif()

# <filesystem> (resolveDefaultRomDir) faz este alvo passar a depender de libstdc++/libgcc em tempo
# de execucao no MinGW (libstdc++-6.dll/libgcc_s_seh-1.dll, confirmado via `objdump -p adapter.dll`)
# -- essas DLLs nao estao ao lado do executavel do Core (nem no pacote instalado, nem no ctest local
# deste repo), entao LoadLibrary falhava silenciosamente (bug real encontrado rodando os testes
# depois desta mudanca: esp32_adapter/mcu_component/mcu_controller_real_qemu quebraram). Estatico
# resolve isso sem precisar redistribuir mais DLLs.
if(MINGW)
  target_link_options(adapter PRIVATE -static-libgcc -static-libstdc++)
endif()

# lasecsimul-cli build copia o artefato gerado para build/<plataforma>/adapter.{dll,so,dylib}
# conforme .lsdevice (ver .spec/lasecsimul-native-devices.spec, secao 18).
