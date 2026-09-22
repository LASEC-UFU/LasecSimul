# Draw.io P&ID symbol inventory

Generated from draw.io commit `744cb5420fdf126efd7a09b1d7082ca3e12c0841` on 2026-09-21T14:42:25.869Z.

The current upstream P&ID tree contains **24 stencil files** and **478 shape definitions**. This is an audit inventory only; the production extension ships LasecSimul-native declarative symbols and does not parse draw.io at runtime.

## Source and method

- Repository: https://github.com/jgraph/drawio
- Tree: `src/main/webapp/stencils/pid/*.xml`
- Symbol count: each `<shape>` element is counted once.
- Connection count: `<constraint>` elements inside each shape.
- Primitive summary: primitive element names found inside each shape.

## Mixers and agitators

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/agitators.xml` | 10 | Agitator, Stirrer, Agitator (Anchor), Agitator (Cross-Beam), Agitator (Disc), Agitator (Flate-Blade Paddle), Agitator (Gat Paddle), Agitator (Helical), Agitator (Impeller), Agitator (Propeller), Agitator (Turbine) |
| `src/main/webapp/stencils/pid/mixers.xml` | 4 | In-Line Rotary Mixer, In-Line Static Mixer, Kneader, Mixing Path |

## Other P&ID

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/apparatus_elements.xml` | 6 | Manhole, Socket, Connection Nozzle, Support Bracket, Support Leg, Support Ring, Support Skirt |
| `src/main/webapp/stencils/pid/centrifuges.xml` | 8 | Centrifuge, Decanter (Screw, Solid Shell), Centrifuge (High Speed), Centrifuge (Perforated Shell), Centrifuge (Pusher), Centrifuge (Screw, Perforated Shell), Centrifuge (Separator Disc), Centrifuge (Skimmer), Centrifuge (Solid Shell) |
| `src/main/webapp/stencils/pid/crushers_grinding.xml` | 13 | Crusher, Crusher (Cone), Crusher (Hammer), Crusher (Impact), Crusher (Jaw), Crusher (Roller), Crushing, Grinding Machine, Mill, Pulverizer, Mill, Pulverizer (Hammer), Mill, Pulverizer (Impact), Mill (Roller), Mill (Vibration), Mill (Vibration)2 |
| `src/main/webapp/stencils/pid/driers.xml` | 8 | Drier, Drier (Fluidized Bed), Drier (Roller Conveyor Belt), Drying Oven, Drying Chamber, Shelf Dryer, Heat Consumer, Rotary Drum Drier, Tumbling Drier, Spray Drier, Turbo Drier, Disc Drier, Moving Shelf Drier |
| `src/main/webapp/stencils/pid/feeders.xml` | 5 | Feeder (Rotary Table), Proportional Feeder, Proportional Feeder (Metering), Proportional Feeder (Rotary Valve), Spray Nozzle |
| `src/main/webapp/stencils/pid/fittings.xml` | 35 | Blind Disc, Blind Disc2, Breakthrough, Breakthrough2, Clamped Flange Coupling, Compensator, Coupling, Flame Arrestor, Flame Arrestor (Detonation-Proof), Flame Arrestor (Explosion-Proof), Flame Arrestor (Fire-Resistant), Flame Arrestor (Fire-Resistant, Detonation-Proof), Flanged Connection, Flanged Dummy Cover, Funnel, Hose, Injector, Interchangeable Disc (Blind Disc), Interchangeable Disc (Blind Disc)2, Interchangeable Disc (Open Disc In Function), Interchangeable Disc (Open Disc In Function)2, Open Disc, Orifice Plate, Orifice Plate2, Reducer, Rupture Disc, Self-Operating Release Valve, Self-Operating Release Valve2, Silencer, Single Flange, Strainer, Strainer (Cone), Vent, Viewing Glass, Viewing Glass (Lighting) |
| `src/main/webapp/stencils/pid/shaping_machines.xml` | 7 | Extruder (Piston), Extruder (Screw), Pelletizing Disc, Press (Piston), Press (Roller), Shaping Machine (Horizontal), Shaping Machine (Vertical) |

## Rotating equipment

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/compressors.xml` | 9 | AC Air Compressor, Centrifugal Compressor, Centrifugal Compressor - Turbine Driven, Compressor, Compressor and Silencers, Liquid Ring Compressor, Reciprocating Compressor, Reciprocating Compressor 2, Rotary Compressor |
| `src/main/webapp/stencils/pid/compressors_iso.xml` | 11 | Blower, Fan, Compressor, Vacuum Pump, Compressor (Centrifugal), Compressor (Diaphragm), Compressor (Ejector), Compressor (Piston), Compressor (Ring), Compressor (Roller Vane), Compressor (Rotary), Compressor (Screw), Compressor (Turbo) |

## Motors and drives

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/engines.xml` | 8 | Electric Motor, Electric Motor (AC), Electric Motor (DC), Gear, Generator, Generator (AC), Generator (DC), Turbine |

