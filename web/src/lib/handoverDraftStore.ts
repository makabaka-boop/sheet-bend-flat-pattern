import type { ShiftHandoverDraft } from '../types';

export const HANDOVER_FORMAT_VERSION = 1;
export const HANDOVER_STORAGE_PREFIX = 'bend-terminal.handover.';
const SLOT_A_KEY = `${HANDOVER_STORAGE_PREFIX}slot-a`;
const SLOT_B_KEY = `${HANDOVER_STORAGE_PREFIX}slot-b`;
const POINTER_KEY = `${HANDOVER_STORAGE_PREFIX}active`;
export const HANDOVER_STORAGE_KEYS = [SLOT_A_KEY, SLOT_B_KEY, POINTER_KEY] as const;

type SlotId = 'A' | 'B';

export type HandoverDraftStatus =
  | 'blank'
  | 'saved'
  | 'unsaved'
  | 'restore-failed';

export type LoadFailureReason =
  | 'invalid-slots'
  | 'unknown-version'
  | 'storage-unavailable';

export type SaveFailureReason =
  | 'storage-unavailable'
  | 'no-safe-slot'
  | 'readback-failed';

interface HandoverEnvelopeV1 {
  formatVersion: 1;
  generation: number;
  savedAt: string;
  draft: ShiftHandoverDraft;
}

interface ActivePointer {
  formatVersion: 1;
  slot: SlotId;
}

type ParsedPointer =
  | { kind: 'valid'; pointer: ActivePointer }
  | { kind: 'unknown' }
  | { kind: 'missing' };

interface UnknownEnvelope {
  kind: 'unknown';
  formatVersion: unknown;
}

interface InvalidEnvelope {
  kind: 'invalid';
}

type ParsedEnvelope =
  | ({ kind: 'valid'; slot: SlotId } & HandoverEnvelopeV1)
  | ({ kind: 'unknown'; slot: SlotId } & UnknownEnvelope)
  | ({ kind: 'invalid'; slot: SlotId } & InvalidEnvelope)
  | { kind: 'empty' };

export interface HandoverDraftLoadResult {
  draft: ShiftHandoverDraft;
  status: HandoverDraftStatus;
  reason?: LoadFailureReason;
  generation: number;
  savedAt: string | null;
  activeSlot: SlotId | null;
}

export interface HandoverDraftSaveResult {
  ok: boolean;
  reason?: SaveFailureReason;
  draft: ShiftHandoverDraft;
  status: HandoverDraftStatus;
  generation: number;
  savedAt: string | null;
  activeSlot: SlotId | null;
}

export interface HandoverDraftStore {
  load(): HandoverDraftLoadResult;
  save(draft: ShiftHandoverDraft): HandoverDraftSaveResult;
  clear(): HandoverDraftSaveResult;
}

export const EMPTY_HANDOVER_DRAFT: ShiftHandoverDraft = {
  shift: '',
  equipmentObservations: '',
  handledItems: '',
  todos: '',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isHandoverDraft(value: unknown): value is ShiftHandoverDraft {
  if (!isRecord(value)) return false;
  return (
    typeof value.shift === 'string' &&
    typeof value.equipmentObservations === 'string' &&
    typeof value.handledItems === 'string' &&
    typeof value.todos === 'string'
  );
}

type StorageRead =
  | { ok: true; value: string | null }
  | { ok: false };

function readStorage(storage: Storage | undefined, key: string): StorageRead {
  if (!storage) return { ok: false };
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false };
  }
}

function writeStorage(storage: Storage | undefined, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function parseEnvelope(raw: string | null, slot: SlotId): ParsedEnvelope {
  if (raw === null) return { kind: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', slot };
  }
  if (!isRecord(parsed)) return { kind: 'invalid', slot };
  if (parsed.formatVersion !== HANDOVER_FORMAT_VERSION) {
    return { kind: 'unknown', slot, formatVersion: parsed.formatVersion };
  }
  const generation = parsed.generation;
  if (
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return { kind: 'invalid', slot };
  }
  if (!isNonEmptyString(parsed.savedAt) || !isHandoverDraft(parsed.draft)) {
    return { kind: 'invalid', slot };
  }
  return {
    kind: 'valid',
    slot,
    formatVersion: HANDOVER_FORMAT_VERSION,
    generation,
    savedAt: parsed.savedAt,
    draft: parsed.draft,
  };
}

function parsePointer(raw: string | null): ParsedPointer {
  if (raw === null) return { kind: 'missing' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      (parsed.slot === 'A' || parsed.slot === 'B') &&
      parsed.formatVersion === HANDOVER_FORMAT_VERSION
    ) {
      return {
        kind: 'valid',
        pointer: { formatVersion: HANDOVER_FORMAT_VERSION, slot: parsed.slot },
      };
    }
    if (isRecord(parsed) && 'formatVersion' in parsed) {
      return { kind: 'unknown' };
    }
  } catch {
    // 指针损坏时按“指针缺失”处理，再尝试从两个槽恢复。
  }
  return { kind: 'missing' };
}

