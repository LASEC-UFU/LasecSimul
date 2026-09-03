#include "artifact_transport_abi.h"
#include <cstddef>
#include <iostream>
int main(){
 static_assert(sizeof(lasec_at_event)==96 && offsetof(lasec_at_event,payload)==32);
 static_assert(sizeof(lasec_at_control_page)==176 && alignof(lasec_at_control_page)==8);
 static_assert(sizeof(lasec_at_response_slot)==88 && sizeof(lasec_at_snapshot)==72);
 std::cout << "C++ layout PASS\n";
}
