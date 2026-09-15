import type { BoardSnapshot, CalcResult, FieldError, InspectionRecord } from './types';

export type Outcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      errors: FieldError[];
      // 412 裁决失败（认领竞争 / 归还冲突）时携带的服务端胜出快照
      snapshot?: BoardSnapshot;
    };

export type CalcOutcome = Outcome<CalcResult>;
export type InspectionOutcome = Outcome<InspectionRecord>;
export type InspectionListOutcome = Outcome<InspectionRecord[]>;
export type BoardOutcome = Outcome<BoardSnapshot>;

/** 统一请求封装：失败时返回字段级错误（含 409 批次冲突、412 作业牌冲突），绝不抛出异常。*/
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
  const parsed = body as
    | { detail?: FieldError[]; snapshot?: BoardSnapshot }
    | null;
  const detail = parsed?.detail;
  const errors: FieldError[] = Array.isArray(detail)
    ? detail
    : [{ field: 'body', message: `请求失败（HTTP ${res.status}）`, type: 'http' }];
  return { ok: false, errors, snapshot: parsed?.snapshot ?? undefined };
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

/** 读取换模作业牌状态（空闲/占用与递增修订号）。*/
export async function fetchChangeBoard(): Promise<BoardOutcome> {
  return request('/api/change-board');
}

/** 认领作业牌：提交姓名、模具说明与当前修订号；竞争失败者在 snapshot 中收到胜出者快照。*/
export async function claimChangeBoard(payload: {
  holder: string;
  die_description: string;
  revision: number;
}): Promise<BoardOutcome> {
  return request('/api/change-board/claim', postJson(payload));
}

/** 归还作业牌：归还人必须是当前持有人，且修订号相符。*/
export async function releaseChangeBoard(payload: {
  holder: string;
  revision: number;
}): Promise<BoardOutcome> {
  return request('/api/change-board/release', postJson(payload));
}
