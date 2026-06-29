"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrustStore = void 0;
const STORAGE_KEY = "lasecsimul.trustedPublishers";
/**
 * Persiste a decisão de confiança por publisher (`library.json::publisher`) em
 * `ExtensionContext.globalState` -- decisão sobrevive a reinícios do VSCode, mas é local à máquina
 * (não sincroniza), pois é uma decisão de segurança sobre código nativo sem sandbox (ver
 * `.spec/lasecsimul-native-devices.spec` seção 12, item 2). "Permitir uma vez" nunca passa por
 * aqui -- só "Bloquear"/"Sempre confiar" são persistidos.
 */
class TrustStore {
    context;
    constructor(context) {
        this.context = context;
    }
    decisionFor(publisher) {
        const stored = this.context.globalState.get(STORAGE_KEY, {});
        return stored[publisher];
    }
    async setDecision(publisher, decision) {
        const stored = this.context.globalState.get(STORAGE_KEY, {});
        await this.context.globalState.update(STORAGE_KEY, { ...stored, [publisher]: decision });
    }
}
exports.TrustStore = TrustStore;
//# sourceMappingURL=TrustStore.js.map