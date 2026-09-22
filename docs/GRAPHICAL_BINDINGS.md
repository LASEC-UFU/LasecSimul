# Graphical bindings

Graphical properties use the existing component readout path:

`simulation component -> readout by stable component ID -> graphicalRuntimeProperties -> vector state`

The generic properties are `bindSource`, `bindChannel`, `bindScale`, `bindOffset`, `bindMin`,
`bindMax`, `bindThreshold`, `bindInvert`, `bindDecimals`, and `bindUnit`. The projection produces
`__g_value`, `__g_pct`, `__g_text`, `__g_on`, and `__g_bind`, which existing declarative paint
expressions consume.

Supported examples include tank fill percentage, valve closed/intermediate/open/fault colors,
pump/motor running state, status lamps, level bars, instrument values and formatted labels. A
missing source is explicit (`missing`) and retains a static fallback value so a stopped simulation
remains readable.

Bindings are source-ID based, not label based, so renaming a component does not break a connection.
No HART-specific graphical type is created.
