import { useState } from 'react';
import {
  createHandoverDraftStore,
  EMPTY_HANDOVER_DRAFT,
  type HandoverDraftStatus,
  type LoadFailureReason,
  type SaveFailureReason,
} from '../lib/handoverDraftStore';
import type { ShiftHandoverDraft } from '../types';

const handoverStore = createHandoverDraftStore();

type DraftField = keyof ShiftHandoverDraft;

const FIELDS: Array<{
  key: DraftField;
  label: string;
  placeholder: string;
  rows: number;
}> = [
  {
    key: 'shift',
    label: '班次',
    placeholder: '例如：夜班 / 早班，交接时间和接班人可在此注明',
    rows: 2,
  },
  {
    key: 'equipmentObservations',
    label: '设备现象',
    placeholder: '记录折弯机运行声音、精度、报警、油温或模具异常等现象',
    rows: 4,
  },
  {
    key: 'handledItems',
    label: '已处置事项',
    placeholder: '本班已经调整、确认、报修或完成的事项',
    rows: 4,
  },
  {
    key: 'todos',
    label: '待办',
    placeholder: '下一班需要继续跟踪、复核或等待处理的事项',
    rows: 4,
  },
];

function isBlankDraft(draft: ShiftHandoverDraft) {
  return Object.values(draft).every((value) => value.trim().length === 0);
}

function formatSavedAt(savedAt: string) {
  const time = Date.parse(savedAt);
  if (Number.isNaN(time)) return savedAt;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(time));
}

export default function HandoverPanel() {
  const [initialLoad] = useState(() => handoverStore.load());
  const [draft, setDraft] = useState<ShiftHandoverDraft>({
    ...initialLoad.draft,
  });
  const [status, setStatus] = useState<HandoverDraftStatus>(
    initialLoad.status === 'saved' && isBlankDraft(initialLoad.draft)
      ? 'blank'
      : initialLoad.status,
  );
  const [failureReason, setFailureReason] = useState<
    LoadFailureReason | SaveFailureReason | undefined
  >(initialLoad.reason);
  const [savedAt, setSavedAt] = useState(initialLoad.savedAt);
  const [generation, setGeneration] = useState(initialLoad.generation);

  function updateField(field: DraftField, value: string) {
    const nextDraft = { ...draft, [field]: value };
    setDraft(nextDraft);

    const result = handoverStore.save(nextDraft);
    setStatus(result.ok ? 'saved' : 'unsaved');
    setFailureReason(result.ok ? undefined : result.reason);
    setSavedAt(result.savedAt);
    setGeneration(result.generation);
  }

  function clearAfterHandover() {
    const result = handoverStore.clear();
    // 只有空白快照确认写入并切换指针后才清空屏幕；否则保留当前内容，
    // 避免“屏幕已清空、刷新后旧草稿恢复”的错觉。
    if (!result.ok) {
      setStatus('unsaved');
      setFailureReason(result.reason);
      setSavedAt(result.savedAt);
      setGeneration(result.generation);
      return;
    }
    setDraft({ ...EMPTY_HANDOVER_DRAFT });
    setStatus('blank');
    setFailureReason(undefined);
    setSavedAt(result.savedAt);
    setGeneration(result.generation);
  }

  const statusMessage: Record<HandoverDraftStatus, string> = {
    blank: '暂无交接草稿；输入后会自动保存在当前浏览器。',
    saved: savedAt
      ? `草稿已保存到本浏览器（代次 ${generation}，${formatSavedAt(savedAt)}）。`
      : '草稿已保存到本浏览器。',
    unsaved: '本次内容尚未保存；屏幕输入已保留，最近可恢复快照未被覆盖。',
    'restore-failed':
      failureReason === 'unknown-version'
        ? '发现无法识别的草稿格式版本，旧快照未被覆盖；当前无法恢复草稿。'
        : failureReason === 'storage-unavailable'
          ? '当前浏览器无法读取或保存本地草稿，现有交接内容可能恢复失败；屏幕内容已保留。'
          : '两个草稿槽均无法读取，草稿无法恢复；当前保持空白。',
  };

  return (
    <>
      <p className="hint">
        班次交接草稿只保存在当前浏览器，不会提交到服务端。设备断电或刷新后，
        页面会回到最近一次确认写入的内容；完成口头交接后可一键清空。
      </p>

      <section
        className="result handover-card"
        aria-label="班次交接草稿"
        data-testid="handover-panel"
      >
        <h2>班次交接草稿</h2>
        <p
          className={`handover-status ${status}`}
          role="status"
          data-testid="handover-status"
          data-status={status}
        >
          {statusMessage[status]}
        </p>

        <div className="handover-fields">
          {FIELDS.map(({ key, label, placeholder, rows }) => (
            <div className="field handover-field" key={key}>
              <label htmlFor={`handover-${kebab(key)}`}>{label}</label>
              <textarea
                id={`handover-${kebab(key)}`}
                value={draft[key]}
                rows={rows}
                placeholder={placeholder}
                onChange={(event) => updateField(key, event.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="actions handover-actions">
          <button
            type="button"
            className="secondary"
            onClick={clearAfterHandover}
            data-testid="handover-clear"
          >
            口头交接完成，一键清空
          </button>
          <span className="handover-local-note">仅本机浏览器可读取</span>
        </div>
      </section>
    </>
  );
}

function kebab(field: DraftField) {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}
