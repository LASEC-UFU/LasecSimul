#include "PauseExpression.hpp"
#include <cctype>
#include <cmath>
#include <sstream>

namespace lasecsimul::session {
namespace {
enum class TokenKind { End, Number, Identifier, LParen, RParen, Not, And, Or, Eq, Ne, Lt, Le, Gt, Ge };
struct Token { TokenKind kind; std::string text; size_t column; };

class Lexer {
public:
    explicit Lexer(std::string_view source) : m_source(source) {}
    Token next() {
        while (m_pos < m_source.size() && std::isspace(static_cast<unsigned char>(m_source[m_pos]))) ++m_pos;
        const size_t start=m_pos;
        if(m_pos>=m_source.size()) return {TokenKind::End,"",m_pos+1};
        const char c=m_source[m_pos++];
        if(std::isdigit(static_cast<unsigned char>(c))||c=='.'){
            if(c=='0'&&m_pos<m_source.size()&&(m_source[m_pos]=='x'||m_source[m_pos]=='X')){
                ++m_pos; while(m_pos<m_source.size()&&std::isxdigit(static_cast<unsigned char>(m_source[m_pos])))++m_pos;
            } else while(m_pos<m_source.size()&&(std::isdigit(static_cast<unsigned char>(m_source[m_pos]))||m_source[m_pos]=='.'||m_source[m_pos]=='e'||m_source[m_pos]=='E'||m_source[m_pos]=='+'||m_source[m_pos]=='-'))++m_pos;
            return {TokenKind::Number,std::string(m_source.substr(start,m_pos-start)),start+1};
        }
        if(std::isalpha(static_cast<unsigned char>(c))||c=='_'||c=='@'){
            while(m_pos<m_source.size()){
                const char x=m_source[m_pos];
                if(std::isalnum(static_cast<unsigned char>(x))||x=='_'||x=='.'||x=='-'||x=='@'||x=='['||x==']'||x==':')++m_pos; else break;
            }
            return {TokenKind::Identifier,std::string(m_source.substr(start,m_pos-start)),start+1};
        }
        if(c=='(')return{TokenKind::LParen,"(",start+1}; if(c==')')return{TokenKind::RParen,")",start+1};
        if(c=='!'&&peek('=')){++m_pos;return{TokenKind::Ne,"!=",start+1};} if(c=='!')return{TokenKind::Not,"!",start+1};
        if(c=='&'&&peek('&')){++m_pos;return{TokenKind::And,"&&",start+1};} if(c=='|'&&peek('|')){++m_pos;return{TokenKind::Or,"||",start+1};}
        if(c=='='&&peek('=')){++m_pos;return{TokenKind::Eq,"==",start+1};}
        if(c=='<'&&peek('=')){++m_pos;return{TokenKind::Le,"<=",start+1};}
        if(c=='>'&&peek('=')){++m_pos;return{TokenKind::Ge,">=",start+1};} if(c=='<')return{TokenKind::Lt,"<",start+1}; if(c=='>')return{TokenKind::Gt,">",start+1};
        throw PauseExpressionError(start+1,"caractere não suportado: "+std::string(1,c));
    }
private:
    bool peek(char expected)const{return m_pos<m_source.size()&&m_source[m_pos]==expected;}
    std::string_view m_source; size_t m_pos=0;
};

double numeric(const PauseScalar& value){ if(auto p=std::get_if<double>(&value))return *p; if(auto p=std::get_if<uint64_t>(&value))return static_cast<double>(*p); return std::get<bool>(value)?1.0:0.0; }
bool boolean(const PauseScalar& value){ return std::abs(numeric(value))>1e-15; }
}

struct PauseExpression::Node {
    enum class Kind { Number, Boolean, Signal, Not, And, Or, Eq, Ne, Lt, Le, Gt, Ge } kind;
    size_t column=0; double number=0; bool booleanValue=false; std::string reference; PauseSignalMode mode=PauseSignalMode::Value;
    std::unique_ptr<Node> left,right;
};

namespace {
class Parser {
public:
    explicit Parser(const std::string& source):m_lexer(source){advance();}
    std::unique_ptr<PauseExpression::Node> parse(){auto n=parseOr();if(m_current.kind!=TokenKind::End)error("token inesperado: "+m_current.text);return n;}
private:
    using Node=PauseExpression::Node;
    void advance(){m_current=m_lexer.next();}
    [[noreturn]] void error(const std::string& message)const{throw PauseExpressionError(m_current.column,message);}
    std::unique_ptr<Node> binary(Node::Kind kind,std::unique_ptr<Node> a,std::unique_ptr<Node> b,size_t column){auto n=std::make_unique<Node>();n->kind=kind;n->column=column;n->left=std::move(a);n->right=std::move(b);return n;}
    std::unique_ptr<Node> parseOr(){auto n=parseAnd();while(m_current.kind==TokenKind::Or){auto t=m_current;advance();n=binary(Node::Kind::Or,std::move(n),parseAnd(),t.column);}return n;}
    std::unique_ptr<Node> parseAnd(){auto n=parseComparison();while(m_current.kind==TokenKind::And){auto t=m_current;advance();n=binary(Node::Kind::And,std::move(n),parseComparison(),t.column);}return n;}
    std::unique_ptr<Node> parseComparison(){auto n=parseUnary();const auto k=m_current.kind;Node::Kind nk;switch(k){case TokenKind::Eq:nk=Node::Kind::Eq;break;case TokenKind::Ne:nk=Node::Kind::Ne;break;case TokenKind::Lt:nk=Node::Kind::Lt;break;case TokenKind::Le:nk=Node::Kind::Le;break;case TokenKind::Gt:nk=Node::Kind::Gt;break;case TokenKind::Ge:nk=Node::Kind::Ge;break;default:return n;}auto t=m_current;advance();return binary(nk,std::move(n),parseUnary(),t.column);}
    std::unique_ptr<Node> parseUnary(){if(m_current.kind==TokenKind::Not){auto t=m_current;advance();auto n=std::make_unique<Node>();n->kind=Node::Kind::Not;n->column=t.column;n->left=parseUnary();return n;}return parsePrimary();}
    std::unique_ptr<Node> parsePrimary(){
        if(m_current.kind==TokenKind::Number){auto t=m_current;advance();auto n=std::make_unique<Node>();n->kind=Node::Kind::Number;n->column=t.column;try{n->number=t.text.starts_with("0x")||t.text.starts_with("0X")?static_cast<double>(std::stoull(t.text,nullptr,16)):std::stod(t.text);}catch(...){throw PauseExpressionError(t.column,"número inválido: "+t.text);}return n;}
        if(m_current.kind==TokenKind::LParen){advance();auto n=parseOr();if(m_current.kind!=TokenKind::RParen)error("esperado )");advance();return n;}
        if(m_current.kind!=TokenKind::Identifier)error("esperado sinal, função ou número");
        auto t=m_current;advance();
        if(t.text=="true"||t.text=="false"){auto n=std::make_unique<Node>();n->kind=Node::Kind::Boolean;n->booleanValue=t.text=="true";n->column=t.column;return n;}
        PauseSignalMode mode=PauseSignalMode::Value;
        if(m_current.kind==TokenKind::LParen){
            if(t.text=="V")mode=PauseSignalMode::Voltage;else if(t.text=="digital")mode=PauseSignalMode::Digital;else if(t.text=="I")mode=PauseSignalMode::Current;else if(t.text=="rising")mode=PauseSignalMode::Rising;else if(t.text=="falling")mode=PauseSignalMode::Falling;else throw PauseExpressionError(t.column,"função não suportada: "+t.text);
            advance();if(m_current.kind!=TokenKind::Identifier)error("função requer uma referência de sinal");t=m_current;advance();if(m_current.kind!=TokenKind::RParen)error("esperado ) após sinal");advance();
        }
        auto n=std::make_unique<Node>();n->kind=Node::Kind::Signal;n->column=t.column;n->reference=t.text;n->mode=mode;return n;
    }
    Lexer m_lexer;Token m_current{TokenKind::End,"",1};
};
}

PauseExpression::PauseExpression()=default; PauseExpression::~PauseExpression()=default;
PauseExpression::PauseExpression(PauseExpression&&) noexcept=default; PauseExpression& PauseExpression::operator=(PauseExpression&&) noexcept=default;
PauseExpression PauseExpression::compile(const std::string& expression){PauseExpression result;result.m_source=expression;if(expression.find_first_not_of(" \t\r\n")==std::string::npos)return result;result.m_root=Parser(expression).parse();return result;}
bool PauseExpression::empty()const{return !m_root;}
void PauseExpression::resetEdges(){m_previousEdges.clear();}

PauseEvaluation PauseExpression::evaluate(const Resolver& resolver){
    PauseEvaluation result;
    std::function<PauseScalar(const Node&)> eval=[&](const Node& n)->PauseScalar{
        switch(n.kind){
        case Node::Kind::Number:return n.number;case Node::Kind::Boolean:return n.booleanValue;
        case Node::Kind::Signal:{PauseScalar current;try{current=resolver(n.mode,n.reference);}catch(const PauseExpressionError&){throw;}catch(const std::exception& error){throw PauseExpressionError(n.column,error.what());}const std::string key=std::to_string(static_cast<int>(n.mode))+":"+n.reference;result.resolvedValues[key]=current;if(n.mode==PauseSignalMode::Rising||n.mode==PauseSignalMode::Falling){const bool now=boolean(current);const auto previous=m_previousEdges.find(key);const bool edge=previous!=m_previousEdges.end()&&(n.mode==PauseSignalMode::Rising?!previous->second&&now:previous->second&&!now);m_previousEdges[key]=now;return edge;}return current;}
        case Node::Kind::Not:return !boolean(eval(*n.left));case Node::Kind::And:{const bool a=boolean(eval(*n.left));return a&&boolean(eval(*n.right));}case Node::Kind::Or:{const bool a=boolean(eval(*n.left));return a||boolean(eval(*n.right));}
        default:{const double a=numeric(eval(*n.left)),b=numeric(eval(*n.right));switch(n.kind){case Node::Kind::Eq:return a==b;case Node::Kind::Ne:return a!=b;case Node::Kind::Lt:return a<b;case Node::Kind::Le:return a<=b;case Node::Kind::Gt:return a>b;case Node::Kind::Ge:return a>=b;default:return false;}}
        }
    };
    if(m_root)result.value=boolean(eval(*m_root));return result;
}
} // namespace lasecsimul::session
