import type { CalcResult, FieldError } from './types';

export type CalcOutcome =
  | { ok: true; data: CalcResult }
  | { ok: false; errors: FieldError[] };

/** 提交展开计算；失败时返回字段级错误，绝不抛出异常。*/
export async function postCalculate(payload: unknown): Promise<CalcOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      errors: [{ field: 'body', message: '无法连接 API 服务', type: 'network' }],
    };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && body) {
    return { ok: true, data: body as CalcResult };
  }
  const detail = (body as { detail?: FieldError[] } | null)?.detail;
  const errors: FieldError[] = Array.isArray(detail)
    ? detail
    : [{ field: 'body', message: `请求失败（HTTP ${res.status}）`, type: 'http' }];
  return { ok: false, errors };
}
