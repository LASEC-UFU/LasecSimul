import type { ControlDesignProject } from "./types.js";

/** Return a detached project snapshot for the current design or a stored controller design. */
export function projectForExportDesign(project:ControlDesignProject,alternativeName?:string):ControlDesignProject {
  const result=structuredClone(project);
  if(!alternativeName)return result;
  const alternative=project.alternatives.find(item=>item.name===alternativeName);
  if(!alternative)throw new Error("O design selecionado para exportação não existe mais.");
  result.C=structuredClone(alternative.controller);
  result.F=structuredClone(alternative.prefilter??project.F);
  result.C2=structuredClone(alternative.innerController??project.C2??{num:"1",den:"1"});
  if(alternative.measurementDerivativeModel)result.measurementDerivativeModel=structuredClone(alternative.measurementDerivativeModel);
  else delete result.measurementDerivativeModel;
  result.activeAlternative=alternativeName;
  return result;
}

/** Keep the current-design export filename unchanged; give stored designs readable filenames. */
export function exportDesignFileStem(name?:string):string {
  if(!name)return "";
  const slug=name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9_-]+/g,"-").replace(/^-+|-+$/g,"");
  return slug||"design";
}
