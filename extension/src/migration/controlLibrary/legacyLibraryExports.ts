// Gerado por scripts/generate-legacy-control-snapshot.mjs a partir de ab4c1efb7 -- nao editar.
// Blocos legados exportados pelos subcircuitos da biblioteca ANTES da migração (docs/68-69).
import type { LegacyLibrarySnapshot } from "./migrateDocument";

export const LEGACY_LIBRARY_REVISION = "ab4c1efb7";
export const LEGACY_LIBRARY_EXPORTS: LegacyLibrarySnapshot = {
  "subcircuits.control.accumulator": {
    "stage": {
      "typeId": "control.accumulator",
      "properties": {
        "initial": 0,
        "lowerLimitEnabled": true,
        "lowerLimit": 0,
        "upperLimitEnabled": false,
        "upperLimit": 100,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.bias": {
    "stage": {
      "typeId": "control.bias",
      "properties": {
        "bias": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.dead_time": {
    "stage": {
      "typeId": "control.dead_time",
      "properties": {
        "delay": 0.1,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.deadband": {
    "stage": {
      "typeId": "control.deadband",
      "properties": {
        "width": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.divide": {
    "stage": {
      "typeId": "control.divide",
      "properties": {
        "inputs": [
          "in0",
          "in1"
        ],
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.filtered_derivative": {
    "stage": {
      "typeId": "control.filtered_derivative",
      "properties": {
        "gain": 1,
        "filterTau": 0.01,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.first_order": {
    "stage": {
      "typeId": "control.first_order",
      "properties": {
        "gain": 1,
        "tau": 1,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.fopdt": {
    "stage": {
      "typeId": "control.fopdt",
      "properties": {
        "gain": 1,
        "tau": 1,
        "delay": 0.1,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.gain": {
    "stage": {
      "typeId": "control.gain",
      "properties": {
        "gain": 1,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.hysteresis": {
    "stage": {
      "typeId": "control.hysteresis",
      "properties": {
        "low": 0,
        "high": 1,
        "lowOutput": 0,
        "highOutput": 1,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.integrator": {
    "stage": {
      "typeId": "control.integrator",
      "properties": {
        "gain": 1,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.lead_lag": {
    "stage": {
      "typeId": "control.lead_lag",
      "properties": {
        "gain": 1,
        "leadTau": 0,
        "lagTau": 1,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.limiter": {
    "stage": {
      "typeId": "control.limiter",
      "properties": {
        "minimum": 0,
        "maximum": 100,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.pid": {
    "stage": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 0,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "initialIntegral": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.product": {
    "stage": {
      "typeId": "control.product",
      "properties": {
        "inputs": [
          "in0",
          "in1"
        ],
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.rate_limiter": {
    "stage": {
      "typeId": "control.rate_limiter",
      "properties": {
        "riseRate": 1,
        "fallRate": 1,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.saturation": {
    "stage": {
      "typeId": "control.saturation",
      "properties": {
        "minimum": 0,
        "maximum": 100,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.second_order": {
    "stage": {
      "typeId": "control.second_order",
      "properties": {
        "gain": 1,
        "omega": 1,
        "zeta": 1,
        "initial": 0,
        "initialDerivative": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.stiction": {
    "stage": {
      "typeId": "control.stiction",
      "properties": {
        "breakaway": 0,
        "slip": 0,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.subtract": {
    "stage": {
      "typeId": "control.subtract",
      "properties": {
        "inputs": [
          "in0",
          "in1"
        ],
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.sum": {
    "stage": {
      "typeId": "control.sum",
      "properties": {
        "inputs": [
          "in0",
          "in1"
        ],
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.transfer_function": {
    "stage": {
      "typeId": "control.transfer_function",
      "properties": {
        "model": "first_order",
        "gain": 1,
        "tau": 1,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.unit_delay": {
    "stage": {
      "typeId": "control.unit_delay",
      "properties": {
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.control.valve_characteristic": {
    "stage": {
      "typeId": "control.valve_characteristic",
      "properties": {
        "coefficient": 1,
        "exponent": 1,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.hart.smar_fy301": {
    "c_type": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Lind (linear, direta);1=Linr (linear, reversa);2=Rotd (rotativa, direta);3=Rotr (rotativa, reversa)"
      }
    },
    "c_air": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=AIR_OPEN (o ar aumenta a posição);1=AIR_CLOSED (o ar diminui a posição)"
      }
    },
    "c_char": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Lin (linear);1=EP 1:25 (igual porcentagem);2=EP 1:33;3=EP 1:50;4=AR 1:25 (abertura rápida, hiperbólica);5=AR 1:33;6=AR 1:50"
      }
    },
    "c_mode": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Auto (segue os 4-20 mA);1=Man (segue o SP%)"
      }
    },
    "c_sp": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "%"
      }
    },
    "c_time": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "s"
      }
    },
    "c_kp": {
      "typeId": "control.constant",
      "properties": {
        "value": 40,
        "unit": ""
      }
    },
    "c_tr": {
      "typeId": "control.constant",
      "properties": {
        "value": 2,
        "unit": "min/rep"
      }
    },
    "c_lopos": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "%"
      }
    },
    "c_uppos": {
      "typeId": "control.constant",
      "properties": {
        "value": 100,
        "unit": "%"
      }
    },
    "c_tso": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "%"
      }
    },
    "c_spl": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "%"
      }
    },
    "c_sph": {
      "typeId": "control.constant",
      "properties": {
        "value": 100,
        "unit": "%"
      }
    },
    "c_slo": {
      "typeId": "control.constant",
      "properties": {
        "value": 4,
        "unit": "mA"
      }
    },
    "c_shi": {
      "typeId": "control.constant",
      "properties": {
        "value": 20,
        "unit": "mA"
      }
    },
    "c_setup": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Parado;1=Executar"
      }
    }
  },
  "subcircuits.hart.smar_tt301": {
    "c_tterm": {
      "typeId": "control.constant",
      "properties": {
        "value": 25,
        "unit": "°C"
      }
    }
  },
  "subcircuits.process.control_valve": {
    "c_supply": {
      "typeId": "control.constant",
      "properties": {
        "value": 1.4,
        "unit": "bar"
      }
    },
    "c_action": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Ar para abrir (mola fecha: falha fechada);1=Ar para fechar (mola abre: falha aberta)"
      }
    },
    "c_plo": {
      "typeId": "control.constant",
      "properties": {
        "value": 0.2,
        "unit": "bar"
      }
    },
    "c_phi": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "bar"
      }
    },
    "c_stroke": {
      "typeId": "control.constant",
      "properties": {
        "value": 20,
        "unit": "mm"
      }
    },
    "c_tau": {
      "typeId": "control.constant",
      "properties": {
        "value": 0.5,
        "unit": "s"
      }
    },
    "c_friction": {
      "typeId": "control.constant",
      "properties": {
        "value": 0.5,
        "unit": "% do curso"
      }
    },
    "c_kvs": {
      "typeId": "control.constant",
      "properties": {
        "value": 10,
        "unit": "m³/h"
      }
    },
    "c_char": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Linear;1=Igual porcentagem (R = 50);2=Abertura rápida"
      }
    },
    "c_dp": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "bar"
      }
    }
  },
  "subcircuits.process.electric_furnace_tc": {
    "c_pmax": {
      "typeId": "control.constant",
      "properties": {
        "value": 3,
        "unit": "kW"
      }
    },
    "c_cap": {
      "typeId": "control.constant",
      "properties": {
        "value": 1.5,
        "unit": "kJ/K"
      }
    },
    "c_ua": {
      "typeId": "control.constant",
      "properties": {
        "value": 2.5,
        "unit": "W/K"
      }
    },
    "c_tamb": {
      "typeId": "control.constant",
      "properties": {
        "value": 25,
        "unit": "°C"
      }
    },
    "c_tau": {
      "typeId": "control.constant",
      "properties": {
        "value": 20,
        "unit": "s"
      }
    },
    "c_type": {
      "typeId": "control.constant",
      "properties": {
        "value": 3,
        "unit": "",
        "options": "0=B;1=E;2=J;3=K;4=N;5=R;6=S;7=T"
      }
    },
    "c_lead": {
      "typeId": "control.constant",
      "properties": {
        "value": 2.5,
        "unit": "Ω"
      }
    },
    "c_dev": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "°C"
      }
    },
    "c_cable": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Extensão/compensação (correto);1=Cobre comum (erro)"
      }
    },
    "c_thead": {
      "typeId": "control.constant",
      "properties": {
        "value": 60,
        "unit": "°C"
      }
    },
    "c_reverse": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Não;1=Sim (+ e − trocados)"
      }
    },
    "c_broken": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Não;1=Sim (circuito aberto)"
      }
    }
  },
  "subcircuits.process.first_order_lab": {
    "c_u": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": ""
      }
    },
    "fo": {
      "typeId": "control.first_order",
      "properties": {
        "gain": 2,
        "tau": 5,
        "initial": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.process.fopdt": {
    "plant": {
      "typeId": "control.process",
      "properties": {
        "gain": 1,
        "tau1": 1,
        "tau2": 0,
        "deadTime": 0.1,
        "hysteresis": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.process.heated_tank_pt100": {
    "c_volume": {
      "typeId": "control.constant",
      "properties": {
        "value": 10,
        "unit": "L"
      }
    },
    "c_pmax": {
      "typeId": "control.constant",
      "properties": {
        "value": 6,
        "unit": "kW"
      }
    },
    "c_ua": {
      "typeId": "control.constant",
      "properties": {
        "value": 80,
        "unit": "W/K"
      }
    },
    "c_tamb": {
      "typeId": "control.constant",
      "properties": {
        "value": 25,
        "unit": "°C"
      }
    },
    "c_tau": {
      "typeId": "control.constant",
      "properties": {
        "value": 15,
        "unit": "s"
      }
    },
    "c_r0": {
      "typeId": "control.constant",
      "properties": {
        "value": 100,
        "unit": "Ω"
      }
    },
    "c_lead": {
      "typeId": "control.constant",
      "properties": {
        "value": 0.5,
        "unit": "Ω"
      }
    },
    "c_dev": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "°C"
      }
    },
    "c_broken": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Não;1=Sim (circuito aberto)"
      }
    }
  },
  "subcircuits.process.hydraulic_tank": {
    "c_qin": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "L/s"
      }
    },
    "c_qout": {
      "typeId": "control.constant",
      "properties": {
        "value": 0.4,
        "unit": "L/s"
      }
    },
    "c_area": {
      "typeId": "control.constant",
      "properties": {
        "value": 0.1,
        "unit": "m²"
      }
    },
    "c_hmax": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "m"
      }
    },
    "c_k": {
      "typeId": "control.constant",
      "properties": {
        "value": 2,
        "unit": "L/(s·m)"
      }
    },
    "c_torr": {
      "typeId": "control.constant",
      "properties": {
        "value": 1.4,
        "unit": "L/(s·√m)"
      }
    },
    "c_outlet": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": ""
      }
    }
  },
  "subcircuits.process.orifice_flow_dp": {
    "c_D": {
      "typeId": "control.constant",
      "properties": {
        "value": 52.5,
        "unit": "mm"
      }
    },
    "c_d": {
      "typeId": "control.constant",
      "properties": {
        "value": 31.5,
        "unit": "mm"
      }
    },
    "c_tap": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "",
        "options": "1=Flange (25,4 mm da placa);2=D e D/2 (radius taps);3=Canto (corner taps)"
      }
    },
    "c_lup": {
      "typeId": "control.constant",
      "properties": {
        "value": 44,
        "unit": "D"
      }
    },
    "c_ldn": {
      "typeId": "control.constant",
      "properties": {
        "value": 8,
        "unit": "D"
      }
    },
    "c_pipe_mat": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "",
        "options": "1=Aço carbono;2=Aço inox AISI 316;3=Ferro fundido;4=Aço galvanizado;5=Cobre;6=PVC"
      }
    },
    "c_plate_mat": {
      "typeId": "control.constant",
      "properties": {
        "value": 2,
        "unit": "",
        "options": "1=Aço carbono;2=Aço inox AISI 316;3=Ferro fundido;4=Aço galvanizado;5=Cobre;6=PVC"
      }
    },
    "c_T": {
      "typeId": "control.constant",
      "properties": {
        "value": 20,
        "unit": "°C"
      }
    },
    "c_fluid": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "",
        "options": "0=Líquido (ε = 1);1=Gás (ε pela ISO 5167-2)"
      }
    },
    "c_rho": {
      "typeId": "control.constant",
      "properties": {
        "value": 998.2,
        "unit": "kg/m³"
      }
    },
    "c_mu": {
      "typeId": "control.constant",
      "properties": {
        "value": 1.002,
        "unit": "cP"
      }
    },
    "c_kappa": {
      "typeId": "control.constant",
      "properties": {
        "value": 1.4,
        "unit": ""
      }
    },
    "c_p1": {
      "typeId": "control.constant",
      "properties": {
        "value": 200,
        "unit": "kPa"
      }
    },
    "c_qmax": {
      "typeId": "control.constant",
      "properties": {
        "value": 15,
        "unit": "m³/h"
      }
    },
    "c_inst": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "",
        "options": "0=Não aplicar;1=Aplicar"
      }
    }
  },
  "subcircuits.process.pressurized_tank_dp": {
    "c_height": {
      "typeId": "control.constant",
      "properties": {
        "value": 3,
        "unit": "m"
      }
    },
    "c_diameter": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": "m"
      }
    },
    "c_sg_process": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": ""
      }
    },
    "c_sg_seal": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": ""
      }
    },
    "c_sg_capillary": {
      "typeId": "control.constant",
      "properties": {
        "value": 1,
        "unit": ""
      }
    },
    "c_capillary": {
      "typeId": "control.constant",
      "properties": {
        "value": 0.2,
        "unit": "m"
      }
    },
    "c_gas": {
      "typeId": "control.constant",
      "properties": {
        "value": 50,
        "unit": "kPa"
      }
    },
    "c_qin_max": {
      "typeId": "control.constant",
      "properties": {
        "value": 36,
        "unit": "m³/h"
      }
    },
    "c_qout_max": {
      "typeId": "control.constant",
      "properties": {
        "value": 36,
        "unit": "m³/h"
      }
    }
  },
  "subcircuits.process.sensor_4_20": {
    "c_p": {
      "typeId": "control.constant",
      "properties": {
        "value": 100,
        "unit": "kPa"
      }
    },
    "c_pmin": {
      "typeId": "control.constant",
      "properties": {
        "value": 0,
        "unit": "kPa"
      }
    },
    "c_pmax": {
      "typeId": "control.constant",
      "properties": {
        "value": 200,
        "unit": "kPa"
      }
    }
  },
  "subcircuits.tdps.basic_flow_loop": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.1,
        "tau2": 0.8,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 1.2,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0.5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.boiler": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.5,
        "ti": 3,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.2,
        "ti": 68,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": true,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-04": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.13,
        "ti": 2.21,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-05": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.4,
        "ti": 2.1895,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-06": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.3531,
        "ti": 16,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-07": {
      "typeId": "control.pid",
      "properties": {
        "kc": 8,
        "ti": 8.5568,
        "td": 1.1475,
        "bias": 50,
        "derivativeFilter": 0.000001,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-08": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": false,
        "samplePeriodNs": 10000000
      }
    },
    "pid-09": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": false,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1,
        "tau2": 1,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 0.94,
        "valveType": 0,
        "stiction": 0.6,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 2,
        "gain": 0.05,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 1,
        "transferFunctionType": 2,
        "lead": 3,
        "lag": 2,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0.4,
        "deadTime": 0.1,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 0.4,
        "lag": 0.8,
        "samplePeriodNs": 10000000
      }
    },
    "process-26": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 4,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 50,
        "lag": 1,
        "samplePeriodNs": 10000000
      }
    },
    "process-27": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 1.5,
        "saturationEnabled": false,
        "hysteresis": 0.4,
        "deadTime": 0.3,
        "gain": 0.92,
        "valveType": 0,
        "stiction": 2.5,
        "rateLimiter": 0,
        "actuatorTau": 1,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-28": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.16,
        "tau2": 1.3,
        "saturationEnabled": false,
        "hysteresis": 1.3,
        "deadTime": 0.6,
        "gain": 1.11,
        "valveType": 0,
        "stiction": 0.4,
        "rateLimiter": 0,
        "actuatorTau": 0.5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-29": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 3,
        "gain": 0.92,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-30": {
      "typeId": "control.process",
      "properties": {
        "tau1": 8,
        "tau2": 5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 3,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-31": {
      "typeId": "control.process",
      "properties": {
        "tau1": 5,
        "tau2": 4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 4,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-32": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-33": {
      "typeId": "control.process",
      "properties": {
        "tau1": 4,
        "tau2": 2,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1,
        "gain": 0.3,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-34": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 2,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 3,
        "gain": 1.2,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-36": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 8,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 3,
        "lag": 2,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.combustion_cross_limits": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": false,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.5,
        "ti": 1.5,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 7,
        "tau2": 4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0.93,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2.5,
        "tau2": 0.5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1.2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.5,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 13,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.combustion_dynamic_cross_limits": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": false,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.5,
        "ti": 1.5,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 7,
        "tau2": 4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0.93,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2.5,
        "tau2": 0.5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1.2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.5,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 13,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.combustion_ratio": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": false,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.5,
        "ti": 1.5,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 7,
        "tau2": 4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0.93,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2.5,
        "tau2": 0.5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1.2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.5,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 13,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.combustion_two_fuels": {
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 2,
        "ti": 2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 2,
        "ti": 2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-04": {
      "typeId": "control.pid",
      "properties": {
        "kc": 2,
        "ti": 2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.cooling_plant": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.25,
        "ti": 1,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.2,
        "ti": 80,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-04": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.5,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0.6,
        "gain": 0.0667,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 1,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0.4,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.1,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 5,
        "tau2": 7,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 4,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 3,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-26": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.3,
        "gain": 1,
        "valveType": 0,
        "stiction": 0.5,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-27": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.6,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 10,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-28": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 1,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-29": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-30": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-31": {
      "typeId": "control.process",
      "properties": {
        "tau1": 6,
        "tau2": 2,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-32": {
      "typeId": "control.process",
      "properties": {
        "tau1": 15,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-33": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 4,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-34": {
      "typeId": "control.process",
      "properties": {
        "tau1": 5,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.course_fine_flow_loop": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 13,
        "ti": 1.95,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.0565,
        "ti": 4.7,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 5,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 1.2,
        "deadTime": 2,
        "gain": 0.9,
        "valveType": 0,
        "stiction": 1.6,
        "rateLimiter": 0,
        "actuatorTau": 2,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 0.1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0.5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.ethane_plant": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 3.6782,
        "ti": 47.2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 2.5204,
        "ti": 18.2397,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.8921,
        "ti": 1.646,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-04": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.7757,
        "ti": 0.4111,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-05": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.3588,
        "ti": 384.4,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-06": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.3864,
        "ti": 3.0274,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 7,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.2,
        "tau2": 0.5,
        "saturationEnabled": false,
        "hysteresis": 1,
        "deadTime": 0.3,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0.5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 5,
        "saturationEnabled": false,
        "hysteresis": 0.7,
        "deadTime": 2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0.5,
        "rateLimiter": 0,
        "actuatorTau": 5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 8,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 1,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 4,
        "lag": 2,
        "samplePeriodNs": 10000000
      }
    },
    "process-26": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0.4,
        "deadTime": 0.4,
        "gain": 1.1,
        "valveType": 0,
        "stiction": 10,
        "rateLimiter": 0,
        "actuatorTau": 0.2,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-27": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0.02,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-28": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0.3,
        "tau2": 0.2,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.1,
        "gain": 0.8,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-29": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2.5,
        "tau2": 1,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.3,
        "gain": 1.1,
        "valveType": 0,
        "stiction": 1.3,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-30": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 0.03,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 2,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-31": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 5,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-32": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 4,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-33": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.8,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 2.2,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-34": {
      "typeId": "control.process",
      "properties": {
        "tau1": 8,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 4,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-37": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.6,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-38": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 3,
        "gain": -1.8,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 13.5,
        "lag": 7,
        "samplePeriodNs": 10000000
      }
    },
    "process-39": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 2.9,
        "gain": -1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 13.5,
        "lag": 19.16,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.four_linear_processes": {
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.7,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 0.93,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 7,
        "tau2": 4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 2,
        "gain": 1.07,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0.41,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 1,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 0.05,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0.7,
        "tau2": 0.1,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 3,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 1,
        "lag": 0.1,
        "samplePeriodNs": 10000000
      }
    },
    "process-26": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.frequency_response": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": false,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0.5,
        "tau2": 0.2,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0.5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.furnace": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.2,
        "ti": 20,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.8,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.3,
        "gain": 0.93,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 2.5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 1.3,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 4,
        "tau2": 5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 3,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.furnace_master_slave": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 1,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.8,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.3,
        "gain": 0.93,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 2.5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 1.3,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 4,
        "tau2": 5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 3,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.header_pressure_three_consumers": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 2.5,
        "ti": 1,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 30,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.5,
        "ti": 1.2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.6,
        "ti": 1.6,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.6,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1,
        "tau2": 1,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.6,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 100,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-26": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0.1,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.heat_exchanger": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.593,
        "ti": 9.6956,
        "td": 1.3976,
        "bias": 50,
        "derivativeFilter": 0.000001,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 8,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 2,
        "gain": 0.65,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.7,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 1.22,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 7,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-26": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 3.13,
        "gain": -1.25,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 3,
        "lag": 8.53,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.industrial_boiler": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.5,
        "ti": 3,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.2,
        "ti": 68,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": true,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 2,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-04": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.13,
        "ti": 2.21,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-05": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.4,
        "ti": 2.1895,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-06": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.3531,
        "ti": 16,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-07": {
      "typeId": "control.pid",
      "properties": {
        "kc": 8,
        "ti": 8.5568,
        "td": 1.1475,
        "bias": 50,
        "derivativeFilter": 0.000001,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-08": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": false,
        "samplePeriodNs": 10000000
      }
    },
    "pid-09": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": false,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1,
        "tau2": 1,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 0.94,
        "valveType": 0,
        "stiction": 0.6,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 2,
        "gain": 0.05,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 1,
        "transferFunctionType": 2,
        "lead": 3,
        "lag": 2,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0.4,
        "deadTime": 0.1,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 0.4,
        "lag": 0.8,
        "samplePeriodNs": 10000000
      }
    },
    "process-26": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 4,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 50,
        "lag": 1,
        "samplePeriodNs": 10000000
      }
    },
    "process-27": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 1.5,
        "saturationEnabled": false,
        "hysteresis": 0.4,
        "deadTime": 0.3,
        "gain": 0.92,
        "valveType": 0,
        "stiction": 2.5,
        "rateLimiter": 0,
        "actuatorTau": 1,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-28": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.16,
        "tau2": 1.3,
        "saturationEnabled": false,
        "hysteresis": 1.3,
        "deadTime": 0.6,
        "gain": 1.11,
        "valveType": 0,
        "stiction": 0.4,
        "rateLimiter": 0,
        "actuatorTau": 0.5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-29": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 3,
        "gain": 0.92,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-30": {
      "typeId": "control.process",
      "properties": {
        "tau1": 8,
        "tau2": 5,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 3,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-31": {
      "typeId": "control.process",
      "properties": {
        "tau1": 5,
        "tau2": 4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 4,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-32": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-33": {
      "typeId": "control.process",
      "properties": {
        "tau1": 4,
        "tau2": 2,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1,
        "gain": 0.3,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-34": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 2,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 3,
        "gain": 1.2,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-36": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 8,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 3,
        "lag": 2,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.linearized_ph": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.25,
        "ti": 8.4335,
        "td": 2.1084,
        "bias": 50,
        "derivativeFilter": 0.5,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3.7,
        "tau2": 4.2,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1.6,
        "gain": 0.8,
        "valveType": 1,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.6,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 18,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 5,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.nonlinear_flow_processes": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-04": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 0.85,
        "valveType": 0,
        "stiction": 3.5,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 4,
        "deadTime": 0.5,
        "gain": 0.85,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 0.85,
        "valveType": 2,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.5,
        "gain": 0.85,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 1,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.ph_control": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.25,
        "ti": 8.4335,
        "td": 2.1084,
        "bias": 50,
        "derivativeFilter": 0.5,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3.7,
        "tau2": 4.2,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1.6,
        "gain": 0.8,
        "valveType": 1,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.6,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 18,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 5,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.reactor": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.6664,
        "ti": 50.4,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 2.0812,
        "ti": 4.6572,
        "td": 0.2754,
        "bias": 50,
        "derivativeFilter": 0.000001,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-03": {
      "typeId": "control.pid",
      "properties": {
        "kc": 2.4983,
        "ti": 2.1333,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-04": {
      "typeId": "control.pid",
      "properties": {
        "kc": 2.9491,
        "ti": 2.1525,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 5,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0.3,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0.2,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 3,
        "lag": 1,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 2,
        "gain": 0.05,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 2,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 3,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.3,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-26": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2.3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.2,
        "gain": 0.92,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 2,
        "actuatorTau": 0.2,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-27": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 3.88,
        "gain": 3.85,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 2,
        "lead": 4.28,
        "lag": 3.01,
        "samplePeriodNs": 10000000
      }
    },
    "process-28": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 1.6,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 2.2,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-29": {
      "typeId": "control.process",
      "properties": {
        "tau1": 2.3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.regulatory_level": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 10,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.7,
        "tau2": 0.4,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 1.23,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 0.08,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0.8,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-25": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.smith_predictor": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1,
        "ti": 3,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 12,
        "gain": 1.15,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1.15,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 12,
        "gain": 1,
        "valveType": -1,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 0,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.split_range": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 3,
        "ti": 11.0189,
        "td": 2.4456,
        "bias": 50,
        "derivativeFilter": 0.000001,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 10,
        "tau2": 0,
        "saturationEnabled": true,
        "hysteresis": 0,
        "deadTime": 1.5,
        "gain": 0.04,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 2,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  },
  "subcircuits.tdps.surge_tank": {
    "pid-01": {
      "typeId": "control.pid",
      "properties": {
        "kc": 0.95,
        "ti": 6.72,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": 1,
        "derivativeOnPv": true,
        "remoteSpEnabled": true,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "pid-02": {
      "typeId": "control.pid",
      "properties": {
        "kc": 1.645,
        "ti": 30.4,
        "td": 0,
        "bias": 50,
        "derivativeFilter": 0.1,
        "outputMin": 0,
        "outputMax": 100,
        "action": -1,
        "derivativeOnPv": false,
        "remoteSpEnabled": false,
        "feedForwardEnabled": false,
        "autoMode": true,
        "samplePeriodNs": 10000000
      }
    },
    "process-21": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 3,
        "deadTime": 2,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 5,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-22": {
      "typeId": "control.process",
      "properties": {
        "tau1": 3,
        "tau2": 3,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 1,
        "gain": 0.078,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 1,
        "transferFunctionType": 3,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-23": {
      "typeId": "control.process",
      "properties": {
        "tau1": 1.1,
        "tau2": 0,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0.4,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 0,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    },
    "process-24": {
      "typeId": "control.process",
      "properties": {
        "tau1": 37,
        "tau2": 23,
        "saturationEnabled": false,
        "hysteresis": 0,
        "deadTime": 0,
        "gain": 1,
        "valveType": 0,
        "stiction": 0,
        "rateLimiter": 0,
        "actuatorTau": 33,
        "transferFunctionType": 0,
        "lead": 0,
        "lag": 0,
        "samplePeriodNs": 10000000
      }
    }
  }
};
