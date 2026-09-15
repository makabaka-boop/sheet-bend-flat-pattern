import type { CalcResult, FieldError, InspectionRecord } from './types';

export type Outcome<T> =
  | { ok: true; data: T }
  | { ok: false; errors: FieldError[] };

export type CalcOutcome = Outcome<CalcResult>;
export type InspectionOutcome = Outcome<InspectionRecord>;
export type InspectionListOutcome = Outcome<InspectionRecord[]>;

/** 统一请求封装：失败时返回字段级错误（含 409 批次冲突），绝不抛出异常。*/
async function request<T>(path: string, init?: RequestInit): Promise<Outcome<T>> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    return {
      ok: false,
      errors: [{ field: 'body', message: '无法连接 API 服务', type: 'network' }],
    };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && body !== null) {
    return { ok: true, data: body as T };
  }
  const detail = (body as { detail?: FieldError[] } | null)?.detail;
  const errors: FieldError[] = Array.isArray(detail)
    ? detail
    : [{ field: 'body', message: `请求失败（HTTP ${res.status}）`, type: 'http' }];
  return { ok: false, errors };
}

function postJson(payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

/** 提交展开计算。*/
export async function postCalculate(payload: unknown): Promise<CalcOutcome> {
  return request('/api/calculate', postJson(payload));
}

/** 登记一批来料抽检；批次冲突（409）同样以字段级错误返回。*/
export async function postInspection(
  payload: unknown,
): Promise<InspectionOutcome> {
  return request('/api/inspections', postJson(payload));
}

/** 读取最近登记的抽检记录（新的在前）。*/
export async function fetchRecentInspections(): Promise<InspectionListOutcome> {
  return request('/api/inspections/recent');
}
