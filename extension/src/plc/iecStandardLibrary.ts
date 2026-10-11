// GERADO por scripts/generate-iec-standard-library.py a partir do STruCpp 0.6.3 -- não editar.
// Bibliotecas: iec-standard-fb, iec-std-functions, additional-function-blocks.

export interface IecStdParameter {
  name: string;
  type: string;
}

export interface IecStdFunctionBlock {
  library: string;
  inputs: IecStdParameter[];
  outputs: IecStdParameter[];
  inouts: IecStdParameter[];
}

export interface IecStdFunction {
  /** Tipo de retorno; ANY_* quando o retorno segue o tipo dos argumentos de mesmo genérico. */
  returnType: string;
  parameters: IecStdParameter[];
  /** Presente nas funções extensíveis (ADD, AND, MAX, MUX...): mínimo de argumentos. */
  minArgs?: number;
}

export const IEC_STANDARD_LIBRARY_VERSION = "0.6.3";

export const IEC_STANDARD_FUNCTION_BLOCKS: Readonly<Record<string, IecStdFunctionBlock>> = {
  "R_TRIG": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CLK",
        "type": "BOOL"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      }
    ],
    "inouts": []
  },
  "F_TRIG": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CLK",
        "type": "BOOL"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      }
    ],
    "inouts": []
  },
  "SR": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "S1",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      }
    ],
    "outputs": [
      {
        "name": "Q1",
        "type": "BOOL"
      }
    ],
    "inouts": []
  },
  "RS": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "S",
        "type": "BOOL"
      },
      {
        "name": "R1",
        "type": "BOOL"
      }
    ],
    "outputs": [
      {
        "name": "Q1",
        "type": "BOOL"
      }
    ],
    "inouts": []
  },
  "SEMA": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CLAIM",
        "type": "BOOL"
      },
      {
        "name": "RELEASE",
        "type": "BOOL"
      }
    ],
    "outputs": [
      {
        "name": "BUSY",
        "type": "BOOL"
      }
    ],
    "inouts": []
  },
  "CTU": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "INT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "INT"
      }
    ],
    "inouts": []
  },
  "CTD": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "INT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "INT"
      }
    ],
    "inouts": []
  },
  "CTUD": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "INT"
      }
    ],
    "outputs": [
      {
        "name": "QU",
        "type": "BOOL"
      },
      {
        "name": "QD",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "INT"
      }
    ],
    "inouts": []
  },
  "CTU_DINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "DINT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "DINT"
      }
    ],
    "inouts": []
  },
  "CTU_LINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "LINT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "LINT"
      }
    ],
    "inouts": []
  },
  "CTU_UDINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "UDINT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "UDINT"
      }
    ],
    "inouts": []
  },
  "CTU_ULINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "ULINT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "ULINT"
      }
    ],
    "inouts": []
  },
  "CTD_DINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "DINT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "DINT"
      }
    ],
    "inouts": []
  },
  "CTD_LINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "LINT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "LINT"
      }
    ],
    "inouts": []
  },
  "CTD_UDINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "UDINT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "UDINT"
      }
    ],
    "inouts": []
  },
  "CTD_ULINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "ULINT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "ULINT"
      }
    ],
    "inouts": []
  },
  "CTUD_DINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "DINT"
      }
    ],
    "outputs": [
      {
        "name": "QU",
        "type": "BOOL"
      },
      {
        "name": "QD",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "DINT"
      }
    ],
    "inouts": []
  },
  "CTUD_LINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "LINT"
      }
    ],
    "outputs": [
      {
        "name": "QU",
        "type": "BOOL"
      },
      {
        "name": "QD",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "LINT"
      }
    ],
    "inouts": []
  },
  "CTUD_UDINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "UDINT"
      }
    ],
    "outputs": [
      {
        "name": "QU",
        "type": "BOOL"
      },
      {
        "name": "QD",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "UDINT"
      }
    ],
    "inouts": []
  },
  "CTUD_ULINT": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "CU",
        "type": "BOOL"
      },
      {
        "name": "CD",
        "type": "BOOL"
      },
      {
        "name": "R",
        "type": "BOOL"
      },
      {
        "name": "LD",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "ULINT"
      }
    ],
    "outputs": [
      {
        "name": "QU",
        "type": "BOOL"
      },
      {
        "name": "QD",
        "type": "BOOL"
      },
      {
        "name": "CV",
        "type": "ULINT"
      }
    ],
    "inouts": []
  },
  "TON": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "IN",
        "type": "BOOL"
      },
      {
        "name": "PT",
        "type": "TIME"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "ET",
        "type": "TIME"
      }
    ],
    "inouts": []
  },
  "TOF": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "IN",
        "type": "BOOL"
      },
      {
        "name": "PT",
        "type": "TIME"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "ET",
        "type": "TIME"
      }
    ],
    "inouts": []
  },
  "TP": {
    "library": "iec-standard-fb",
    "inputs": [
      {
        "name": "IN",
        "type": "BOOL"
      },
      {
        "name": "PT",
        "type": "TIME"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "ET",
        "type": "TIME"
      }
    ],
    "inouts": []
  },
  "INTEGRAL": {
    "library": "additional-function-blocks",
    "inputs": [
      {
        "name": "RUN",
        "type": "BOOL"
      },
      {
        "name": "R1",
        "type": "BOOL"
      },
      {
        "name": "XIN",
        "type": "REAL"
      },
      {
        "name": "X0",
        "type": "REAL"
      },
      {
        "name": "CYCLE",
        "type": "TIME"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "XOUT",
        "type": "REAL"
      }
    ],
    "inouts": []
  },
  "DERIVATIVE": {
    "library": "additional-function-blocks",
    "inputs": [
      {
        "name": "RUN",
        "type": "BOOL"
      },
      {
        "name": "XIN",
        "type": "REAL"
      },
      {
        "name": "CYCLE",
        "type": "TIME"
      }
    ],
    "outputs": [
      {
        "name": "XOUT",
        "type": "REAL"
      }
    ],
    "inouts": []
  },
  "RTC": {
    "library": "additional-function-blocks",
    "inputs": [
      {
        "name": "IN",
        "type": "BOOL"
      },
      {
        "name": "PDT",
        "type": "DT"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      },
      {
        "name": "CDT",
        "type": "DT"
      }
    ],
    "inouts": []
  },
  "PID": {
    "library": "additional-function-blocks",
    "inputs": [
      {
        "name": "AUTO",
        "type": "BOOL"
      },
      {
        "name": "PV",
        "type": "REAL"
      },
      {
        "name": "SP",
        "type": "REAL"
      },
      {
        "name": "X0",
        "type": "REAL"
      },
      {
        "name": "KP",
        "type": "REAL"
      },
      {
        "name": "TR",
        "type": "REAL"
      },
      {
        "name": "TD",
        "type": "REAL"
      },
      {
        "name": "CYCLE",
        "type": "TIME"
      }
    ],
    "outputs": [
      {
        "name": "XOUT",
        "type": "REAL"
      }
    ],
    "inouts": []
  },
  "RAMP": {
    "library": "additional-function-blocks",
    "inputs": [
      {
        "name": "RUN",
        "type": "BOOL"
      },
      {
        "name": "X0",
        "type": "REAL"
      },
      {
        "name": "X1",
        "type": "REAL"
      },
      {
        "name": "TR",
        "type": "TIME"
      },
      {
        "name": "CYCLE",
        "type": "TIME"
      }
    ],
    "outputs": [
      {
        "name": "BUSY",
        "type": "BOOL"
      },
      {
        "name": "XOUT",
        "type": "REAL"
      }
    ],
    "inouts": []
  },
  "HYSTERESIS": {
    "library": "additional-function-blocks",
    "inputs": [
      {
        "name": "XIN1",
        "type": "REAL"
      },
      {
        "name": "XIN2",
        "type": "REAL"
      },
      {
        "name": "EPS",
        "type": "REAL"
      }
    ],
    "outputs": [
      {
        "name": "Q",
        "type": "BOOL"
      }
    ],
    "inouts": []
  }
};

