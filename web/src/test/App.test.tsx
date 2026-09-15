import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { CalcResult } from '../types';

const VALID_RESULT: CalcResult = {
  bend_count: 1,
  segment_count: 2,
  segments: ['100', '50'],
  segments_total: '150',
  bends: [
    {
      index: 1,
      angle: '90',
      thickness: '2',
      inner_radius: '3',
      k_factor: '0.33',
      inner_radius_plus_kt: '3.66',
      allowance: '5.749115',
      allowance_unrounded: '5.749114556069321626386637391',
    },
  ],
  allowances_total: '5.749114556069321626386637391',
  unrounded_total: '155.7491145560693216263866374',
  blank_length: '155.75',
};

function mockFetchOnce(status: number, body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

function mockFetchAlways(status: number, body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('表单结构', () => {
  it('初始为 1 道折弯与 2 个直段输入', () => {
    render(<App />);
    expect(screen.getByTestId('bend-fieldset-0')).toBeInTheDocument();
    expect(screen.queryByTestId('bend-fieldset-1')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/直段 L1/)).toBeInTheDocument();
    expect(screen.getByLabelText(/直段 L2/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/直段 L3/)).not.toBeInTheDocument();
  });

  it('添加折弯后联动增加一个直段，删除后联动减少', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /添加一道折弯/ }));
    expect(screen.getByTestId('bend-fieldset-1')).toBeInTheDocument();
    expect(screen.getByLabelText(/直段 L3/)).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: '删除该道' })[1]);
    expect(screen.queryByTestId('bend-fieldset-1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/直段 L3/)).not.toBeInTheDocument();
  });

  it('仅剩一道折弯时删除按钮不可用', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: '删除该道' })).toBeDisabled();
  });
});

describe('班次交接草稿入口', () => {
  it('复用现有标签导航打开草稿，草稿操作不发起服务端请求', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('tab', { name: '班次交接草稿' }));
    expect(screen.getByTestId('handover-panel')).toBeInTheDocument();
    await user.type(screen.getByLabelText('班次'), '夜班');
    await user.clear(screen.getByLabelText('班次'));
    await user.click(screen.getByTestId('handover-clear'));

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('提交行为', () => {
  it('合法响应渲染逐道代入值、未舍入总长与唯一下料长度', async () => {
    const user = userEvent.setup();
    mockFetchOnce(200, VALID_RESULT);
    render(<App />);
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));

    expect(await screen.findByTestId('blank-length')).toHaveTextContent('155.75');
    expect(screen.getByTestId('unrounded-total')).toHaveTextContent(
      '155.7491145560693216263866374',
    );
    expect(screen.getByTestId('bend-allowance-1')).toHaveTextContent('5.749115');
    expect(screen.getByTestId('bend-rkt-1')).toHaveTextContent('3.66');
    // 下料长度唯一
    expect(screen.getAllByTestId('blank-length')).toHaveLength(1);
  });

  it('提交体包含 n+1 直段与 n 道折弯', async () => {
    const user = userEvent.setup();
    mockFetchOnce(200, VALID_RESULT);
    render(<App />);
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));
    await screen.findByTestId('blank-length');

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.segments).toEqual(['100', '50']);
    expect(sent.bends).toEqual([
      { angle: '90', thickness: '2', inner_radius: '3', k_factor: '0.33' },
    ]);
  });

  it('422 时显示字段级错误，且不清空输入', async () => {
    const user = userEvent.setup();
    mockFetchOnce(422, {
      detail: [
        { field: 'bends.0.angle', message: '必须大于 0', type: 'greater_than' },
      ],
    });
    render(<App />);
    const angleInput = screen.getByLabelText(/角度/);
    await user.clear(angleInput);
    await user.type(angleInput, '0');
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));

    expect(await screen.findByText('必须大于 0')).toBeInTheDocument();
    expect(angleInput).toHaveValue('0');
    expect(screen.queryByTestId('result-panel')).not.toBeInTheDocument();
  });

  it('非法提交后保留上一份有效结果', async () => {
    const user = userEvent.setup();
    mockFetchAlways(200, VALID_RESULT);
    render(<App />);
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));
    expect(await screen.findByTestId('blank-length')).toHaveTextContent('155.75');

    // 第二次提交非法：角度越界
    mockFetchOnce(422, {
      detail: [
        { field: 'bends.0.angle', message: '必须小于 180', type: 'less_than' },
      ],
    });
    const angleInput = screen.getByLabelText(/角度/);
    await user.clear(angleInput);
    await user.type(angleInput, '180');
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));

    expect(await screen.findByText('必须小于 180')).toBeInTheDocument();
    // 上一份有效结果仍然保留
    expect(screen.getByTestId('blank-length')).toHaveTextContent('155.75');
    expect(screen.getByTestId('unrounded-total')).toBeInTheDocument();
  });

  it('再次合法提交后错误被清除并更新结果', async () => {
    const user = userEvent.setup();
    mockFetchOnce(422, {
      detail: [{ field: 'segments.0', message: '必须大于 0', type: 'greater_than' }],
    });
    render(<App />);
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));
    expect(await screen.findByText('必须大于 0')).toBeInTheDocument();

    mockFetchOnce(200, VALID_RESULT);
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));
    expect(await screen.findByTestId('blank-length')).toHaveTextContent('155.75');
    expect(screen.queryByText('必须大于 0')).not.toBeInTheDocument();
  });

  it('网络异常时显示通用错误且不产生结果', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'));
    render(<App />);
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));
    expect(await screen.findByTestId('general-error')).toHaveTextContent(
      '无法连接 API 服务',
    );
    expect(screen.queryByTestId('result-panel')).not.toBeInTheDocument();
  });

  it('直段字段级错误定位到对应输入框', async () => {
    const user = userEvent.setup();
    mockFetchOnce(422, {
      detail: [{ field: 'segments.1', message: '必须大于 0', type: 'greater_than' }],
    });
    render(<App />);
    await user.click(screen.getByRole('button', { name: '计算下料长度' }));
    await waitFor(() => {
      expect(screen.getByLabelText(/直段 L2/)).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByLabelText(/直段 L1/)).not.toHaveAttribute('aria-invalid', 'true');
  });
});
