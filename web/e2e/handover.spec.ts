import { expect, type Locator, type Page, test } from '@playwright/test';

const SLOT_A = 'bend-terminal.handover.slot-a';
const SLOT_B = 'bend-terminal.handover.slot-b';
const POINTER = 'bend-terminal.handover.active';
const KEYS = [SLOT_A, SLOT_B, POINTER] as const;

type Draft = {
  shift: string;
  equipmentObservations: string;
  handledItems: string;
  todos: string;
};

async function clearHandoverStorage(page: Page) {
  await page.goto('/');
  await page.evaluate((keys) => {
    for (const key of keys) window.localStorage.removeItem(key);
  }, KEYS);
}

async function openHandover(page: Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: '班次交接草稿' }).click();
  await expect(page.getByTestId('handover-panel')).toBeVisible();
}

function draftField(page: Page, label: string): Locator {
  return page.getByRole('textbox', { name: label, exact: true });
}

async function fillDraft(page: Page, draft: Draft) {
  await draftField(page, '班次').fill(draft.shift);
  await draftField(page, '设备现象').fill(draft.equipmentObservations);
  await draftField(page, '已处置事项').fill(draft.handledItems);
  await draftField(page, '待办').fill(draft.todos);
}

async function expectDraft(page: Page, draft: Draft) {
  await expect(draftField(page, '班次')).toHaveValue(draft.shift);
  await expect(draftField(page, '设备现象')).toHaveValue(
    draft.equipmentObservations,
  );
  await expect(draftField(page, '已处置事项')).toHaveValue(draft.handledItems);
  await expect(draftField(page, '待办')).toHaveValue(draft.todos);
}

function envelope(generation: number, draft: Draft) {
  return {
    formatVersion: 1,
    generation,
    savedAt: `2026-09-15T0${Math.min(generation, 9)}:00:00.000Z`,
    draft,
  };
}

