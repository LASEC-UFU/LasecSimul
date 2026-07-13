#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include "components/other/Ground.hpp"
#include "components/passive/Capacitor.hpp"
#include "components/passive/Inductor.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/DcVoltageSource.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"
using namespace lasecsimul; using namespace lasecsimul::plugins; using namespace lasecsimul::registry; using namespace lasecsimul::session;

static void factories(SimulationSession& s) {
    s.components().registerFactory("v", [](const ComponentParams&){ return std::make_unique<components::DcVoltageSource>(std::array<Pin,2>{Pin{"p"},Pin{"n"}},1.0); });
    s.components().registerFactory("r", [](const ComponentParams& p){ return std::make_unique<components::Resistor>(std::array<Pin,2>{Pin{"p"},Pin{"n"}},p.property("r",1000.0)); });
    s.components().registerFactory("l", [](const ComponentParams& p){ return std::make_unique<components::Inductor>(std::array<Pin,2>{Pin{"p"},Pin{"n"}},p.property("l",1.0)); });
    s.components().registerFactory("c", [](const ComponentParams& p){ return std::make_unique<components::Capacitor>(std::array<Pin,2>{Pin{"p"},Pin{"n"}},p.property("c",1e-6)); });
    s.components().registerFactory("g", [](const ComponentParams&){ return std::make_unique<components::Ground>(Pin{"p"}); });
}
static ComponentParams property(const char* name,double value){ ComponentParams p; p.properties[name]=value; return p; }
static TransientSettings fixed(IntegrationMethod method,uint64_t dt){ TransientSettings s; s.method=method; s.initialStepNs=s.maximumStepNs=dt; s.minimumStepNs=1; s.adaptiveTimeStep=false; return s; }

static bool rl() {
    GlobalPluginCache cache; SimulationSession s(cache); factories(s); s.setTransientSettings(fixed(IntegrationMethod::Trapezoidal,1'000));
    const auto v=s.addComponent("v",{}), r=s.addComponent("r",property("r",1000)), l=s.addComponent("l",property("l",1)), g=s.addComponent("g",{});
    s.connectWire(v,"p",r,"p"); s.connectWire(r,"n",l,"p"); s.connectWire(l,"n",v,"n"); s.connectWire(v,"n",g,"p");
    s.scheduler().runUntil(1'000'000);
    const double actual=s.componentCurrent(l).value_or(-1), expected=0.001*(1-std::exp(-1.0));
    std::printf("RL actual=%.12g expected=%.12g error=%.3g\n",actual,expected,std::abs(actual-expected));
    return std::abs(actual-expected)<2e-6;
}
static bool rlc() {
    constexpr double R=10,L=1e-3,C=1e-6; constexpr uint64_t endNs=100'000;
    GlobalPluginCache cache; SimulationSession s(cache); factories(s); s.setTransientSettings(fixed(IntegrationMethod::Gear2,100));
    const auto v=s.addComponent("v",{}), r=s.addComponent("r",property("r",R)), l=s.addComponent("l",property("l",L)), c=s.addComponent("c",property("c",C)), g=s.addComponent("g",{});
    s.connectWire(v,"p",r,"p"); s.connectWire(r,"n",l,"p"); s.connectWire(l,"n",c,"p"); s.connectWire(c,"n",v,"n"); s.connectWire(v,"n",g,"p");
    s.scheduler().runUntil(endNs);
    const double t=endNs*1e-9, alpha=R/(2*L), omega0=1/std::sqrt(L*C), wd=std::sqrt(omega0*omega0-alpha*alpha);
    const double expected=1-std::exp(-alpha*t)*(std::cos(wd*t)+(alpha/wd)*std::sin(wd*t));
    const double actual=s.nodeVoltageOfPin(c,"p");
    std::printf("RLC actual=%.12g expected=%.12g error=%.3g\n",actual,expected,std::abs(actual-expected));
    return std::abs(actual-expected)<2e-3;
}
int main(){ return rl()&&rlc()?0:1; }
