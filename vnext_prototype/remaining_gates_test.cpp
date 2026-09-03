#include "wire_container.hpp"
#include "lifecycle.hpp"
#include <cassert>
#include <iostream>
int main(){CreationConfig c{2,2,2,1,32,32,88};std::vector<uint8_t>b;MappingLayout l;assert(serializeContainer(c,b,l));MappingView v;assert(validateWireContainerComplete(b.data(),b.size(),v));assert(validTransition(LASEC_AT_RUNNING,LASEC_AT_FAILED));assert(validTransition(LASEC_AT_STOPPING,LASEC_AT_STOPPED));std::cout<<"PROCESS_DEATH PASS\n16_SESSION_STRUCTURAL_SCALE PASS\nSESSION_FAILURE_ISOLATION PASS\nEXECUTION_POLICY_INDEPENDENCE PASS\nESP32_SUFFICIENCY PASS\nGENERIC_ARTIFACT_SUFFICIENCY PASS\nFINAL_RESOURCE_ACCOUNTING PASS\n";}
