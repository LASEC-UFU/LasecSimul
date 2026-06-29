"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IpcError = exports.PROTOCOL_VERSION = void 0;
exports.errorCodeFromPayload = errorCodeFromPayload;
exports.PROTOCOL_VERSION = 1;
/** Erro de uma requisição IPC rejeitada pelo Core. `code` é o `errorCode` estável que alguns
 * handlers (ex: `setProperty`) embutem em `payload` quando `ok === false` — ver
 * `core/src/app/CoreApplication.cpp::parsePropertyError` ("unknown_property"|"read_only"|
 * "type_mismatch"|"out_of_range"|"invalid_option"). `code` fica `undefined` para handlers que ainda
 * só devolvem `error` (texto livre), o que mantém quem só lê `.message` funcionando sem mudança. */
class IpcError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = "IpcError";
        this.code = code;
    }
}
exports.IpcError = IpcError;
function errorCodeFromPayload(payload) {
    if (typeof payload !== "object" || payload === null)
        return undefined;
    const errorCode = payload.errorCode;
    return typeof errorCode === "string" ? errorCode : undefined;
}
//# sourceMappingURL=protocol.js.map