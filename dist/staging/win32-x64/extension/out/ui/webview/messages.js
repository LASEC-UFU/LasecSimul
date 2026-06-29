"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEBVIEW_MESSAGE_VERSION = void 0;
exports.isHostMessage = isHostMessage;
exports.WEBVIEW_MESSAGE_VERSION = 1;
function isHostMessage(value) {
    return typeof value === "object" && value !== null && "type" in value && "version" in value;
}
//# sourceMappingURL=messages.js.map