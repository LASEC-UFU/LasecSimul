# TDPS graphical coverage

The repository contains exactly 24 `subcircuits/tdps_*.lssubcircuit` processes, matching the
canonical `.spec/fixtures/tdps-v771-library.json` inventory. Their screens are composed of native
objects; the tests reject bitmap backgrounds and verify real internal binding IDs.

| Process | Native screen status | Main graphical coverage |
|---|---|---|
| basic_flow_loop | curated HMI | volumetric pipe/flanges, industrial FT-101, FIC-101 station, pneumatic FCV-101, manual FCV-102, HS-022, command/SP panels |
| boiler | implemented | tank/vessel, heater/equipment, pipe, instrument |
| combustion_cross_limits | implemented | equipment, valve, instrument, status/labels |
| combustion_dynamic_cross_limits | implemented | equipment, valve, instrument, status/labels |
| combustion_ratio | implemented | equipment, valve, instrument, labels |
| combustion_two_fuels | implemented | equipment, valve, instrument, status/labels |
| cooling_plant | implemented | vessel/equipment, pump/motor, pipe, instrument |
| course_fine_flow_loop | implemented | pipe, valve, pump, instrument, controller |
| ethane_plant | implemented | vessel, equipment, valve, instrument |
| four_linear_processes | implemented | equipment, instruments, labels |
| frequency_response | implemented | instrument, value display, labels |
| furnace | implemented | equipment, instrument, status, labels |
| furnace_master_slave | implemented | equipment, instrument, controller, labels |
| header_pressure_three_consumers | implemented | vessel, pipe, valve, instrument |
| heat_exchanger | implemented | heat exchanger, pipe, valve, instrument, summing junction |
| industrial_boiler | implemented | vessel/equipment, pipe, instrument |
| linearized_ph | implemented | vessel/equipment, instrument, value display |
| nonlinear_flow_processes | implemented | pipe, valve, instrument, labels |
| ph_control | implemented | vessel/equipment, instrument, controller |
| reactor | implemented | reactor/vessel, pipe, valve, instrument |
| regulatory_level | implemented | tank, pump, valve, instrument, level bar |
| smith_predictor | implemented | equipment, instruments, controller, labels |
| split_range | implemented | pipe, valves, instruments, controller, summing junction |
| surge_tank | implemented | hopper/equipment, tank/vessel, pipe, instruments, labels |

The native library currently exposes 37 `graphics.*` entries (32 generated + 5 legacy basics). The screen tests verify that all 24
processes parse/serialize, render vector content, preserve layers and bindings, and retain their
simulation topology. Specialized pictorial details from legacy images are represented by the
closest semantic native equipment symbol and are not imported as BMP backgrounds. `basic_flow_loop`
is the first curated fidelity profile and establishes the detailed industrial device vocabulary for
the remaining flow-oriented screens.
