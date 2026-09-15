import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HandoverPanel from '../components/HandoverPanel';
import {
  createHandoverDraftStore,
  HANDOVER_STORAGE_KEYS,
} from '../lib/handoverDraftStore';

function seedDraft(values: Parameters<ReturnType<typeof createHandoverDraftStore>['save']>[0]) {
  createHandoverDraftStore(localStorage).save(values);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('班次交接草稿面板', () => {
  it('首次打开为空白状态，并提供班次、现象、已处置和待办字段', () => {
    render(<HandoverPanel />);
    expect(screen.getByTestId('handover-status')).toHaveAttribute('data-status', 'blank');
    expect(screen.getByLabelText('班次')).toHaveValue('');
    expect(screen.getByLabelText('设备现象')).toHaveValue('');
    expect(screen.getByLabelText('已处置事项')).toHaveValue('');
    expect(screen.getByLabelText('待办')).toHaveValue('');
  });

  it('输入后自动保存，重新挂载时直接恢复最近确认写入的内容', async () => {
    const user = userEvent.setup();
    const view = render(<HandoverPanel />);
    await user.type(screen.getByLabelText('班次'), '夜班');
    await user.type(screen.getByLabelText('设备现象'), '2 号机偶尔有异响');
    await user.type(screen.getByLabelText('已处置事项'), '已暂停并通知机修');
    await user.type(screen.getByLabelText('待办'), '复测后挡板精度');

    expect(screen.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'saved',
    );

    view.unmount();
    render(<HandoverPanel />);
    expect(screen.getByLabelText('班次')).toHaveValue('夜班');
    expect(screen.getByLabelText('设备现象')).toHaveValue('2 号机偶尔有异响');
    expect(screen.getByLabelText('已处置事项')).toHaveValue('已暂停并通知机修');
    expect(screen.getByLabelText('待办')).toHaveValue('复测后挡板精度');
    expect(screen.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'saved',
    );
  });

  it('浏览器拒写时保留屏幕输入，并在表单旁持续提示本次内容尚未保存', async () => {
    seedDraft({
      shift: '早班',
      equipmentObservations: '旧现象',
      handledItems: '旧处置',
      todos: '旧待办',
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if ((HANDOVER_STORAGE_KEYS as readonly string[]).includes(key)) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
    });

    const user = userEvent.setup();
    render(<HandoverPanel />);
    const shift = screen.getByLabelText('班次');
    await user.clear(shift);
    await user.type(shift, '晚班补充');

    expect(shift).toHaveValue('晚班补充');
    expect(screen.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'unsaved',
    );
    expect(screen.getByTestId('handover-status')).toHaveTextContent('本次内容尚未保存');

    const recovered = createHandoverDraftStore(localStorage).load();
    expect(recovered.draft.shift).toBe('早班');
  });

  it('两槽都无法读取时保持空白并提示草稿无法恢复', () => {
    localStorage.setItem(HANDOVER_STORAGE_KEYS[0], 'broken-a');
    localStorage.setItem(HANDOVER_STORAGE_KEYS[1], '{broken-b');
    localStorage.setItem(HANDOVER_STORAGE_KEYS[2], 'broken-pointer');

    render(<HandoverPanel />);
    expect(screen.getByLabelText('班次')).toHaveValue('');
    expect(screen.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'restore-failed',
    );
    expect(screen.getByTestId('handover-status')).toHaveTextContent('无法恢复');
  });

  it('未知格式版本不覆盖原槽，界面提示无法恢复', () => {
    const unknown = JSON.stringify({ formatVersion: 999, draft: {} });
    localStorage.setItem(HANDOVER_STORAGE_KEYS[0], unknown);
    localStorage.setItem(HANDOVER_STORAGE_KEYS[1], unknown);

    render(<HandoverPanel />);
    expect(screen.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'restore-failed',
    );
    expect(localStorage.getItem(HANDOVER_STORAGE_KEYS[0])).toBe(unknown);
    expect(localStorage.getItem(HANDOVER_STORAGE_KEYS[1])).toBe(unknown);
  });

  it('一键清空后重载为空白', async () => {
    const user = userEvent.setup();
    const view = render(<HandoverPanel />);
    await user.type(screen.getByLabelText('班次'), '夜班');
    expect(screen.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'saved',
    );

    await user.click(screen.getByTestId('handover-clear'));
    expect(screen.getByLabelText('班次')).toHaveValue('');
    expect(screen.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'blank',
    );

    view.unmount();
    render(<HandoverPanel />);
    expect(screen.getByLabelText('班次')).toHaveValue('');
    expect(screen.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'blank',
    );
  });
});
