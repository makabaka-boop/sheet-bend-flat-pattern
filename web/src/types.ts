export interface BendFormState {
  angle: string;
  thickness: string;
  innerRadius: string;
  kFactor: string;
}

export interface FieldError {
  field: string;
  message: string;
  type: string;
}

export interface BendDetail {
  index: number;
  angle: string;
  thickness: string;
  inner_radius: string;
  k_factor: string;
  inner_radius_plus_kt: string;
  allowance: string;
  allowance_unrounded: string;
}

export interface CalcResult {
  bend_count: number;
  segment_count: number;
  segments: string[];
  segments_total: string;
  bends: BendDetail[];
  allowances_total: string;
  unrounded_total: string;
  blank_length: string;
}
