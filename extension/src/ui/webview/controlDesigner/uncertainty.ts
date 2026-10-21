import { stateSpaceToTf, validateTf, type StateSpaceModel, type TransferFunction } from "./lti.js";
import { compileParameterExpression } from "./parameterExpression.js";

export interface CoefficientSamplingOptions {
  count: number;
  tolerancePercent: number;
  seed: number;
  /** Coefficient paths assigned the same uncertain real parameter share one draw per sample. */
  sharedParameterGroups?: Readonly<Record<string, string>>;
  /** Named real parameters with actual-value ranges and monomial coefficient dependencies. */
  parameterUncertainty?: {
    parameters: Readonly<Record<string, { nominal: number; range: readonly [number, number] }>>;
    coefficients?: Readonly<Record<string, readonly { parameter: string; power: number }[]>>;
    /** Affine coefficient models: c = c0 + sum(scale * (p - p0)). */
    affineCoefficients?: Readonly<Record<string, readonly { parameter: string; scale: number }[]>>;
    /** General real-valued expressions that directly define the named coefficients. */
    expressions?: Readonly<Record<string, string>>;
  };
}

/** Generate reproducible uniform relative perturbations of TF coefficients. */
export function sampleTransferFunctionCoefficients(
  model: TransferFunction,
  options: CoefficientSamplingOptions,
): TransferFunction[] {
  const { count, tolerancePercent, seed, sharedParameterGroups = {}, parameterUncertainty } = options;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("Sample count must be an integer from 1 to 100.");
  }
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 100) {
    throw new Error("Coefficient tolerance must be between 0 and 100 percent.");
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error("Sampling seed must be an unsigned 32-bit integer.");
  }

  const nominal = validateTf(model);
  const parameterNames = Object.keys(parameterUncertainty?.parameters ?? {});
  if (parameterUncertainty && (!parameterNames.length || !Object.keys(parameterUncertainty.coefficients ?? {}).length && !Object.keys(parameterUncertainty.affineCoefficients ?? {}).length && !Object.keys(parameterUncertainty.expressions ?? {}).length)) throw new Error("Parameter uncertainty needs at least one named parameter and one coefficient dependency.");
  for (const [name, parameter] of Object.entries(parameterUncertainty?.parameters ?? {})) {
    const [low, high] = parameter.range;
    if (!name.trim() || !Number.isFinite(parameter.nominal) || !Number.isFinite(low) || !Number.isFinite(high) || low > high || parameter.nominal < low || parameter.nominal > high) {
      throw new Error(`Invalid nominal value or range for uncertain parameter ${name}.`);
    }
  }
  const coefficientTerms = parameterUncertainty?.coefficients ?? {}, affineTerms = parameterUncertainty?.affineCoefficients ?? {}, expressionSources = parameterUncertainty?.expressions ?? {};
  const compiledExpressions = new Map(Object.entries(expressionSources).map(([path, source]) => [path, compileParameterExpression(source, parameterNames)]));
  const validatePath = (path: string, terms: readonly unknown[], kind: "monomial" | "affine") => {
    if (!new Set([...nominal.num.map((_, i) => `num[${i}]`), ...nominal.den.map((_, i) => `den[${i}]`)]).has(path)) throw new Error(`Unknown coefficient path: ${path}.`);
    if (path === "den[0]") throw new Error("The normalized leading denominator coefficient is fixed at 1 and cannot be parameterized.");
    const [part, rawIndex] = /^(num|den)\[(\d+)\]$/.exec(path)!.slice(1), nominalCoefficient = (part === "num" ? nominal.num : nominal.den)[Number(rawIndex)]!;
    if (kind === "monomial" && nominalCoefficient === 0) throw new Error(`Zero coefficient ${path} is structural in a power-based dependency; use an affine dependency to vary it.`);
    if (!Array.isArray(terms) || !terms.length) throw new Error(`At least one parameter dependency is required for ${path}.`);
    if (kind === "affine" && (coefficientTerms[path] || compiledExpressions.has(path))) throw new Error(`${path} cannot use more than one parameter dependency model.`);
    if (sharedParameterGroups[path] !== undefined) throw new Error(`${path} cannot use both a shared group and parameter dependencies.`);
    for (const term of terms) {
      const dependency = term as { parameter?: string; power?: number; scale?: number }, parameter = parameterUncertainty?.parameters[dependency.parameter ?? ""];
      if (!parameter || kind === "monomial" && (!Number.isFinite(dependency.power) || Math.abs(dependency.power!) > 8) || kind === "affine" && !Number.isFinite(dependency.scale)) throw new Error(`Invalid uncertain parameter dependency in ${path}.`);
      if (kind === "monomial" && dependency.power !== 0 && parameter.nominal === 0) throw new Error(`Parameter ${dependency.parameter} needs a nonzero nominal value for power-based dependencies.`);
    }
  };
  for (const [path, terms] of Object.entries(coefficientTerms)) validatePath(path, terms, "monomial");
  for (const [path, terms] of Object.entries(affineTerms)) validatePath(path, terms, "affine");
  const validTfPaths = new Set([...nominal.num.map((_, i) => `num[${i}]`), ...nominal.den.map((_, i) => `den[${i}]`)]);
  const nominalValues = new Map(parameterNames.map(name => [name, parameterUncertainty!.parameters[name]!.nominal] as const));
  for (const [path, evaluator] of compiledExpressions) {
    if (!validTfPaths.has(path) || path === "den[0]") throw new Error(`Invalid or fixed coefficient path: ${path}.`);
    if (coefficientTerms[path] || affineTerms[path] || sharedParameterGroups[path] !== undefined) throw new Error(`${path} cannot use more than one parameter dependency model.`);
    const [part, rawIndex] = /^(num|den)\[(\d+)\]$/.exec(path)!.slice(1), coefficients = part === "num" ? nominal.num : nominal.den, coefficientNominal = coefficients[Number(rawIndex)]!;
    const expressionNominal = evaluator(nominalValues);
    if (Math.abs(expressionNominal - coefficientNominal) > 1e-9 * Math.max(1, Math.abs(coefficientNominal))) throw new Error(`Expression for ${path} must reproduce its nominal coefficient (${coefficientNominal}).`);
  }
  if (parameterUncertainty && (!parameterNames.length || !Object.keys(coefficientTerms).length && !Object.keys(affineTerms).length && !Object.keys(expressionSources).length)) throw new Error("Parameter uncertainty needs at least one named parameter and one coefficient dependency.");
  let state = (seed >>> 0) || 0x6d2b79f5;
  const random = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const perturb = (coefficients: readonly number[], part: "num" | "den", keepLeading: boolean, sharedDraws: Map<string, number>, parameterValues: Map<string, number>): number[] => coefficients.map((coefficient, index) => {
    const key = `${part}[${index}]`;
    const terms = coefficientTerms[key];
    const affine = affineTerms[key];
    const expression = compiledExpressions.get(key);
    if (coefficient === 0 && !affine && !expression || keepLeading && index === 0) return coefficient;
    if (expression) return expression(parameterValues);
    if (terms) {
      const factor = terms.reduce((product, term) => product * Math.pow(parameterValues.get(term.parameter)! / parameterUncertainty!.parameters[term.parameter]!.nominal, term.power), 1);
      const value = coefficient * factor;
      if (!Number.isFinite(value)) throw new Error(`Parameter sample made ${key} non-finite.`);
      return value;
    }
    if (affine) {
      const value = coefficient + affine.reduce((sum, term) => sum + term.scale * (parameterValues.get(term.parameter)! - parameterUncertainty!.parameters[term.parameter]!.nominal), 0);
      if (!Number.isFinite(value)) throw new Error(`Parameter sample made ${key} non-finite.`);
      return value;
    }
    if (tolerancePercent === 0) return coefficient;
    const group = sharedParameterGroups[key]?.trim();
    if (sharedParameterGroups[key] !== undefined && !group) throw new Error(`Shared parameter name for ${key} cannot be empty.`);
    const relativeChange = group && sharedDraws.has(group)
      ? (sharedDraws.get(group) ?? 0)
      : (random() * 2 - 1) * tolerancePercent / 100;
    if (group) sharedDraws.set(group, relativeChange);
    return coefficient * (1 + relativeChange);
  });

  const validPaths = new Set([...nominal.num.map((_, i) => `num[${i}]`), ...nominal.den.map((_, i) => `den[${i}]`)]);
  for (const path of Object.keys(sharedParameterGroups)) if (!validPaths.has(path)) throw new Error(`Unknown coefficient path: ${path}.`);
  return Array.from({ length: count }, () => {
    const sharedDraws = new Map<string, number>();
    const parameterValues = new Map(parameterNames.map(name => {
      const parameter = parameterUncertainty!.parameters[name]!;
      return [name, parameter.range[0] + random() * (parameter.range[1] - parameter.range[0])] as const;
    }));
    return validateTf({
      num: perturb(nominal.num, "num", false, sharedDraws, parameterValues),
      den: perturb(nominal.den, "den", true, sharedDraws, parameterValues),
      domain: nominal.domain,
      ...(nominal.sampleTime === undefined ? {} : { sampleTime: nominal.sampleTime }),
    });
  });
}

