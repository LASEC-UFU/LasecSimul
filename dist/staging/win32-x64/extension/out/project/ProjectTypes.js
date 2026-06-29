"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LS_PROJ_SCHEMA_VERSION = void 0;
exports.createEmptyProject = createEmptyProject;
exports.LS_PROJ_SCHEMA_VERSION = 1;
function createEmptyProject() {
    return {
        schemaVersion: exports.LS_PROJ_SCHEMA_VERSION,
        components: [],
        wires: [],
        visual: {
            components: [],
            wires: [],
            viewport: { x: 0, y: 0, zoom: 1 },
        },
        simulationSettings: {},
    };
}
//# sourceMappingURL=ProjectTypes.js.map