import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { BoardSnapshot } from '../types';

const FREE_REV0: BoardSnapshot = {
  state: 'free',
  revision: 0,
  holder: null,
  die_description: null,
  claimed_at: null,
};

const FREE_REV2: BoardSnapshot = {
  state: 'free',
  revision: 2,
  holder: null,
  die_description: null,
  claimed_at: null,
};

const OCCUPIED_BY_ZHANG: BoardSnapshot = {
  state: 'occupied',
  revision: 1,
  holder: '张三',
  die_description: 'V 模 R3 一套',
  claimed_at: '2026-09-15T01:00:00+00:00',
};

type MockReply = { status: number; body: unknown };

function mockFetchRouter(handler: (url: string, init?: RequestInit) => MockReply) {
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

/** 默认路由：作业牌返回给定快照，其它路径 404。 */
function mockBoardFetch(snapshot: BoardSnapshot) {
  mockFetchRouter((url) =>
    url.includes('/api/change-board')
      ? { status: 200, body: snapshot }
      : { status: 404, body: { detail: [] } },
  );
}

async function openBoardView(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByRole('tab', { name: '换模作业牌' }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('换模作业牌视图', () => {
  it('打开时读取空闲状态与修订号，仅展示认领入口', async () => {
    const user = userEvent.setup();
    mockBoardFetch(FREE_REV0);
    await openBoardView(user);

    expect(await screen.findByTestId('board-state')).toHaveTextContent('空闲');
    expect(screen.getByTestId('board-revision')).toHaveTextContent('修订号 0');
    expect(screen.getByTestId('board-claim')).toBeInTheDocument();
    expect(screen.queryByTestId('board-release')).not.toBeInTheDocument();
    expect(screen.queryByTestId('board-occupied-info')).not.toBeInTheDocument();
  });

  it('占用快照展示当前持有人、模具说明与认领时间，展示归还入口', async () => {
    const user = userEvent.setup();
    mockBoardFetch(OCCUPIED_BY_ZHANG);
    await openBoardView(user);

    expect(await screen.findByTestId('board-state')).toHaveTextContent('占用中');
    expect(screen.getByTestId('board-current-holder')).toHaveTextContent('张三');
    expect(screen.getByTestId('board-current-die')).toHaveTextContent('V 模 R3 一套');
    expect(screen.getByTestId('board-claimed-at')).toHaveTextContent('2026-09-15');
    expect(screen.getByTestId('board-release')).toBeInTheDocument();
    expect(screen.queryByTestId('board-claim')).not.toBeInTheDocument();
    // 占用时模具说明输入禁用（持有人信息以服务端快照为准）
    expect(screen.getByLabelText(/模具说明/)).toBeDisabled();
  });

  it('认领请求携带姓名、模具说明与当前修订号，成功后以服务端快照更新卡片', async () => {
    const user = userEvent.setup();
    const calls: { url: string; init?: RequestInit }[] = [];
    mockFetchRouter((url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/change-board')) {
        // 初始 GET 空闲；成功后刷新性读取也返回占用
        return { status: 200, body: FREE_REV0 };
      }
      if (url.endsWith('/claim')) {
        return { status: 200, body: OCCUPIED_BY_ZHANG };
      }
      return { status: 404, body: { detail: [] } };
    });
    await openBoardView(user);
    await screen.findByTestId('board-state');

    await user.type(screen.getByLabelText(/你的姓名/), '张三');
    await user.type(screen.getByLabelText(/模具说明/), 'V 模 R3 一套');
    await user.click(screen.getByTestId('board-claim'));

    // 卡片立即变为占用，显示持有人
    await waitFor(() =>
      expect(screen.getByTestId('board-state')).toHaveTextContent('占用中'),
    );
    expect(screen.getByTestId('board-current-holder')).toHaveTextContent('张三');
    expect(screen.getByTestId('board-revision')).toHaveTextContent('修订号 1');

    const claimCall = calls.find((c) => c.url.endsWith('/claim'));
    expect(claimCall).toBeDefined();
    expect(JSON.parse((claimCall!.init as RequestInit).body as string)).toEqual({
      holder: '张三',
      die_description: 'V 模 R3 一套',
      revision: 0,
    });
  });

  it('412 同版竞争失败：显示胜出持有人与冲突原因，并保留自己的填写内容', async () => {
    const user = userEvent.setup();
    mockFetchRouter((url, init) => {
      if (url.endsWith('/api/change-board') && !init?.method) {
        return { status: 200, body: FREE_REV0 };
      }
      if (url.endsWith('/claim') && init?.method === 'POST') {
        return {
          status: 412,
          body: {
            detail: [
              {
                field: 'revision',
                message: '作业牌已被他人认领，请等待其归还：当前持有人 张三',
                type: 'already_occupied',
              },
            ],
            snapshot: OCCUPIED_BY_ZHANG,
          },
        };
      }
      return { status: 404, body: { detail: [] } };
    });
    await openBoardView(user);
    await screen.findByTestId('board-state');

    const nameInput = screen.getByLabelText(/你的姓名/);
    const dieInput = screen.getByLabelText(/模具说明/);
    await user.type(nameInput, '李四');
    await user.type(dieInput, 'W 模一套');
    await user.click(screen.getByTestId('board-claim'));

    // 立即显示最新持有人（胜出者快照）
    await waitFor(() =>
      expect(screen.getByTestId('board-current-holder')).toHaveTextContent('张三'),
    );
    expect(screen.getByTestId('board-state')).toHaveTextContent('占用中');
    expect(screen.getByTestId('board-conflict')).toHaveTextContent(/张三/);
    // 失败方自己的填写内容保留
    expect(nameInput).toHaveValue('李四');
    expect(dieInput).toHaveValue('W 模一套');
  });

  it('持有人成功归还：提交当前修订号，卡片转为空闲且修订号推进', async () => {
    const user = userEvent.setup();
    mockFetchRouter((url, init) => {
      if (url.endsWith('/api/change-board') && !init?.method) {
        return { status: 200, body: OCCUPIED_BY_ZHANG };
      }
      if (url.endsWith('/release') && init?.method === 'POST') {
        return { status: 200, body: FREE_REV2 };
      }
      return { status: 404, body: { detail: [] } };
    });
    await openBoardView(user);
    await screen.findByTestId('board-state');

    await user.type(screen.getByLabelText(/你的姓名/), '张三');
    await user.click(screen.getByTestId('board-release'));

    await waitFor(() =>
      expect(screen.getByTestId('board-state')).toHaveTextContent('空闲'),
    );
    expect(screen.getByTestId('board-revision')).toHaveTextContent('修订号 2');
    expect(screen.queryByTestId('board-occupied-info')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-claim')).toBeInTheDocument();
    // 姓名填写保留（归还后下一次交接仍要填）
    expect(screen.getByLabelText(/你的姓名/)).toHaveValue('张三');

    const releaseCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => String(call[0]).endsWith('/release'),
    );
    expect(releaseCall).toBeDefined();
    const body = JSON.parse((releaseCall![1] as RequestInit).body as string);
    expect(body).toEqual({ holder: '张三', revision: 1 });
  });

  it('非持有人归还收到 412：显示持有人不匹配原因，作业牌保持占用', async () => {
    const user = userEvent.setup();
    mockFetchRouter((url, init) => {
      if (url.endsWith('/api/change-board') && !init?.method) {
        return { status: 200, body: OCCUPIED_BY_ZHANG };
      }
      if (url.endsWith('/release') && init?.method === 'POST') {
        return {
          status: 412,
          body: {
            detail: [
              {
                field: 'revision',
                message: '只有当前持牌人才能归还作业牌：当前持有人是 张三',
                type: 'holder_mismatch',
              },
            ],
            snapshot: OCCUPIED_BY_ZHANG,
          },
        };
      }
      return { status: 404, body: { detail: [] } };
    });
    await openBoardView(user);
    await screen.findByTestId('board-state');

    const nameInput = screen.getByLabelText(/你的姓名/);
    await user.type(nameInput, '李四');
    await user.click(screen.getByTestId('board-release'));

    const conflict = await screen.findByTestId('board-conflict');
    expect(conflict).toHaveTextContent(/只有当前持牌人/);
    expect(screen.getByTestId('board-state')).toHaveTextContent('占用中');
    expect(screen.getByTestId('board-current-holder')).toHaveTextContent('张三');
    // 自己的姓名填写保留
    expect(nameInput).toHaveValue('李四');
  });

  it('过期修订号归还收到 412：显示过期原因与最新持有人，填写保留', async () => {
    const user = userEvent.setup();
    const occupiedByLi: BoardSnapshot = {
      ...OCCUPIED_BY_ZHANG,
      holder: '李四',
      revision: 3,
    };
    mockFetchRouter((url, init) => {
      if (url.endsWith('/api/change-board') && !init?.method) {
        return { status: 200, body: OCCUPIED_BY_ZHANG };
      }
      if (url.endsWith('/release') && init?.method === 'POST') {
        return {
          status: 412,
          body: {
            detail: [
              {
                field: 'revision',
                message: '页面状态已过期，作业牌在此期间发生过变化：当前由 李四 持有',
                type: 'revision_stale',
              },
            ],
            snapshot: occupiedByLi,
          },
        };
      }
      return { status: 404, body: { detail: [] } };
    });
    await openBoardView(user);
    await screen.findByTestId('board-state');

    const nameInput = screen.getByLabelText(/你的姓名/);
    await user.type(nameInput, '张三');
    await user.click(screen.getByTestId('board-release'));

    await waitFor(() =>
      expect(screen.getByTestId('board-current-holder')).toHaveTextContent('李四'),
    );
    expect(screen.getByTestId('board-revision')).toHaveTextContent('修订号 3');
    expect(screen.getByTestId('board-conflict')).toHaveTextContent(/已过期/);
    expect(nameInput).toHaveValue('张三');
  });

  it('422 字段校验：错误定位到姓名与模具说明输入框，填写保留', async () => {
    const user = userEvent.setup();
    mockFetchRouter((url, init) => {
      if (url.endsWith('/api/change-board') && !init?.method) {
        return { status: 200, body: FREE_REV0 };
      }
      if (url.endsWith('/claim') && init?.method === 'POST') {
        return {
          status: 422,
          body: {
            detail: [
              { field: 'holder', message: '不能为空', type: 'string_too_short' },
              {
                field: 'die_description',
                message: '不能为空',
                type: 'string_too_short',
              },
            ],
          },
        };
      }
      return { status: 404, body: { detail: [] } };
    });
    await openBoardView(user);
    await screen.findByTestId('board-state');

    await user.type(screen.getByLabelText(/模具说明/), '   ');
    await user.click(screen.getByTestId('board-claim'));

    const holderInput = screen.getByLabelText(/你的姓名/);
    await waitFor(() =>
      expect(holderInput).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByLabelText(/模具说明/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // 状态仍为空闲（快照未被替换）
    expect(screen.getByTestId('board-state')).toHaveTextContent('空闲');
  });

  it('网络异常时显示错误但不影响表单与视图切换', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
    await openBoardView(user);
    expect(await screen.findByTestId('board-load-error')).toHaveTextContent(
      '无法连接 API 服务',
    );
    // 表单仍可填写；缺少快照时动作按钮禁用，刷新状态可重新拉取
    expect(screen.getByLabelText(/你的姓名/)).toBeInTheDocument();
    expect(screen.getByLabelText(/模具说明/)).toBeInTheDocument();
    expect(screen.getByTestId('board-claim')).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新状态' })).toBeEnabled();

    // 刷新恢复后按钮可用
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(FREE_REV0),
    } as Response);
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() =>
      expect(screen.getByTestId('board-claim')).toBeEnabled(),
    );
    expect(screen.queryByTestId('board-load-error')).not.toBeInTheDocument();
  });

  it('作业牌与展开复核、来料抽检为彼此独立的视图', async () => {
    const user = userEvent.setup();
    mockBoardFetch(FREE_REV0);
    render(<App />);
    // 默认在展开复核：没有作业牌卡片，也不请求作业牌
    expect(screen.getByRole('button', { name: '计算下料长度' })).toBeInTheDocument();
    expect(screen.queryByTestId('board-panel')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '换模作业牌' }));
    expect(await screen.findByTestId('board-panel')).toBeInTheDocument();
    // 抽检表单不出现在作业牌视图
    expect(screen.queryByLabelText(/批次号/)).not.toBeInTheDocument();
  });
});
