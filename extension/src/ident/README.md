# Ident: importação e modelos SISO

## JSON de dados

O formato estruturado aceito por `parseIdentTable` é um objeto UTF-8 com vetores numéricos finitos e pareados. `time` é opcional quando `sampleTime` for informado; todos os tempos estão em segundos e `sampleTime` também está em segundos.

```json
{
  "name": "ensaio de degrau",
  "time": [0, 0.1, 0.2],
  "input": [0, 1, 1],
  "output": [0, 0.2, 0.35],
  "sampleTime": 0.1,
  "inputName": "u",
  "outputName": "y",
  "inputUnit": "V",
  "outputUnit": "V"
}
```

`time` precisa ser estritamente crescente. Dados com amostragem irregular continuam sendo preservados, mas devem ser reamostrados explicitamente antes de métodos que exigem passo uniforme. CSV e TSV permitem mapear colunas, delimitador, cabeçalho, unidades e `Ts`; células entre aspas são aceitas, mas campos entre aspas que contenham quebra de linha não são.

## Convenções de modelos

- Ident é SISO. Em ARX/ARMAX/OE/Box-Jenkins, o atraso `nk` é separado de `B`; coeficientes são guardados em potências decrescentes de `z` para inserção nos blocos discretos.
- ARX usa QR reortogonalizado. ARMAX, OE e Box-Jenkins usam predição de erro com Gauss-Newton amortecido e armazenam o ruído separado da dinâmica da planta.
- Processo FOPDT estima ganho com sinal, constante de tempo positiva e atraso por busca de perfil. Processo de segunda ordem estima ganho com sinal, frequência natural positiva, amortecimento positivo e atraso por erro de simulação RK4.
- O integrador estima o ganho de `K/s` por mínimos quadrados sobre a integral retangular da entrada. A função de transferência contínua permite escolher `np`, `nz < np` e atraso em amostras; usa Gauss-Newton amortecido e integração RK4, sem impor estabilidade.
- Ho-Kalman é uma realização a partir de parâmetros de Markov estimados por FIR-QR. Não é N4SID. A opção contínua usa conversão ZOH e pode falhar quando o logaritmo real não existe ou é mal condicionado.
- Para realizações discretas, `x₀` pode ser editado depois da estimação e recalculado sobre o conjunto avaliado. Ao usar dados de validação para essa edição, as métricas deixam de ser uma validação independente da condição inicial.
- Ajuste é `100 × (1 − ||y − ŷ|| / ||y − média(y)||)`; não é limitado a zero. Para saída constante, é definido como zero. AIC/BIC usam o erro quadrático e número de parâmetros indicado pelo estimador.
- Resíduos, simulação e predição de um passo são identificados no modelo. Ajustes sem conjunto independente não demonstram generalização.

Projetos Ident podem ser exportados em JSON por “Exportar projeto”; modelos individuais são exportados como JSON separado. A persistência principal permanece dentro do `.lsproj` aberto.

## Limites de integração

O bloco `control.state_space` persiste e aplica o vetor de estado inicial `x0`; Ident o encaminha ao circuito com A/B/C/D. A funcao de transferencia identificada e SISO e propria. Atrasos puros sao inseridos somente no FOPDT.


PRBS and chirp excitations can be configured and exported as time/input CSV. Model comparisons include time response, overlaid Bode magnitude and phase, plus pole/zero roots. For families without explicit states, editable y0 adds a constant output offset and recalculates residuals and fit metrics; it does not replace a physical state condition.
