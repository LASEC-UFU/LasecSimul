# Autoria da documentação (padrão Doxygen)

O Help Center usa o catálogo unificado como fonte dos identificadores, categorias, parâmetros, pinos e ícones. Não repita esses campos em Markdown. Para componentes TypeScript, acrescente a explicação funcional no campo `help.description` do próprio registro. O esquema de parâmetros e o pacote de pinos continuam vindo do catálogo/Core.

## Convenção

```typescript
{
  typeId: "sl.integrator",
  label: "Integrator",
  category: "Controle",
  help: {
    description: "Descrição confirmada pelo comportamento implementado no bloco.",
  },
  // pinIds, propertySchema e defaultProperties continuam sendo dados do componente.
}
```

Use IDs permanentes independentes dos rótulos traduzidos. O campo `help.description` dos registros `.lsdevice` e do catálogo aparece na página automaticamente. Para documentação do código C/C++, use comentários `/** ... */` e comandos Doxygen, como `@brief`, `@param` e `@return`; o `Doxyfile` indexa as fontes nativas em `core/` e `devices/`. Doxygen não é usado para extrair a estrutura TypeScript, que continua vindo do catálogo unificado.

## Gerar e revisar

- `npm run docs:build` compila o LasecSimul e regenera `site/`.
- `npm run docs:generate` regenera a partir da última compilação.
- `npm run docs:check` executa a geração, os cenários de atualização do catálogo e o relatório de cobertura.
- `doxygen Doxyfile` gera a referência de código para desenvolvedores, caso o Doxygen esteja instalado.

O relatório `site/coverage.json` separa presença estrutural de conteúdo explicativo. Páginas sem descrição continuam marcadas como incompletas; não preencha lacunas com comportamento presumido. Para acrescentar exemplos, associe arquivos de exemplo existentes e valide os resultados em testes antes de descrevê-los.

## Fontes e limites

O gerador consome `loadUnifiedCatalog` e a especificação carregada das bibliotecas de blocos. Dados de dispositivos registrados apenas no perfil local de uma pessoa não podem ser publicados pelo build da documentação; bibliotecas distribuídas no repositório são descobertas pelo mecanismo de catálogo do aplicativo. Os ícones são copiados dos arquivos efetivos em `media/components/light`; aliases antigos conhecidos usam um símbolo equivalente existente, e essa decisão fica centralizada em `scripts/build-help-center.cjs`.
