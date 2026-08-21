/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Adapted from Autonomy-Logic/openplc-editor v4.2.10
 * src/middleware/shared/ports/library-types.ts
 * Commit and source hash: scripts/openplc-editor-pin.json
 */

export type OpenPlcLibraryPouType = "function" | "function-block";
export type OpenPlcLibraryLanguage = "il" | "st" | "ld" | "sfc" | "fbd" | "cpp";

export interface OpenPlcSystemLibraryVariable {
  name: string;
  class: "input" | "output" | "local" | "inOut";
  type:
    | { definition: "base-type"; value: string }
    | { definition: "derived-type"; value: string }
    | { definition: "generic-type"; value: string };
  location?: string;
  initialValue?: unknown;
  documentation?: string;
}

export interface OpenPlcSystemLibraryPou {
  name: string;
  type: OpenPlcLibraryPouType;
  language: OpenPlcLibraryLanguage;
  variables: OpenPlcSystemLibraryVariable[];
  body: string;
  documentation: string;
  extensible?: boolean;
  category?: string;
}

export interface OpenPlcSystemLibrary {
  name: string;
  displayName?: string;
  author: string;
  version: string;
  stPath: string;
  cPath: string;
  pous: OpenPlcSystemLibraryPou[];
}
