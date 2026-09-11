# Referências visuais TDPSv771

Cada PNG é uma conversão otimizada (640 px de largura, proporção preservada) do `screen.bmp`
correspondente em `C:\SourceCode\TDPSv771\examples`. Os PNGs são deliberadamente usados no
pacote: o formato `.lssubcircuit` declara `symbol.background` como `image/png`, e o catálogo os
embute como `data:image/png;base64` ao carregar o manifesto. O BMP original não é necessário no
runtime nem é copiado para o VSIX.

| Subcircuito | Origem TDPS |
|---|---|
| `process_fopdt` | `processes to model/screen.bmp` |
| `tdps_basic_flow_loop` | `basic flow loop/screen.bmp` |
| `tdps_boiler_drum` | `boiler/screen.bmp` |
| `tdps_furnace_combustion` | `combustion2fuels/screen.bmp` |
| `tdps_heat_exchanger` | `heat exchanger/screen.bmp` |
| `tdps_ph_neutralization` | `linearized pH control/screen.bmp` |
| `tdps_reactor_temperature` | `reactor/screen.bmp` |
| `tdps_smith_predictor` | `Smith predictor/screen.bmp` |
| `tdps_split_range` | `splitrange control/screen.bmp` |
| `tdps_surge_tank_level` | `surge tank/screen.bmp` |