function readSlots(storage: Storage | undefined) {
  const pointerRead = readStorage(storage, POINTER_KEY);
  const slotARead = readStorage(storage, SLOT_A_KEY);
  const slotBRead = readStorage(storage, SLOT_B_KEY);
  const readError =
    !pointerRead.ok || !slotARead.ok || !slotBRead.ok;
  const parsedPointer = parsePointer(
    pointerRead.ok ? pointerRead.value : null,
  );
  const pointer = parsedPointer.kind === 'valid' ? parsedPointer.pointer : null;
  const a = parseEnvelope(slotARead.ok ? slotARead.value : null, 'A');
  const b = parseEnvelope(slotBRead.ok ? slotBRead.value : null, 'B');
  return { readError, parsedPointer, pointer, slots: { A: a, B: b } };
}

function highestValid(
  slots: Record<SlotId, ParsedEnvelope>,
): ({ kind: 'valid'; slot: SlotId } & HandoverEnvelopeV1) | null {
  const valid = [slots.A, slots.B].filter(
    (slot): slot is { kind: 'valid'; slot: SlotId } & HandoverEnvelopeV1 =>
      slot.kind === 'valid',
  );
  valid.sort((left, right) => {
    if (right.generation !== left.generation) return right.generation - left.generation;
    return right.slot.localeCompare(left.slot);
  });
  return valid[0] ?? null;
}

function failureResult(reason: LoadFailureReason): HandoverDraftLoadResult {
  return {
    draft: { ...EMPTY_HANDOVER_DRAFT },
    status: 'restore-failed',
    reason,
    generation: 0,
    savedAt: null,
    activeSlot: null,
  };
}

function chooseTargetSlot(
  slots: Record<SlotId, ParsedEnvelope>,
  currentSlot: SlotId | null,
): SlotId | null {
  const isUnknown = (slot: SlotId) => slots[slot].kind === 'unknown';
  const candidates: SlotId[] = ['A', 'B'];

  // 常规双槽轮转：始终先写非活动槽，保证上一份快照在切换完成前不动。
  if (currentSlot) {
    const inactive = currentSlot === 'A' ? 'B' : 'A';
    return isUnknown(inactive) ? null : inactive;
  }

  // 启动恢复后没有已确认指针：优先写到空槽或无效槽，绝不覆盖未知格式槽。
  const usable = candidates.find((slot) => slots[slot].kind !== 'unknown');
  return usable ?? null;
}

function getDefaultStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function createHandoverDraftStore(storage?: Storage | null): HandoverDraftStore {
  const backingStore = storage === undefined ? getDefaultStorage() : storage;

  return {
    load() {
      if (!backingStore) return failureResult('storage-unavailable');
      const { readError, parsedPointer, pointer, slots } = readSlots(backingStore);
      if (readError) return failureResult('storage-unavailable');

      if (pointer && slots[pointer.slot].kind === 'valid') {
        const snapshot = slots[pointer.slot] as {
          kind: 'valid';
          slot: SlotId;
        } & HandoverEnvelopeV1;
        return {
          draft: { ...snapshot.draft },
          status: 'saved',
          generation: snapshot.generation,
          savedAt: snapshot.savedAt,
          activeSlot: snapshot.slot,
        };
      }

      if (parsedPointer.kind === 'unknown') {
        return failureResult('unknown-version');
      }

      // 只有指针缺失或指针指向的活动槽无效时，才扫描两槽并选择最高有效代次。
      const recovered = highestValid(slots);
      if (recovered) {
        return {
          draft: { ...recovered.draft },
          status: 'saved',
          generation: recovered.generation,
          savedAt: recovered.savedAt,
          activeSlot: recovered.slot,
        };
      }

      const hasUnknown = slots.A.kind === 'unknown' || slots.B.kind === 'unknown';
      const hasInvalid =
        slots.A.kind === 'invalid' ||
        slots.B.kind === 'invalid' ||
        pointer !== null;
      if (hasUnknown) return failureResult('unknown-version');
      if (hasInvalid) return failureResult('invalid-slots');
      return {
        draft: { ...EMPTY_HANDOVER_DRAFT },
        status: 'blank',
        generation: 0,
        savedAt: null,
        activeSlot: null,
      };
    },

    save(draft) {
      if (!backingStore) {
        return {
          ok: false,
          reason: 'storage-unavailable',
          draft: { ...draft },
          status: 'unsaved',
          generation: 0,
          savedAt: null,
          activeSlot: null,
        };
      }
      if (!isHandoverDraft(draft)) {
        const current = this.load();
        return {
          ok: false,
          reason: 'no-safe-slot',
          draft: { ...EMPTY_HANDOVER_DRAFT },
          status: 'unsaved',
          generation: current.generation,
          savedAt: current.savedAt,
          activeSlot: current.activeSlot,
        };
      }

      const { readError, parsedPointer, pointer, slots } = readSlots(backingStore);
      if (readError) {
        return {
          ok: false,
          reason: 'storage-unavailable',
          draft: { ...draft },
          status: 'unsaved',
          generation: 0,
          savedAt: null,
          activeSlot: null,
        };
      }
      if (parsedPointer.kind === 'unknown') {
        const recovered = highestValid(slots);
        return {
          ok: false,
          reason: 'no-safe-slot',
          draft: { ...draft },
          status: 'unsaved',
          generation: recovered?.generation ?? 0,
          savedAt: recovered?.savedAt ?? null,
          activeSlot: recovered?.slot ?? null,
        };
      }

      const activeValid =
        pointer && slots[pointer.slot].kind === 'valid'
          ? (slots[pointer.slot] as { kind: 'valid'; slot: SlotId } & HandoverEnvelopeV1)
          : null;
      const recovered = highestValid(slots);
      const current = activeValid ?? recovered;
      const target = chooseTargetSlot(
        slots,
        pointer && slots[pointer.slot].kind === 'valid' ? pointer.slot : current?.slot ?? null,
      );

      if (!target) {
        return {
          ok: false,
          reason: 'no-safe-slot',
          draft: { ...draft },
          status: 'unsaved',
          generation: current?.generation ?? 0,
          savedAt: current?.savedAt ?? null,
          activeSlot: current?.slot ?? null,
        };
      }

      const nextEnvelope: HandoverEnvelopeV1 = {
        formatVersion: HANDOVER_FORMAT_VERSION,
        generation: (current?.generation ?? 0) + 1,
        savedAt: new Date().toISOString(),
        draft: { ...draft },
      };
      const serialized = JSON.stringify(nextEnvelope);
      if (!writeStorage(backingStore, target === 'A' ? SLOT_A_KEY : SLOT_B_KEY, serialized)) {
        return {
          ok: false,
          reason: 'storage-unavailable',
          draft: { ...draft },
          status: 'unsaved',
          generation: current?.generation ?? 0,
          savedAt: current?.savedAt ?? null,
          activeSlot: current?.slot ?? null,
        };
      }

      const targetKey = target === 'A' ? SLOT_A_KEY : SLOT_B_KEY;
      const readBackResult = readStorage(backingStore, targetKey);
      if (!readBackResult.ok) {
        return {
          ok: false,
          reason: 'storage-unavailable',
          draft: { ...draft },
          status: 'unsaved',
          generation: current?.generation ?? 0,
          savedAt: current?.savedAt ?? null,
          activeSlot: current?.slot ?? null,
        };
      }
      const readRaw = readBackResult.value;
      const readBack = parseEnvelope(readRaw, target);
      if (readBack.kind !== 'valid' || readRaw !== serialized) {
        return {
          ok: false,
          reason: 'readback-failed',
          draft: { ...draft },
          status: 'unsaved',
          generation: current?.generation ?? 0,
          savedAt: current?.savedAt ?? null,
          activeSlot: current?.slot ?? null,
        };
      }

      const nextPointer: ActivePointer = {
        formatVersion: HANDOVER_FORMAT_VERSION,
        slot: target,
      };
      if (!writeStorage(backingStore, POINTER_KEY, JSON.stringify(nextPointer))) {
        return {
          ok: false,
          reason: 'storage-unavailable',
          draft: { ...draft },
          status: 'unsaved',
          generation: nextEnvelope.generation,
          savedAt: nextEnvelope.savedAt,
          activeSlot: current?.slot ?? null,
        };
      }

      return {
        ok: true,
        draft: { ...nextEnvelope.draft },
        status: 'saved',
        generation: nextEnvelope.generation,
        savedAt: nextEnvelope.savedAt,
        activeSlot: target,
      };
    },

    clear() {
      return this.save({ ...EMPTY_HANDOVER_DRAFT });
    },
  };
}

export function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  };
}
