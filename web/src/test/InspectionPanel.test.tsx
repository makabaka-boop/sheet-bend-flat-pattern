import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { InspectionRecord } from '../types';

const PASSED_RECORD: InspectionRecord = {
  batch_no: 'LOT-001',
  material: 'SPCC',
  nominal: '2.0',
  lower_tolerance: '0.05',
  upper_tolerance: '0.05',
  lower_bound: '1.95',
  upper_bound: '2.05',
  measurements: [
    { index: 1, value: '1.98', deviation: '-0.02', within: true, direction: 'within' },
    { index: 2, value: '2.0', deviation: '0.0', within: true, direction: 'within' },
    { index: 3, value: '2.02', deviation: '0.02', within: true, direction: 'within' },
  ],
  passed: true,
  created_at: '2026-09-15T01:00:00+00:00',
};

const FAILED_RECORD: InspectionRecord = {
  ...PASSED_RECORD,
  batch_no: 'LOT-002',
  passed: false,
  measurements: [
    { index: 1, value: '1.90', deviation: '-0.10', within: false, direction: 'below' },
    { index: 2, value: '2.0', deviation: '0.0', within: true, direction: 'within' },
    { index: 3, value: '2.10', deviation: '0.10', within: false, direction: 'above' },
  ],
};

type MockReply = { status: number; body: unknown };

/** 按 URL + 方法路由的 fetch mock；每次调用从队列取一个响应。 */
function mockFetchRouter(
  handler: (url: string, init?: RequestInit) => MockReply,
) {
  (fetch as ReturnType<typeof vi.fn>).mockImplementation(
    (url: unknown, init?: RequestInit) => {
      const { status, body } = handler(String(url), init);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as Response);
    },
  );
}

/** 默认路由：GET recent 返回空列表，其余 404。 */
function mockDefaultFetch(recent: InspectionRecord[] = []) {
  mockFetchRouter((url) =>
    url.includes('/api/inspections/recent')
      ? { status: 200, body: recent }
      : { status: 404, body: { detail: [] } },
  );
}