## Process equipment

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/filters.xml` | 16 | Filter, Gas Filter, Gas Filter (Bag, Candle, Cartridge), Gas Filter (Belt, Roll), Gas Filter (Fixed Bed), Gas Filter (HEPA), Liquid Filter, Liquid Filter (Bag, Candle, Cartridge), Liquid Filter (Belt, Roll), Liquid Filter (Biological), Liquid Filter (Fixed Bed), Liquid Filter (Ion Exchanger), Liquid Filter (Rotary, Drum or Disc), Liquid Filter (Rotary, Drum or Disc, Scraper), Press Filter, Suction Filter |
| `src/main/webapp/stencils/pid/heat_exchangers.xml` | 23 | Condenser, Double Pipe Heat Exchanger, Electric Heater, Fixed Straight Tubes Heat Exchanger, Hairpin Exchanger, Heater, Heat Exchanger (Coil Tubes), Heat Exchanger (Finned Tubes), Heat Exchanger (Finned Tubes, Fan), Heat Exchanger (Floating Head), Heat Exchanger (Plate), Heat Exchanger (Spiral), Heat Exchanger (Straight Tubes), Plate and Frame Heat Exchanger, Reboiler, Shell and Tube Heat Exchanger 1, Shell and Tube Heat Exchanger 2, Shell and Tube Heat Exchanger 3, Single Pass Heat Exchanger, Spiral Heat Exchanger, Thin-Film Evaporator, U-Tube Heat Exchanger, U Shaped Tubes Heat Exchanger |
| `src/main/webapp/stencils/pid/misc.xml` | 82 | Aerator With Sparger, Air Cooler, Air Filter, Air Separator, Back Draft Damper, Back Draft Damper2, Bag Filling Machine, Bag Filling Machine2, Belt Skimmer, Bin, Boiler (Dome), Boiler (Dome, Hot Liquid), Box Truck, Bucket Elevator, Chiller, Combustion Chamber, Conveyor, Conveyor2, Conveyor (Belt), Conveyor (Belt, Closed), Conveyor (Belt, Closed, Reversible), Conveyor (Belt, Closed, Reversible)2, Conveyor (Chain, Closed), Conveyor (Screw, Closed), Conveyor (Vibrating, Closed), Conveyor (Vibrating, Closed)2, Cooler, Cooling Tower, Cooling Tower (Dry, Forced Draught), Cooling Tower (Dry, Induced Draught), Cooling Tower (Dry, Natural Draught), Cooling Tower (Wet, Forced Draught), Cooling Tower (Wet, Induced Draught), Cooling Tower (Wet, Natural Draught), Cooling Tower (Wet-Dry, Natural Draught), Covered Gas Vent, Crane, Curved Gas Vent, Cyclone, Dryer, Elevator (Bucket), Elevator (Bucket, Z-Form), Fan, Fan 2, Filter, Filter 2, Firing System, Burner, Flame Arrestor, Flexible Pipe, Forced Flow Air Cooler, Forklift (Manual), Forklift (Truck), Funnel, Gas Flare, Induced Flow Air Cooler, Industrial Truck, Lift, Loading Arm, Mixer, Palletizer, Palletizer2, Protective Palette Covering, Roller Conveyor, Rolling Bin, Rotary Screen, Screening Device, Sieve, Strainer, Screening Device, Sieve, Strainer (Basket Reel), Screening Device, Sieve, Strainer (Coarse and Fine Screens), Screening Device, Sieve, Strainer (Coarse Rake), Screening Device, Sieve, Strainer (Fine Rake), Screening Device, Sieve, Strainer (Rotating Drum), Screening Device, Sieve, Strainer (Vibrating), Screening Device, Sieve, Strainer (Vibrating)2, Ship, Silencer, Spraying Device, Spray Cooler, Stack, Chimney, Steam Trap, Steam Trap2, Tank Car, Tank Wagon, Viewing Glass |
| `src/main/webapp/stencils/pid/separators.xml` | 18 | Gravity Separator, Settling Chamber, Gravity Separator, Settling Chamber2, Impact Separator, Separator, Sifter, Separator, Sifter2, Separator (Cyclone), Separator (Cyclone)2, Separator (Electromagnetic), Separator (Electrostatic Precipitator), Separator (Electrostatic Precipitator, Wet), Separator (Permanent Magnet), Separator (Permanent Magnet)2, Separator (Venturi Scrubber), Separator (Wet Scrubber), Separator (Wet Scrubber)2, Solidifier (Closed), Solidifier (Open), Spray Scrubber |

## Instrumentation

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/flow_sensors.xml` | 16 | Averging Pitot Tube, Coriolis, Flow Nozzle, Flume, Magnetic, Pitot Tube, Positive Displacement, Rotameter, Target, Turbine, Ultrasonic, V-cone, Venturi, Vortex, Wedge, Weir |
| `src/main/webapp/stencils/pid/instruments.xml` | 24 | Analyzer Transmitter, Flow Element, Flow Indicator, Flow Recorder, Flow Transmitter, Level Alarm, Level Controller 1, Level Controller 2, Level Gauge, Level Indicator, Level Recorder, Level Transmitter 1, Level Transmitter 2, Pressure Controller, Pressure Indicating Controller, Pressure Indicator, Pressure Recorder, Pressure Recording Controller, Pressure Transmitter 1, Pressure Transmitter 2, Temperature Element, Temperature Indicator, Temperature Recorder, Temperature Transmitter |