export const IEC_STANDARD_FUNCTIONS: Readonly<Record<string, IecStdFunction>> = {
  "ABS": {
    "returnType": "ANY_NUM",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_NUM"
      }
    ]
  },
  "ACOS": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "ADD": {
    "returnType": "ANY_NUM",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_NUM"
      },
      {
        "name": "IN2",
        "type": "ANY_NUM"
      }
    ],
    "minArgs": 2
  },
  "ADR": {
    "returnType": "__XWORD",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "AND": {
    "returnType": "ANY_BIT",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_BIT"
      },
      {
        "name": "IN2",
        "type": "ANY_BIT"
      }
    ],
    "minArgs": 2
  },
  "ASIN": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "ATAN": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "ATAN2": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_REAL"
      },
      {
        "name": "IN2",
        "type": "ANY_REAL"
      }
    ]
  },
  "CONCAT": {
    "returnType": "ANY_STRING",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_STRING"
      },
      {
        "name": "IN2",
        "type": "ANY_STRING"
      }
    ],
    "minArgs": 2
  },
  "COS": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "CURRENT_DT": {
    "returnType": "DT",
    "parameters": []
  },
  "DELETE": {
    "returnType": "ANY_STRING",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_STRING"
      },
      {
        "name": "L",
        "type": "INT"
      },
      {
        "name": "P",
        "type": "INT"
      }
    ]
  },
  "DIV": {
    "returnType": "ANY_NUM",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_NUM"
      },
      {
        "name": "IN2",
        "type": "ANY_NUM"
      }
    ]
  },
  "EQ": {
    "returnType": "BOOL",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN2",
        "type": "ANY_ELEMENTARY"
      }
    ],
    "minArgs": 2
  },
  "EXP": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "EXPT": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_REAL"
      },
      {
        "name": "IN2",
        "type": "ANY_REAL"
      }
    ]
  },
  "FIND": {
    "returnType": "INT",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_STRING"
      },
      {
        "name": "IN2",
        "type": "ANY_STRING"
      }
    ]
  },
  "GE": {
    "returnType": "BOOL",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN2",
        "type": "ANY_ELEMENTARY"
      }
    ],
    "minArgs": 2
  },
  "GT": {
    "returnType": "BOOL",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN2",
        "type": "ANY_ELEMENTARY"
      }
    ],
    "minArgs": 2
  },
  "INSERT": {
    "returnType": "ANY_STRING",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_STRING"
      },
      {
        "name": "IN2",
        "type": "ANY_STRING"
      },
      {
        "name": "P",
        "type": "INT"
      }
    ]
  },
  "LE": {
    "returnType": "BOOL",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN2",
        "type": "ANY_ELEMENTARY"
      }
    ],
    "minArgs": 2
  },
  "LEFT": {
    "returnType": "ANY_STRING",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_STRING"
      },
      {
        "name": "L",
        "type": "INT"
      }
    ]
  },
  "LEN": {
    "returnType": "INT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_STRING"
      }
    ]
  },
  "LIMIT": {
    "returnType": "ANY_ELEMENTARY",
    "parameters": [
      {
        "name": "MN",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "MX",
        "type": "ANY_ELEMENTARY"
      }
    ]
  },
  "LN": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "LOG": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "LOWER_BOUND": {
    "returnType": "DINT",
    "parameters": [
      {
        "name": "ARR",
        "type": "ANY"
      },
      {
        "name": "DIM",
        "type": "ANY_INT"
      }
    ]
  },
  "LT": {
    "returnType": "BOOL",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN2",
        "type": "ANY_ELEMENTARY"
      }
    ],
    "minArgs": 2
  },
  "MAX": {
    "returnType": "ANY_ELEMENTARY",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN2",
        "type": "ANY_ELEMENTARY"
      }
    ],
    "minArgs": 2
  },
  "MEMCPY": {
    "returnType": "ULINT",
    "parameters": [
      {
        "name": "DEST",
        "type": "ANY"
      },
      {
        "name": "SRC",
        "type": "ANY"
      },
      {
        "name": "N",
        "type": "ANY_INT"
      }
    ]
  },
  "MID": {
    "returnType": "ANY_STRING",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_STRING"
      },
      {
        "name": "L",
        "type": "INT"
      },
      {
        "name": "P",
        "type": "INT"
      }
    ]
  },
  "MIN": {
    "returnType": "ANY_ELEMENTARY",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN2",
        "type": "ANY_ELEMENTARY"
      }
    ],
    "minArgs": 2
  },
  "MOD": {
    "returnType": "ANY_NUM",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_NUM"
      },
      {
        "name": "IN2",
        "type": "ANY_NUM"
      }
    ]
  },
  "MOVE": {
    "returnType": "ANY",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "MUL": {
    "returnType": "ANY_NUM",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_NUM"
      },
      {
        "name": "IN2",
        "type": "ANY_NUM"
      }
    ],
    "minArgs": 2
  },
  "MUX": {
    "returnType": "ANY",
    "parameters": [
      {
        "name": "K",
        "type": "INT"
      },
      {
        "name": "IN0",
        "type": "ANY"
      },
      {
        "name": "IN1",
        "type": "ANY"
      }
    ],
    "minArgs": 3
  },
  "NE": {
    "returnType": "BOOL",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_ELEMENTARY"
      },
      {
        "name": "IN2",
        "type": "ANY_ELEMENTARY"
      }
    ],
    "minArgs": 2
  },
  "NEG": {
    "returnType": "ANY_NUM",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_NUM"
      }
    ]
  },
  "NOT": {
    "returnType": "ANY_BIT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_BIT"
      }
    ]
  },
  "OR": {
    "returnType": "ANY_BIT",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_BIT"
      },
      {
        "name": "IN2",
        "type": "ANY_BIT"
      }
    ],
    "minArgs": 2
  },
  "REF_LINK": {
    "returnType": "__XWORD",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "REPLACE": {
    "returnType": "ANY_STRING",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_STRING"
      },
      {
        "name": "IN2",
        "type": "ANY_STRING"
      },
      {
        "name": "L",
        "type": "INT"
      },
      {
        "name": "P",
        "type": "INT"
      }
    ]
  },
  "RIGHT": {
    "returnType": "ANY_STRING",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_STRING"
      },
      {
        "name": "L",
        "type": "INT"
      }
    ]
  },
  "ROL": {
    "returnType": "ANY_BIT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_BIT"
      },
      {
        "name": "N",
        "type": "INT"
      }
    ]
  },
  "ROR": {
    "returnType": "ANY_BIT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_BIT"
      },
      {
        "name": "N",
        "type": "INT"
      }
    ]
  },
  "ROUND": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "SEL": {
    "returnType": "ANY",
    "parameters": [
      {
        "name": "G",
        "type": "BOOL"
      },
      {
        "name": "IN0",
        "type": "ANY"
      },
      {
        "name": "IN1",
        "type": "ANY"
      }
    ]
  },
  "SHL": {
    "returnType": "ANY_BIT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_BIT"
      },
      {
        "name": "N",
        "type": "INT"
      }
    ]
  },
  "SHR": {
    "returnType": "ANY_BIT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_BIT"
      },
      {
        "name": "N",
        "type": "INT"
      }
    ]
  },
  "SIN": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "SIZEOF": {
    "returnType": "UDINT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "SQRT": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "SUB": {
    "returnType": "ANY_NUM",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_NUM"
      },
      {
        "name": "IN2",
        "type": "ANY_NUM"
      }
    ]
  },
  "TAN": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "TIME": {
    "returnType": "TIME",
    "parameters": []
  },
  "TIME_FROM_MS": {
    "returnType": "TIME",
    "parameters": [
      {
        "name": "IN",
        "type": "LINT"
      }
    ]
  },
  "TIME_FROM_S": {
    "returnType": "TIME",
    "parameters": [
      {
        "name": "IN",
        "type": "LREAL"
      }
    ]
  },
  "TIME_TO_MS": {
    "returnType": "LINT",
    "parameters": [
      {
        "name": "IN",
        "type": "TIME"
      }
    ]
  },
  "TIME_TO_S": {
    "returnType": "LREAL",
    "parameters": [
      {
        "name": "IN",
        "type": "TIME"
      }
    ]
  },
  "TO_BOOL": {
    "returnType": "BOOL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_BYTE": {
    "returnType": "BYTE",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_DATE": {
    "returnType": "DATE",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_DINT": {
    "returnType": "DINT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_DT": {
    "returnType": "DT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_DWORD": {
    "returnType": "DWORD",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_INT": {
    "returnType": "INT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_LINT": {
    "returnType": "LINT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_LREAL": {
    "returnType": "LREAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_LWORD": {
    "returnType": "LWORD",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_REAL": {
    "returnType": "REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_SINT": {
    "returnType": "SINT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_STRING": {
    "returnType": "STRING",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_TIME": {
    "returnType": "TIME",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_TOD": {
    "returnType": "TOD",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_UDINT": {
    "returnType": "UDINT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_UINT": {
    "returnType": "UINT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_ULINT": {
    "returnType": "ULINT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_USINT": {
    "returnType": "USINT",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TO_WORD": {
    "returnType": "WORD",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY"
      }
    ]
  },
  "TRUNC": {
    "returnType": "ANY_REAL",
    "parameters": [
      {
        "name": "IN",
        "type": "ANY_REAL"
      }
    ]
  },
  "UPPER_BOUND": {
    "returnType": "DINT",
    "parameters": [
      {
        "name": "ARR",
        "type": "ANY"
      },
      {
        "name": "DIM",
        "type": "ANY_INT"
      }
    ]
  },
  "XOR": {
    "returnType": "ANY_BIT",
    "parameters": [
      {
        "name": "IN1",
        "type": "ANY_BIT"
      },
      {
        "name": "IN2",
        "type": "ANY_BIT"
      }
    ],
    "minArgs": 2
  }
};
