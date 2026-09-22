# Graphical bindings and actions

The simulation-to-graphics binding path is documented in
[`GRAPHICAL_BINDINGS.md`](GRAPHICAL_BINDINGS.md). It is generic, source-ID based and protocol
independent.

The reverse path, graphics-to-simulation, is implemented by the generic Graphical Action model. An
operator widget stores a stable `actionTarget` component ID, an `actionProperty`, an `actionMode`
and typed values/limits. The Webview resolves the gesture and sends the result through the existing
`requestUpdateProperty` authority; sliders use `requestPreviewProperty` while dragging and commit on
release. There is no second variable namespace and no direct write from SVG to the Core.

Supported modes:

- `set`: writes the active value;
- `toggle`: alternates active/release values;
- `momentary`: separates press and release;
- `increment`: applies a step and clamps to optional limits;
- explicit numeric input: used by sliders, numeric entries and setpoints, with min/max clamping.

The operator catalog contains button, toggle, switch, numeric input, slider and setpoint widgets.
They operate only while the editor is in RUN; EDIT keeps the normal select/move/resize behavior.
Missing targets remain visibly unconfigured and never cause an implicit write.