## Piping and fittings

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/piping.xml` | 43 | Basket Strainer, Blank, Blank2, Breather, Cap, Closed Figure 8 Blind, Closed Figure 8 Blind2, Concentric Reducer, Cone Strainer, Damper, Damper2, Desuper Heater, Detonation Arrestor, Diverter Valve, Double Flange, Duplex Strainer, Eccentric Reducer, Excess Flow Valve, Excess Flow Valve2, Exhaust Head, Expansion Joint, Flame Arrestor, Flange, Flange In, Flexible Hose, Hose Connection, In-Line Mixer, In-Line Silencer, Open Figure 8 Blind, Open Figure 8 Blind2, Orifice (Quick Change), Plug, Pulsation Dampener, Removable Spool, Rotary Valve, Spacer, Steam Trap, T-Type Strainer, Temporary Strainer, Vent Silencer, Welded Connection, Welded Connection2, Y-Type Strainer |

## Pumps

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/pumps.xml` | 18 | Cavity Pump, Centrifugal Pump 1, Centrifugal Pump 2, Centrifugal Pump 3, Feed Pump, Gas Blower, Gas Compressor, Gear Pump, Horizontal Pump, Injector, Peristaltic, Screw Pump, Screw Pump 2, Submersible Pump, Sump Pump, Turbine, Vacuum Pump, Vertical Pump |
| `src/main/webapp/stencils/pid/pumps_din.xml` | 10 | Centrifugal, Diaphragm, Eccentric Worm, Electromagnetic, Gear, Hydraulic, Liquid Jet, Reciprocating, Rotary Piston, Screw |
| `src/main/webapp/stencils/pid/pumps_iso.xml` | 9 | Jet Pump (Liquid), Pump (Centrifugal), Pump (Diaphragm), Pump (Gear), Pump (Liquid), Pump (Positive Displacement), Pump (Progressive Cavity), Pump (Reciprocating Piston), Pump (Screw) |

## Valves

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/valves.xml` | 32 | Angle, Back Pressure Regulator 1, Back Pressure Regulator 2, Ball Valve, Bleeder Valve 1, Bleeder Valve 2, Butterfly Valve 1, Butterfly Valve 2, Check Valve 1, Check Valve 2, Diaphragm, Four Way Valve, Gate Valve, Gauge, Globe Valve, Hydraulic Valve, Knife Valve, Manual Operated Valve, Motor Operated Valve, Needle, Orifice, Pinch Valve, Plug, Pneumatic Operated, Pneumatic Operated Butterfly Valve, Pressure Reducing Valve, Relief PRV, Rotameter, Safety PSV 1, Safety PSV 2, Solenoid Valve Closed, Three-Way Valve |

## Tanks and vessels

| Source stencil | Symbols | Names |
|---|---:|---|
| `src/main/webapp/stencils/pid/vessels.xml` | 63 | Bag, Bag (ISO), Barrel, Drum, Barrel, Drum (ISO), Bunker (Conical Bottom), Concrete Tank, Container, Tank, Cistern, Container, Tank, Cistern (Boot), Container, Tank, Cistern (Bottom), Container, Tank, Cistern (Legs), Container (Solids, Liquids, Gases), Double Concrete Tank, Drum or Condenser, Forced-Draft Cooling Tower, Furnace, Furnace2, Gas Bottle, Gas Holder, Half Pipe Mixing Vessel, Induced-Draft Cooling Tower, Jacketed Mixing Vessel, Knock-out Drum, Mixer, Mixing Reactor, Open Bulk Storage, Pressurized Vessel, Prop Agitator, Reactor, Settling Tank, Spray Drier, Storage Sphere, Tank, Vessel, Tank, Tank (Boot), Tank (Concrete Base), Tank (Conical Bottom), Tank (Conical Roof), Tank (Conical Roof and Bottom), Tank (Covered), Tank (Covered, Boot), Tank (Dished Roof), Tank (Dished Roof, Conical Bottom), Tank (False Bottom), Tank (Floating Roof), Tank (Floating Roof, Boot), Tower, Tower With Packing, Turbine Agitator, Vent (Bent), Vent (Cover), Vessel (Different Diameters), Vessel (Dished Bottom, Surface Indication), Vessel (Dished Ends, Brackets), Vessel (Dished Ends, Electrical Heating), Vessel (Dished Ends, Heating-Cooling Jacket), Vessel (Dished Ends, Legs), Vessel (Dished Ends, Ring), Vessel (Dished Ends, Skirts), Vessel (Dished Ends, Thermal Insulation), Vessel (Dome), Vessel (Full-Tube Heating-Cooling Coil), Vessel (Pit), Vessel (Semi-Tube Heating-Cooling Coil) |
