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

/** 单次实测的判定明细（数值为十进制文本）。 */
export interface MeasurementVerdict {
  index: number;
  value: string;
  deviation: string; // 偏差 = 实测值 − 标称板厚（带符号）
  within: boolean;
  direction: 'within' | 'above' | 'below'; // 区间内 / 越上界 / 越下界
}

/** 一批来料的抽检记录（判定与展开结果互不影响）。 */
export interface InspectionRecord {
  batch_no: string;
  material: string;
  nominal: string;
  lower_tolerance: string;
  upper_tolerance: string;
  lower_bound: string; // 合格区间下界（闭区间）
  upper_bound: string; // 合格区间上界（闭区间）
  measurements: MeasurementVerdict[];
  passed: boolean;
  created_at: string;
}

/** 换模作业牌快照：页面始终以服务端快照渲染卡片。 */
export interface BoardSnapshot {
  state: 'free' | 'occupied';
  revision: number; // 递增修订号：每次成功的认领/归还 +1
  holder: string | null;
  die_description: string | null;
  claimed_at: string | null;
}

/** 班次交接草稿：只保存在当前浏览器，不进入服务端。 */
export interface ShiftHandoverDraft {
  shift: string;
  equipmentObservations: string;
  handledItems: string;
  todos: string;
}
