#pragma once
#include <string>

namespace lasecsimul::ipc {

constexpr int PROTOCOL_VERSION = 2;

/** Mensagem recebida do cliente (Extension), após parse do JSON de linha. */
struct IncomingMessage {
    std::string id;
    std::string type;
    std::string payloadJson; // conteúdo bruto do campo "payload"
    int protocolVersion = 0;
};

/** Resposta enviada ao cliente. */
struct OutgoingResponse {
    std::string id;
    bool ok = true;
    std::string payloadJson; // JSON válido ou "" para objeto vazio
    std::string error;       // preenchido apenas quando ok == false
};

} // namespace lasecsimul::ipc
