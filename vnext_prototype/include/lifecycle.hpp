#pragma once
#include "artifact_transport_abi.h"
inline bool validTransition(uint32_t from,uint32_t to){ if(from==to)return true; switch(from){case LASEC_AT_CREATED:return to==LASEC_AT_STARTING||to==LASEC_AT_FAILED;case LASEC_AT_STARTING:return to==LASEC_AT_READY||to==LASEC_AT_STOPPING||to==LASEC_AT_FAILED;case LASEC_AT_READY:return to==LASEC_AT_RUNNING||to==LASEC_AT_STOPPING||to==LASEC_AT_FAILED;case LASEC_AT_RUNNING:return to==LASEC_AT_STOPPING||to==LASEC_AT_FAILED;case LASEC_AT_STOPPING:return to==LASEC_AT_STOPPED||to==LASEC_AT_FAILED;default:return false;} }
