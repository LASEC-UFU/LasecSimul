#include "wire_container.hpp"
#include <cassert>
#include <iostream>
struct Tagged{uint64_t execution,sequence;};
static bool accept(const Tagged& x,uint64_t current,uint64_t expected){return x.execution==current&&x.sequence==expected;}
int main(){CreationConfig c{2,8,2,4,32,32,41};std::vector<uint8_t>b;MappingLayout l;assert(serializeContainer(c,b,l));MappingView v;assert(validateWireContainerComplete(b.data(),b.size(),v));Tagged q{41,1},r{41,1},s{41,1},a{41,1};auto*ctrl=const_cast<lasec_at_control_page*>(v.control);ctrl->execution_id=42;assert(!accept(q,42,1)&&!accept(r,42,1)&&!accept(s,42,1)&&!accept(a,42,1));bool waiterCompleted=accept(r,42,1);assert(!waiterCompleted);std::cout<<"STALE_EXECUTION PASS\n";}
