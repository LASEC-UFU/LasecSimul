#include "artifact_transport_abi.h"
#include <stddef.h>
#include <stdio.h>
#include <stdalign.h>
int main(void){if(sizeof(lasec_at_event)!=96||sizeof(lasec_at_control_page)!=176||sizeof(lasec_at_response_slot)!=88||sizeof(lasec_at_snapshot)!=72||sizeof(lasec_at_region_descriptor)!=24||sizeof(lasec_at_lane_descriptor)!=56||offsetof(lasec_at_event,payload)!=32||alignof(lasec_at_control_page)!=8)return 1; puts("C layout PASS");return 0;}
