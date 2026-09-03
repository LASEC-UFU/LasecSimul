#include "mapping_layout.hpp"
#include <cassert>
#include <iostream>
int main(){MappingLayout a,b,c;assert(buildMappingLayout(1,4,1,2,32,32,a));assert(buildMappingLayout(2,16,2,16,32,32,b));assert(buildMappingLayout(4,32,4,32,32,32,c));assert(a.total<b.total&&b.total<c.total);assert(!buildMappingLayout(0,4,0,0,32,32,a));assert(!buildMappingLayout(17,4,17,0,32,32,a));assert(!buildMappingLayout(1,4,1,0,3,32,a));std::cout<<"mapping layout PASS "<<a.total<<" "<<b.total<<" "<<c.total<<"\n";}