async function seedStorage(page: Page, values: Record<string, unknown>) {
  await page.goto('/');
  await page.evaluate(
    (entries) => {
      for (const [key, value] of entries) {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    },
    Object.entries(values),
  );
}

test.describe('班次交接草稿', () => {
  test.beforeEach(async ({ page }) => {
    await clearHandoverStorage(page);
  });

  test('连续编辑、刷新后直接恢复最近确认写入内容，并在双槽间轮转', async ({
    page,
  }) => {
    await openHandover(page);
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'blank',
    );

    await fillDraft(page, {
      shift: '夜班',
      equipmentObservations: '2 号机背尺偶发偏差',
      handledItems: '已暂停首件并复检',
      todos: '机修确认后再生产',
    });
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'saved',
    );

    await draftField(page, '待办').fill('机修确认后再生产；明早复核角度');
    await page.reload();
    await page.getByRole('tab', { name: '班次交接草稿' }).click();
    await expectDraft(page, {
      shift: '夜班',
      equipmentObservations: '2 号机背尺偶发偏差',
      handledItems: '已暂停首件并复检',
      todos: '机修确认后再生产；明早复核角度',
    });

    const storage = await page.evaluate(() => ({
      a: window.localStorage.getItem('bend-terminal.handover.slot-a'),
      b: window.localStorage.getItem('bend-terminal.handover.slot-b'),
      pointer: window.localStorage.getItem('bend-terminal.handover.active'),
    }));
    expect(storage.a).not.toBeNull();
    expect(storage.b).not.toBeNull();
    expect(storage.pointer).toContain('"slot"');
  });

  test('切槽中断或活动槽损坏时，启动回退到最高有效代次', async ({ page }) => {
    const fallback: Draft = {
      shift: '早班',
      equipmentObservations: '活动槽损坏后的备份现象',
      handledItems: '备份已处置',
      todos: '备份待办',
    };
    await seedStorage(page, {
      [SLOT_A]: envelope(8, fallback),
      [SLOT_B]: '{broken-active-slot',
      [POINTER]: { formatVersion: 1, slot: 'B' },
    });

    await openHandover(page);
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'saved',
    );
    await expectDraft(page, fallback);

    // 指针缺失时同样扫描 A/B，两个槽中取最高有效代次。
    await page.evaluate(() =>
      window.localStorage.removeItem('bend-terminal.handover.active'),
    );
    await page.reload();
    await page.getByRole('tab', { name: '班次交接草稿' }).click();
    await expectDraft(page, fallback);
  });

  test('未知格式版本不会覆盖旧槽；存在已知快照时仍能恢复', async ({ page }) => {
    const known: Draft = {
      shift: '中班',
      equipmentObservations: '已知版本现象',
      handledItems: '已知版本处置',
      todos: '已知版本待办',
    };
    const unknown = { formatVersion: 999, generation: 99, draft: { x: 'future' } };
    await seedStorage(page, {
      [SLOT_A]: envelope(4, known),
      [SLOT_B]: unknown,
      [POINTER]: { formatVersion: 1, slot: 'A' },
    });

    await openHandover(page);
    await expectDraft(page, known);
    await draftField(page, '待办').fill('尝试写入时不得覆盖未知槽');
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'unsaved',
    );
    await expect(page.getByTestId('handover-status')).toContainText(
      '本次内容尚未保存',
    );

    const slotB = await page.evaluate(() =>
      window.localStorage.getItem('bend-terminal.handover.slot-b'),
    );
    expect(JSON.parse(slotB!)).toEqual(unknown);
  });

  test('两个槽都是未知格式时提示恢复失败，且输入不会覆盖原槽', async ({
    page,
  }) => {
    const unknownA = { formatVersion: 999, draft: { x: 'future-a' } };
    const unknownB = { formatVersion: 1000, draft: { x: 'future-b' } };
    await seedStorage(page, {
      [SLOT_A]: unknownA,
      [SLOT_B]: unknownB,
    });

    await openHandover(page);
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'restore-failed',
    );
    await expect(page.getByTestId('handover-status')).toContainText(
      '无法识别的草稿格式版本',
    );

    await draftField(page, '班次').fill('尝试输入');
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'unsaved',
    );
    const values = await page.evaluate(() => ({
      a: window.localStorage.getItem('bend-terminal.handover.slot-a'),
      b: window.localStorage.getItem('bend-terminal.handover.slot-b'),
    }));
    expect(JSON.parse(values.a!)).toEqual(unknownA);
    expect(JSON.parse(values.b!)).toEqual(unknownB);
  });

  test('浏览器拒绝写入时保留屏幕输入和旧快照，并持续提示未保存', async ({
    page,
  }) => {
    const oldDraft: Draft = {
      shift: '旧班次',
      equipmentObservations: '旧现象',
      handledItems: '旧处置',
      todos: '旧待办',
    };
    await seedStorage(page, {
      [SLOT_A]: envelope(2, oldDraft),
      [POINTER]: { formatVersion: 1, slot: 'A' },
    });

    await page.addInitScript(() => {
      const original = window.localStorage.setItem.bind(window.localStorage);
      window.localStorage.setItem = (key: string, value: string) => {
        if (key.startsWith('bend-terminal.handover.')) {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        return original(key, value);
      };
    });
    await page.reload();
    await page.getByRole('tab', { name: '班次交接草稿' }).click();

    await draftField(page, '班次').fill('新班次尚未保存');
    await expect(draftField(page, '班次')).toHaveValue('新班次尚未保存');
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'unsaved',
    );
    await expect(page.getByTestId('handover-status')).toContainText(
      '本次内容尚未保存',
    );

    await page.reload();
    await page.getByRole('tab', { name: '班次交接草稿' }).click();
    await expect(draftField(page, '班次')).toHaveValue('旧班次');
  });

  test('一键清空后重载为空白，且展开复核、来料抽检和换模作业牌不被草稿读写', async ({
    page,
  }) => {
    const apiRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/')) {
        apiRequests.push(`${request.method()} ${request.url()}`);
      }
    });

    await openHandover(page);
    await fillDraft(page, {
      shift: '交接完成前',
      equipmentObservations: '现象',
      handledItems: '处置',
      todos: '待办',
    });
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'saved',
    );

    await page.getByTestId('handover-clear').click();
    await expect(draftField(page, '班次')).toHaveValue('');
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'blank',
    );
    await page.reload();
    await page.getByRole('tab', { name: '班次交接草稿' }).click();
    await expect(draftField(page, '班次')).toHaveValue('');
    await expect(page.getByTestId('handover-status')).toHaveAttribute(
      'data-status',
      'blank',
    );

    const handoverKeysOnly = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith('bend-terminal.'),
      ),
    );
    expect(handoverKeysOnly.sort()).toEqual([...KEYS].sort());
    const handoverApiRequests = apiRequests.filter((request) =>
      request.includes('handover'),
    );
    expect(handoverApiRequests).toEqual([]);

    // 切到其他页面，其输入/服务端状态仍由各自模块负责，草稿键名不承载这些数据。
    await page.getByRole('tab', { name: '展开复核' }).click();
    await page.getByLabel(/直段 L1/).fill('123');
    await page.getByRole('tab', { name: '班次交接草稿' }).click();
    expect(
      await page.evaluate((slotKey) => window.localStorage.getItem(slotKey), SLOT_A),
    ).toContain('"shift":""');

    await page.getByRole('tab', { name: '来料抽检' }).click();
    await expect(page.getByLabel(/批次号/)).toHaveValue('');
    await page.getByRole('tab', { name: '换模作业牌' }).click();
    await expect(page.getByTestId('board-panel')).toBeVisible();
    await expect(page.getByTestId('board-revision')).toBeVisible();
    expect(apiRequests).toContain('GET http://localhost:5199/api/change-board');
    expect(apiRequests.filter((request) => request.includes('handover'))).toEqual([]);
  });
});
