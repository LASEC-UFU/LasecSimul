# TDPS WYSIWYG coverage

The source-derived inventory contains exactly 24 TDPS processes: the 24
`subcircuits/tdps_*.lssubcircuit` files match `.spec/fixtures/tdps-v771-library.json`.

All 24 currently have native vector scenes and no BMP runtime dependency. `tdps_basic_flow_loop` is
the curated pilot with volumetric piping, FT-101, FIC-101, FCV-101/102, HS-022, command panel and
setpoint/tolerance displays. Its command panel now uses two real illuminated operator buttons and
its setpoint uses a real ticked slider instead of decorative shapes. The complete per-process symbol matrix is maintained in
[`TDPS_GRAPHICAL_COVERAGE.md`](TDPS_GRAPHICAL_COVERAGE.md).

Automated coverage verifies parse/serialize, vector-only content, stable binding IDs and preserved
simulation topology. Generic operator Actions are now available for buttons, illuminated buttons,
toggles, switches, numeric inputs, sliders and setpoints. Remaining work is fidelity curation of the other 23 screens
and wiring each legacy TDPS command to a model-specific writable property; “native screen exists”
is not treated as proof that every legacy visual detail or control gesture is complete.
