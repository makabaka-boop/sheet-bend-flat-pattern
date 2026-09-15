import { FormEvent, useCallback, useEffect, useState } from 'react';
import { claimChangeBoard, fetchChangeBoard, releaseChangeBoard } from '../api';
import type { BoardSnapshot, FieldError } from '../types';

type FieldErrors = Record<string, string>;

/**
 * 换模作业牌视图：本机唯一的换模占用协调对象。
 *
 * 与展开结果、来料抽检记录互不读写。打开页面先读服务端状态与修订号；
 * 认领/归还都提交当前修订号，成功后以服务端快照更新卡片；
 * 412 裁决失败时同样用响应中的胜出快照刷新卡片，且保留自己的填写内容。
 */
export default function ChangeBoardPanel() {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [holder, setHolder] = useState('');
  const [dieDescription, setDieDescription] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const outcome = await fetchChangeBoard();
    if (outcome.ok) {
      setSnapshot(outcome.data);
      setLoadError(null);
    } else {
      setLoadError(outcome.errors.map((e) => e.message).join('；'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function applyFieldErrors(errors: FieldError[]) {
    const next: FieldErrors = {};
    const general: string[] = [];
    for (const err of errors) {
      if (err.field === 'body' || err.field === 'revision') {
        general.push(err.message);
      } else {
        next[err.field] = err.message;
      }
    }
    setFieldErrors(next);
    setGeneralError(general.length > 0 ? general.join('；') : null);
  }

  async function onClaim(e: FormEvent) {
    e.preventDefault();
    if (!snapshot) return;
    setSubmitting(true);
    const outcome = await claimChangeBoard({
      holder: holder.trim(),
      die_description: dieDescription.trim(),
      revision: snapshot.revision,
    });
    setSubmitting(false);
    if (outcome.ok) {
      // 成功：以服务端快照更新卡片，清空冲突提示；姓名与模具说明填写内容保留
      setSnapshot(outcome.data);
      setFieldErrors({});
      setGeneralError(null);
    } else {
      // 412 竞争失败 / 422 字段错误：立即显示最新持有人，且保留自己的填写
      if (outcome.snapshot) setSnapshot(outcome.snapshot);
      applyFieldErrors(outcome.errors);
    }
  }

  async function onRelease(e: FormEvent) {
    e.preventDefault();
    if (!snapshot) return;
    setSubmitting(true);
    const outcome = await releaseChangeBoard({
      holder: holder.trim(),
      revision: snapshot.revision,
    });
    setSubmitting(false);
    if (outcome.ok) {
      setSnapshot(outcome.data);
      setFieldErrors({});
      setGeneralError(null);
    } else {
      if (outcome.snapshot) setSnapshot(outcome.snapshot);
      applyFieldErrors(outcome.errors);
    }
  }

  const occupied = snapshot?.state === 'occupied';
  const isCurrentHolder =
    occupied && holder.trim().length > 0 && holder.trim() === snapshot?.holder;

  return (
    <>
      <p className="hint">
        换模作业牌是本机唯一的占用协调对象：换模前先认领，完成后由持有人归还。
        作业牌状态与展开复核、来料抽检互不读写。
      </p>

      <section className="result board-card" aria-label="换模作业牌" data-testid="board-panel">
        <h2>换模作业牌</h2>

        {loadError && (
          <p className="error general" role="alert" data-testid="board-load-error">
            {loadError}
          </p>
        )}

        {!snapshot && !loadError && (
          <p className="hint" data-testid="board-loading">
            正在读取作业牌状态…
          </p>
        )}

        {snapshot && (
          <>
            <div className={`board-status ${occupied ? 'occupied' : 'free'}`}>
              <span className="board-badge" data-testid="board-state">
                {occupied ? '占用中' : '空闲'}
              </span>
              <span className="board-revision" data-testid="board-revision">
                修订号 {snapshot.revision}
              </span>
            </div>

            {occupied && (
              <dl className="board-holder" data-testid="board-occupied-info">
                <div>
                  <dt>当前持有人</dt>
                  <dd data-testid="board-current-holder">{snapshot.holder}</dd>
                </div>
                <div>
                  <dt>模具说明</dt>
                  <dd data-testid="board-current-die">{snapshot.die_description}</dd>
                </div>
                <div>
                  <dt>认领时间（UTC）</dt>
                  <dd data-testid="board-claimed-at">{snapshot.claimed_at}</dd>
                </div>
              </dl>
            )}
          </>
        )}

        <form onSubmit={occupied ? onRelease : onClaim} noValidate>
          <div className="bend-grid">
            <div className="field">
              <label htmlFor="board-holder">你的姓名</label>
              <input
                id="board-holder"
                value={holder}
                onChange={(e) => setHolder(e.target.value)}
                aria-invalid={Boolean(fieldErrors['holder'])}
                aria-describedby={
                  fieldErrors['holder'] ? 'error-board-holder' : undefined
                }
              />
              {fieldErrors['holder'] && (
                <p className="error" id="error-board-holder" role="alert">
                  {fieldErrors['holder']}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor="board-die-description">
                模具说明（型号 / 模位 / 套数）
              </label>
              <input
                id="board-die-description"
                value={dieDescription}
                onChange={(e) => setDieDescription(e.target.value)}
                disabled={occupied}
                aria-invalid={Boolean(fieldErrors['die_description'])}
                aria-describedby={
                  fieldErrors['die_description']
                    ? 'error-board-die-description'
                    : undefined
                }
              />
              {fieldErrors['die_description'] && (
                <p className="error" id="error-board-die-description" role="alert">
                  {fieldErrors['die_description']}
                </p>
              )}
            </div>
          </div>

          <div className="actions">
            {occupied ? (
              <button
                type="submit"
                disabled={submitting || !snapshot}
                data-testid="board-release"
              >
                {submitting ? '归还中…' : '归还作业牌'}
              </button>
            ) : (
              <button
                type="submit"
                disabled={submitting || !snapshot}
                data-testid="board-claim"
              >
                {submitting ? '认领中…' : '认领作业牌'}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => void refresh()}
              disabled={submitting}
            >
              刷新状态
            </button>
          </div>

          {occupied && !isCurrentHolder && snapshot && (
            <p className="hint board-note" data-testid="board-not-holder-note">
              作业牌由 {snapshot.holder} 持有；只有持有人凭当前修订号才能归还。
            </p>
          )}
        </form>

        {generalError && (
          <p className="error general" role="alert" data-testid="board-conflict">
            {generalError}
          </p>
        )}
      </section>
    </>
  );
}
