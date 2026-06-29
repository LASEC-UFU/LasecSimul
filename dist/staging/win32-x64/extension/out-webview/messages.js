export const WEBVIEW_MESSAGE_VERSION = 1;
export function isHostMessage(value) {
    return typeof value === "object" && value !== null && "type" in value && "version" in value;
}
//# sourceMappingURL=messages.js.map