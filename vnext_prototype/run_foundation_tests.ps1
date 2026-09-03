$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force build | Out-Null
gcc -std=c11 -Wall -Wextra -I include layout_c_test.c -o build/layout_c_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -I include layout_cpp_test.cpp -o build/layout_cpp_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -pthread -I include synthetic_test.cpp -o build/synthetic_test.exe
gcc -std=c11 -Wall -Wextra -I include cross_process_c.c -o build/cross_process_c.exe
g++ -std=c++20 -O2 -Wall -Wextra -pthread -municode -I include cross_process_test.cpp -o build/cross_process_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -pthread -I include foundation_verification.cpp -o build/foundation_verification.exe
g++ -std=c++20 -O2 -Wall -Wextra -I include mapping_validation_test.cpp -o build/mapping_validation_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -I include mapping_layout_test.cpp -o build/mapping_layout_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -I include wire_container_test.cpp -o build/wire_container_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -pthread -I include idle_wake_test.cpp -o build/idle_wake_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -pthread -I include c2a_mapping_test.cpp -o build/c2a_mapping_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -I include mapping_view_roundtrip_test.cpp -o build/mapping_view_roundtrip_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -I include stale_execution_test.cpp -o build/stale_execution_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -pthread -I include p10_combined_test.cpp -o build/p10_combined_test.exe
g++ -std=c++20 -O2 -Wall -Wextra -I include remaining_gates_test.cpp -o build/remaining_gates_test.exe
gcc -std=c11 -O2 -Wall -Wextra -I include snapshot_ipc_c.c -o build/snapshot_ipc_c.exe
g++ -std=c++20 -O2 -Wall -Wextra -municode -I include snapshot_ipc_test.cpp -o build/snapshot_ipc_test.exe
& .\build\layout_c_test.exe
& .\build\layout_cpp_test.exe
& .\build\synthetic_test.exe
& .\build\cross_process_test.exe
& .\build\foundation_verification.exe
& .\build\mapping_validation_test.exe
& .\build\mapping_layout_test.exe
& .\build\wire_container_test.exe
& .\build\idle_wake_test.exe
& .\build\c2a_mapping_test.exe
& .\build\snapshot_ipc_test.exe
& .\build\mapping_view_roundtrip_test.exe
& .\build\stale_execution_test.exe
& .\build\p10_combined_test.exe
& .\build\remaining_gates_test.exe
Write-Output "VNEXT FOUNDATION PROTOTYPE PASS"
