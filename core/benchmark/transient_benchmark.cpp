#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include "components/other/Ground.hpp"
#include "components/passive/Capacitor.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/DcVoltageSource.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"
using namespace lasecsimul; using namespace lasecsimul::plugins; using namespace lasecsimul::registry; using namespace lasecsimul::session;
static void componentsFor(SimulationSession& s){
 s.components().registerFactory("v",[](const ComponentParams&){return std::make_unique<components::DcVoltageSource>(std::array<Pin,2>{Pin{"p"},Pin{"n"}},1.0);});
 s.components().registerFactory("r",[](const ComponentParams&){return std::make_unique<components::Resistor>(std::array<Pin,2>{Pin{"p"},Pin{"n"}},1000.0);});
 s.components().registerFactory("c",[](const ComponentParams&){return std::make_unique<components::Capacitor>(std::array<Pin,2>{Pin{"p"},Pin{"n"}},1e-6);});
 s.components().registerFactory("g",[](const ComponentParams&){return std::make_unique<components::Ground>(Pin{"p"});});
}
static void run(const char* name,IntegrationMethod method,bool adaptive,uint64_t dt){
 GlobalPluginCache cache; SimulationSession s(cache); componentsFor(s); TransientSettings cfg; cfg.method=method; cfg.adaptiveTimeStep=adaptive; cfg.initialStepNs=cfg.maximumStepNs=dt; cfg.minimumStepNs=1; s.setTransientSettings(cfg);
 auto v=s.addComponent("v",{}),r=s.addComponent("r",{}),c=s.addComponent("c",{}),g=s.addComponent("g",{});
 s.connectWire(v,"p",r,"p");s.connectWire(r,"n",c,"p");s.connectWire(c,"n",v,"n");s.connectWire(v,"n",g,"p");
 const auto begin=std::chrono::steady_clock::now(); s.scheduler().runUntil(10'000'000); const auto end=std::chrono::steady_clock::now();
 const double actual=s.nodeVoltageOfPin(c,"p"),expected=1-std::exp(-10.0),error=std::abs(actual-expected);
 const double ms=std::chrono::duration<double,std::milli>(end-begin).count();
 std::printf("TRANSIENT method=%s adaptive=%d dt_max_ns=%llu time_ms=%.3f accepted=%llu rejected=%llu error=%.6g\n",name,adaptive?1:0,(unsigned long long)dt,ms,(unsigned long long)s.acceptedTransientSteps(),(unsigned long long)s.rejectedTransientSteps(),error);
}
int main(){run("BE",IntegrationMethod::BackwardEuler,false,10'000);run("TRAP",IntegrationMethod::Trapezoidal,false,10'000);run("GEAR2",IntegrationMethod::Gear2,false,10'000);run("AUTO",IntegrationMethod::Automatic,true,100'000);return 0;}