/** Sample independent relative coefficient variation in a SISO realization. */
export function sampleStateSpaceCoefficients(
  model: StateSpaceModel,
  options: CoefficientSamplingOptions,
): StateSpaceModel[] {
  const { count, tolerancePercent, seed, parameterUncertainty } = options;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("Sample count must be an integer from 1 to 100.");
  }
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 100) {
    throw new Error("Coefficient tolerance must be between 0 and 100 percent.");
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error("Sampling seed must be an unsigned 32-bit integer.");
  }
  stateSpaceToTf(model);
  const parameters = parameterUncertainty?.parameters ?? {}, coefficientTerms = parameterUncertainty?.coefficients ?? {}, affineTerms = parameterUncertainty?.affineCoefficients ?? {}, expressionSources = parameterUncertainty?.expressions ?? {}, parameterNames = Object.keys(parameters);
  if (parameterUncertainty && (!parameterNames.length || !Object.keys(coefficientTerms).length && !Object.keys(affineTerms).length && !Object.keys(expressionSources).length)) throw new Error("Parameter uncertainty needs at least one named parameter and one coefficient dependency.");
  for (const [name, parameter] of Object.entries(parameters)) {
    const [low, high] = parameter.range;
    if (!name.trim() || !Number.isFinite(parameter.nominal) || !Number.isFinite(low) || !Number.isFinite(high) || low > high || parameter.nominal < low || parameter.nominal > high) throw new Error(`Invalid nominal value or range for uncertain parameter ${name}.`);
  }
  const nominalEntries: Record<string, number> = {};
  model.A.forEach((row,i)=>row.forEach((value,j)=>nominalEntries[`A[${i}][${j}]`]=value));
  model.B.forEach((value,i)=>nominalEntries[`B[${i}]`]=value);
  model.C.forEach((value,i)=>nominalEntries[`C[${i}]`]=value);
  nominalEntries.D=model.D;
  const compiledExpressions = new Map(Object.entries(expressionSources).map(([path, source]) => [path, compileParameterExpression(source, parameterNames)]));
  for (const [path, terms] of Object.entries(coefficientTerms)) {
    const coefficient=nominalEntries[path];
    if (coefficient === undefined) throw new Error(`Unknown state-space coefficient path: ${path}.`);
    if (coefficient === 0) throw new Error(`Zero coefficient ${path} is structural in a power-based dependency; use an affine dependency to vary it.`);
    if (!Array.isArray(terms) || !terms.length) throw new Error(`At least one parameter dependency is required for ${path}.`);
    if (affineTerms[path]) throw new Error(`${path} cannot use both monomial and affine parameter dependencies.`);
    for (const term of terms) {
      const parameter=parameters[term.parameter];
      if (!parameter || !Number.isFinite(term.power) || Math.abs(term.power)>8) throw new Error(`Invalid uncertain parameter dependency in ${path}.`);
      if (term.power!==0 && parameter.nominal===0) throw new Error(`Parameter ${term.parameter} needs a nonzero nominal value for power-based dependencies.`);
    }
  }
  for (const [path, terms] of Object.entries(affineTerms)) {
    if (nominalEntries[path] === undefined) throw new Error(`Unknown state-space coefficient path: ${path}.`);
    if (!Array.isArray(terms) || !terms.length) throw new Error(`At least one affine parameter dependency is required for ${path}.`);
    for (const term of terms) if (!parameters[term.parameter] || !Number.isFinite(term.scale)) throw new Error(`Invalid affine uncertain parameter dependency in ${path}.`);
  }
  const nominalValues = new Map(parameterNames.map(name => [name, parameters[name]!.nominal] as const));
  for (const [path, evaluator] of compiledExpressions) {
    const nominalCoefficient = nominalEntries[path];
    if (nominalCoefficient === undefined || coefficientTerms[path] || affineTerms[path]) throw new Error(`Invalid or conflicting state-space coefficient path: ${path}.`);
    const expressionNominal = evaluator(nominalValues);
    if (Math.abs(expressionNominal - nominalCoefficient) > 1e-9 * Math.max(1, Math.abs(nominalCoefficient))) throw new Error(`Expression for ${path} must reproduce its nominal coefficient (${nominalCoefficient}).`);
  }
  let state = (seed >>> 0) || 0x6d2b79f5;
  const random = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const perturb = (coefficient: number, path: string, values: Map<string,number>): number => {
    const terms=coefficientTerms[path];
    const affine=affineTerms[path];
    const expression=compiledExpressions.get(path);
    if(coefficient===0&&!affine&&!expression)return coefficient;
    if(expression)return expression(values);
    if(terms){const factor=terms.reduce((product,term)=>product*Math.pow(values.get(term.parameter)!/parameters[term.parameter]!.nominal,term.power),1),sample=coefficient*factor;if(!Number.isFinite(sample))throw new Error(`Parameter sample made ${path} non-finite.`);return sample}
    if(affine){const sample=coefficient+affine.reduce((sum,term)=>sum+term.scale*(values.get(term.parameter)!-parameters[term.parameter]!.nominal),0);if(!Number.isFinite(sample))throw new Error(`Parameter sample made ${path} non-finite.`);return sample}
    return tolerancePercent===0?coefficient:coefficient*(1+(random()*2-1)*tolerancePercent/100);
  };
  return Array.from({ length: count }, () => {
    const values=new Map(parameterNames.map(name=>{const parameter=parameters[name]!;return[name,parameter.range[0]+random()*(parameter.range[1]-parameter.range[0])] as const}));
    const A=model.A.map((row,i)=>row.map((value,j)=>perturb(value,`A[${i}][${j}]`,values)));
    const sample: StateSpaceModel = {
      A,
      B: model.B.map((value,i)=>perturb(value,`B[${i}]`,values)),
      C: model.C.map((value,i)=>perturb(value,`C[${i}]`,values)),
      D: perturb(model.D,"D",values),
      domain: model.domain,
      ...(model.sampleTime === undefined ? {} : { sampleTime: model.sampleTime }),
    };
    stateSpaceToTf(sample);
    return sample;
  });
}