async function openInspectionView(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByRole('tab', { name: '来料抽检' }));
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/批次号/), 'LOT-001');
  await user.type(screen.getByLabelText(/材料牌号/), 'SPCC');
  await user.type(screen.getByLabelText(/标称板厚/), '2.0');
  await user.type(screen.getByLabelText(/下允许偏差/), '0.05');
  await user.type(screen.getByLabelText(/上允许偏差/), '0.05');
  await user.type(screen.getByLabelText(/实测值 1/), '1.98');
  await user.type(screen.getByLabelText(/实测值 2/), '2.0');
  await user.type(screen.getByLabelText(/实测值 3/), '2.02');
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('来料抽检视图', () => {
  it('默认落在展开复核视图，可切换到来料抽检', async () => {
    const user = userEvent.setup();
    mockDefaultFetch();
    render(<App />);
    // 默认：展开复核表单在，抽检表单不在
    expect(screen.getByRole('button', { name: '计算下料长度' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/批次号/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '来料抽检' }));
    expect(await screen.findByLabelText(/批次号/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '计算下料长度' }),
    ).not.toBeInTheDocument();
    // 初始为 3 次实测输入
    expect(screen.getByLabelText(/实测值 1/)).toBeInTheDocument();
    expect(screen.getByLabelText(/实测值 2/)).toBeInTheDocument();
    expect(screen.getByLabelText(/实测值 3/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/实测值 4/)).not.toBeInTheDocument();
  });

  it('进入视图时加载最近抽检记录并展示判定', async () => {
    const user = userEvent.setup();
    mockDefaultFetch([FAILED_RECORD]);
    await openInspectionView(user);

    expect(
      await screen.findByTestId('inspection-record-LOT-002'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('inspection-verdict-LOT-002')).toHaveTextContent(
      '不合格',
    );
    // 逐项越界方向
    expect(
      screen.getByTestId('inspection-measurement-LOT-002-1'),
    ).toHaveTextContent('越下界');
    expect(
      screen.getByTestId('inspection-measurement-LOT-002-3'),
    ).toHaveTextContent('越上界');
  });

  it('提交体包含批次、标称、上下偏差与实测值，成功后刷新记录', async () => {
    const user = userEvent.setup();
    const calls: { url: string; init?: RequestInit }[] = [];
    mockFetchRouter((url, init) => {
      calls.push({ url, init });
      if (url.includes('/api/inspections/recent')) {
        // 登记完成后再次拉取时返回新记录
        const posted = calls.some((c) => c.url.endsWith('/api/inspections'));
        return { status: 200, body: posted ? [PASSED_RECORD] : [] };
      }
      return { status: 201, body: PASSED_RECORD };
    });
    await openInspectionView(user);
    await screen.findByTestId('inspection-empty');

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: '登记抽检' }));

    // 列表刷新出合格记录
    expect(
      await screen.findByTestId('inspection-record-LOT-001'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('inspection-verdict-LOT-001')).toHaveTextContent(
      '合格',
    );

    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post).toBeDefined();
    const sent = JSON.parse((post!.init as RequestInit).body as string);
    expect(sent).toEqual({
      batch_no: 'LOT-001',
      material: 'SPCC',
      nominal: '2.0',
      lower_tolerance: '0.05',
      upper_tolerance: '0.05',
      measurements: ['1.98', '2.0', '2.02'],
    });
  });

  it('422 校验失败：错误定位到批次号与具体测量项，输入与已加载列表保留', async () => {
    const user = userEvent.setup();
    mockFetchRouter((url, init) => {
      if (url.includes('/api/inspections/recent')) {
        return { status: 200, body: [PASSED_RECORD] };
      }
      if (init?.method === 'POST') {
        return {
          status: 422,
          body: {
            detail: [
              { field: 'batch_no', message: '不能为空', type: 'string_too_short' },
              {
                field: 'measurements.1',
                message: '必须为数字',
                type: 'decimal_parsing',
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });
    await openInspectionView(user);
    // 已加载的列表
    expect(await screen.findByTestId('inspection-record-LOT-001')).toBeInTheDocument();

    await fillValidForm(user);
    await user.clear(screen.getByLabelText(/批次号/));
    await user.clear(screen.getByLabelText(/实测值 2/));
    await user.type(screen.getByLabelText(/实测值 2/), 'abc');
    await user.click(screen.getByRole('button', { name: '登记抽检' }));

    // 错误定位到批次号输入框与第 2 次实测输入框
    const batchInput = screen.getByLabelText(/批次号/);
    const measure2 = screen.getByLabelText(/实测值 2/);
    await waitFor(() => {
      expect(batchInput).toHaveAttribute('aria-invalid', 'true');
      expect(measure2).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByText('不能为空')).toBeInTheDocument();
    expect(screen.getByText('必须为数字')).toBeInTheDocument();
    // 未出错的测量项不标错
    expect(screen.getByLabelText(/实测值 1/)).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // 输入保留
    expect(measure2).toHaveValue('abc');
    expect(screen.getByLabelText(/材料牌号/)).toHaveValue('SPCC');
    // 已加载列表保留
    expect(screen.getByTestId('inspection-record-LOT-001')).toBeInTheDocument();
  });

  it('409 批次冲突：错误定位到批次号，输入与已加载列表保留', async () => {
    const user = userEvent.setup();
    mockFetchRouter((url, init) => {
      if (url.includes('/api/inspections/recent')) {
        return { status: 200, body: [PASSED_RECORD] };
      }
      if (init?.method === 'POST') {
        return {
          status: 409,
          body: {
            detail: [
              {
                field: 'batch_no',
                message: '批次号 LOT-001 已存在，不得重复登记',
                type: 'duplicate_batch',
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });
    await openInspectionView(user);
    expect(await screen.findByTestId('inspection-record-LOT-001')).toBeInTheDocument();

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: '登记抽检' }));

    // 冲突错误展示在批次号输入框旁
    const batchInput = screen.getByLabelText(/批次号/);
    await waitFor(() => {
      expect(batchInput).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByText(/已存在，不得重复登记/)).toBeInTheDocument();
    // 输入保留，便于改批次号后重提
    expect(batchInput).toHaveValue('LOT-001');
    expect(screen.getByLabelText(/实测值 1/)).toHaveValue('1.98');
    // 已加载列表保留
    expect(screen.getByTestId('inspection-record-LOT-001')).toBeInTheDocument();
  });

  it('实测次数可增删，但不少于 3 次', async () => {
    const user = userEvent.setup();
    mockDefaultFetch();
    await openInspectionView(user);

    await user.click(screen.getByRole('button', { name: /添加一次实测/ }));
    expect(screen.getByLabelText(/实测值 4/)).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: '删除该次' })[3]);
    expect(screen.queryByLabelText(/实测值 4/)).not.toBeInTheDocument();
    // 回到 3 次后没有删除按钮
    expect(
      screen.queryByRole('button', { name: '删除该次' }),
    ).not.toBeInTheDocument();
  });

  it('列表加载失败时显示错误但不影响表单', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
    await openInspectionView(user);
    expect(await screen.findByTestId('inspection-list-error')).toHaveTextContent(
      '无法连接 API 服务',
    );
    expect(screen.getByLabelText(/批次号/)).toBeInTheDocument();
  });
});
