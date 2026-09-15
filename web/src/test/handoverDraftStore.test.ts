import { describe, expect, it } from 'vitest';
import {
  createHandoverDraftStore,
  createMemoryStorage,
  EMPTY_HANDOVER_DRAFT,
  HANDOVER_FORMAT_VERSION,
  HANDOVER_STORAGE_KEYS,
  HANDOVER_STORAGE_PREFIX,
} from '../lib/handoverDraftStore';
import type { ShiftHandoverDraft } from '../types';

const draft = (shift: string): ShiftHandoverDraft => ({
  shift,
  equipmentObservations: `现象 ${shift}`,
  handledItems: `已处置 ${shift}`,
  todos: `待办 ${shift}`,
});

function slotEnvelope(generation: number, shift: string) {
  return {
    formatVersion: HANDOVER_FORMAT_VERSION,
    generation,
    savedAt: `2026-09-15T0${generation}:00:00.000Z`,
    draft: draft(shift),
  };
}

describe('班次交接草稿双槽快照存储', () => {
  it('连续编辑按代次双槽轮转，重新打开按活动指针恢复最近确认内容', () => {
    const storage = createMemoryStorage();
    const store = createHandoverDraftStore(storage);

    const first = store.save(draft('夜班'));
    expect(first).toMatchObject({ ok: true, generation: 1, activeSlot: 'A' });
    const second = store.save(draft('夜班-补充'));
    expect(second).toMatchObject({ ok: true, generation: 2, activeSlot: 'B' });
    const third = store.save(draft('夜班-再次补充'));
    expect(third).toMatchObject({ ok: true, generation: 3, activeSlot: 'A' });

    const reopened = createHandoverDraftStore(storage).load();
    expect(reopened.status).toBe('saved');
    expect(reopened.generation).toBe(3);
    expect(reopened.activeSlot).toBe('A');
    expect(reopened.draft).toEqual(draft('夜班-再次补充'));
  });

  it('清空写入空白快照，重新打开仍由指针确认并返回空白', () => {
    const storage = createMemoryStorage();
    const store = createHandoverDraftStore(storage);
    store.save(draft('夜班'));
    store.save(draft('夜班补充'));

    const cleared = store.clear();
    expect(cleared).toMatchObject({ ok: true, status: 'saved', generation: 3 });
    expect(cleared.draft).toEqual(EMPTY_HANDOVER_DRAFT);

    const reopened = createHandoverDraftStore(storage).load();
    expect(reopened.draft).toEqual(EMPTY_HANDOVER_DRAFT);
    expect(reopened.generation).toBe(3);
    expect(reopened.status).toBe('saved');
  });

  it('指针缺失时从两个槽中选择最高有效代次', () => {
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(2, '较新')),
      [HANDOVER_STORAGE_KEYS[1]]: JSON.stringify(slotEnvelope(5, '最新')),
    });

    const loaded = createHandoverDraftStore(storage).load();
    expect(loaded.status).toBe('saved');
    expect(loaded.generation).toBe(5);
    expect(loaded.activeSlot).toBe('B');
    expect(loaded.draft).toEqual(draft('最新'));
  });

  it('活动指针槽损坏时忽略损坏槽并回退到另一个有效槽', () => {
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(8, '有效备份')),
      [HANDOVER_STORAGE_KEYS[1]]: '{broken-json',
      [HANDOVER_STORAGE_KEYS[2]]: JSON.stringify({
        formatVersion: HANDOVER_FORMAT_VERSION,
        slot: 'B',
      }),
    });

    const loaded = createHandoverDraftStore(storage).load();
    expect(loaded.status).toBe('saved');
    expect(loaded.generation).toBe(8);
    expect(loaded.activeSlot).toBe('A');
    expect(loaded.draft).toEqual(draft('有效备份'));
  });

  it('新槽已写入但指针尚未切换时，仍以指针上的最近确认内容为准', () => {
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(3, '已确认')),
      [HANDOVER_STORAGE_KEYS[1]]: JSON.stringify(slotEnvelope(4, '切换前中断')),
      [HANDOVER_STORAGE_KEYS[2]]: JSON.stringify({
        formatVersion: HANDOVER_FORMAT_VERSION,
        slot: 'A',
      }),
    });

    const loaded = createHandoverDraftStore(storage).load();
    expect(loaded.generation).toBe(3);
    expect(loaded.activeSlot).toBe('A');
    expect(loaded.draft).toEqual(draft('已确认'));
  });

  it('两个槽都无效时保持空白并说明无法恢复', () => {
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: 'not-json',
      [HANDOVER_STORAGE_KEYS[1]]: JSON.stringify({ formatVersion: 1, generation: 2 }),
      [HANDOVER_STORAGE_KEYS[2]]: 'bad-pointer',
    });

    const loaded = createHandoverDraftStore(storage).load();
    expect(loaded.status).toBe('restore-failed');
    expect(loaded.reason).toBe('invalid-slots');
    expect(loaded.draft).toEqual(EMPTY_HANDOVER_DRAFT);
  });

  it('未知格式版本不会被覆盖，且仍可从另一个已知有效槽恢复', () => {
    const unknown = {
      formatVersion: 999,
      generation: 99,
      savedAt: 'future',
      draft: draft('未来格式'),
    };
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(4, '当前版本')),
      [HANDOVER_STORAGE_KEYS[1]]: JSON.stringify(unknown),
      [HANDOVER_STORAGE_KEYS[2]]: JSON.stringify({
        formatVersion: HANDOVER_FORMAT_VERSION,
        slot: 'A',
      }),
    });

    const result = createHandoverDraftStore(storage).save(draft('不能写入未知槽'));
    expect(result).toMatchObject({
      ok: false,
      status: 'unsaved',
      reason: 'no-safe-slot',
      generation: 4,
      activeSlot: 'A',
    });
    expect(JSON.parse(storage.getItem(HANDOVER_STORAGE_KEYS[1])!)).toEqual(unknown);
    expect(JSON.parse(storage.getItem(HANDOVER_STORAGE_KEYS[0])!)).toEqual(
      slotEnvelope(4, '当前版本'),
    );
  });

  it('活动指针为未知格式版本时不从槽恢复，也不覆盖原指针', () => {
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(7, '已知槽')),
      [HANDOVER_STORAGE_KEYS[1]]: JSON.stringify(slotEnvelope(8, '另一已知槽')),
      [HANDOVER_STORAGE_KEYS[2]]: JSON.stringify({ formatVersion: 999, slot: 'A' }),
    });

    const loaded = createHandoverDraftStore(storage).load();
    expect(loaded.status).toBe('restore-failed');
    expect(loaded.reason).toBe('unknown-version');

    const result = createHandoverDraftStore(storage).save(draft('禁止切换未知指针'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-safe-slot');
    expect(JSON.parse(storage.getItem(HANDOVER_STORAGE_KEYS[2])!)).toEqual({
      formatVersion: 999,
      slot: 'A',
    });
  });

  it('两个槽均为未知版本时拒绝任何写入并保留原槽', () => {
    const initial = {
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify({ formatVersion: 999 }),
      [HANDOVER_STORAGE_KEYS[1]]: JSON.stringify({ formatVersion: 1000 }),
    };
    const storage = createMemoryStorage(initial);

    const loaded = createHandoverDraftStore(storage).load();
    expect(loaded.status).toBe('restore-failed');
    expect(loaded.reason).toBe('unknown-version');

    const result = createHandoverDraftStore(storage).save(draft('禁止覆盖'));
    expect(result.ok).toBe(false);
    expect(storage.getItem(HANDOVER_STORAGE_KEYS[0])).toBe(
      initial[HANDOVER_STORAGE_KEYS[0]],
    );
    expect(storage.getItem(HANDOVER_STORAGE_KEYS[1])).toBe(
      initial[HANDOVER_STORAGE_KEYS[1]],
    );
  });

  it('浏览器拒绝写槽时保留屏幕输入和既有可恢复快照', () => {
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(2, '旧快照')),
      [HANDOVER_STORAGE_KEYS[2]]: JSON.stringify({
        formatVersion: HANDOVER_FORMAT_VERSION,
        slot: 'A',
      }),
    });
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      if (key === HANDOVER_STORAGE_KEYS[1]) throw new DOMException('Quota exceeded');
      originalSetItem(key, value);
    };

    const attempted = draft('未保存输入');
    const result = createHandoverDraftStore(storage).save(attempted);
    expect(result).toMatchObject({
      ok: false,
      reason: 'storage-unavailable',
      status: 'unsaved',
      generation: 2,
    });
    expect(result.draft).toEqual(attempted);

    const recovered = createHandoverDraftStore(storage).load();
    expect(recovered.status).toBe('saved');
    expect(recovered.draft).toEqual(draft('旧快照'));
  });

  it('槽写入成功但活动指针被拒写时，不认为新槽已确认且仍恢复旧指针内容', () => {
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(1, '旧指针')),
      [HANDOVER_STORAGE_KEYS[2]]: JSON.stringify({
        formatVersion: HANDOVER_FORMAT_VERSION,
        slot: 'A',
      }),
    });
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      if (key === HANDOVER_STORAGE_KEYS[2]) throw new DOMException('Quota exceeded');
      originalSetItem(key, value);
    };

    const result = createHandoverDraftStore(storage).save(draft('新槽未切换'));
    expect(result).toMatchObject({ ok: false, reason: 'storage-unavailable' });
    const recovered = createHandoverDraftStore(storage).load();
    expect(recovered.activeSlot).toBe('A');
    expect(recovered.draft).toEqual(draft('旧指针'));
  });

  it('槽已写入但回读内容不一致时不切换指针，保留最近确认快照', () => {
    let nextReadback: string | null = null;
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(1, '已确认')),
      [HANDOVER_STORAGE_KEYS[2]]: JSON.stringify({
        formatVersion: HANDOVER_FORMAT_VERSION,
        slot: 'A',
      }),
    });
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = (key: string) => {
      if (key === HANDOVER_STORAGE_KEYS[1] && nextReadback !== null) {
        return nextReadback;
      }
      return originalGetItem(key);
    };
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      if (key === HANDOVER_STORAGE_KEYS[1]) {
        nextReadback = '{broken-readback';
        return;
      }
      originalSetItem(key, value);
    };

    const result = createHandoverDraftStore(storage).save(draft('回读异常'));
    expect(result).toMatchObject({ ok: false, reason: 'readback-failed' });
    expect(JSON.parse(storage.getItem(HANDOVER_STORAGE_KEYS[2])!).slot).toBe('A');
    const recovered = createHandoverDraftStore(storage).load();
    expect(recovered.draft).toEqual(draft('已确认'));
  });

  it('未知格式槽存在时一键清空也不覆盖未知槽', () => {
    const unknown = { formatVersion: 999 };
    const storage = createMemoryStorage({
      [HANDOVER_STORAGE_KEYS[0]]: JSON.stringify(slotEnvelope(1, '已知')),
      [HANDOVER_STORAGE_KEYS[1]]: JSON.stringify(unknown),
      [HANDOVER_STORAGE_KEYS[2]]: JSON.stringify({
        formatVersion: HANDOVER_FORMAT_VERSION,
        slot: 'A',
      }),
    });

    const result = createHandoverDraftStore(storage).clear();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unsaved');
    expect(JSON.parse(storage.getItem(HANDOVER_STORAGE_KEYS[1])!)).toEqual(unknown);
  });

  it('所有存储键均使用独立前缀，不触碰其他页面数据', () => {
    for (const key of HANDOVER_STORAGE_KEYS) {
      expect(key.startsWith(HANDOVER_STORAGE_PREFIX)).toBe(true);
    }
    const storage = createMemoryStorage({ 'other-page:data': '保留' });
    createHandoverDraftStore(storage).save(draft('隔离'));
    expect(storage.getItem('other-page:data')).toBe('保留');
  });
});
