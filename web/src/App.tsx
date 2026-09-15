import { FormEvent, useState } from 'react';
import { postCalculate } from './api';
import ChangeBoardPanel from './components/ChangeBoardPanel';
import InspectionPanel from './components/InspectionPanel';
import ResultPanel from './components/ResultPanel';
import type { BendFormState, CalcResult } from './types';

const DEFAULT_BEND: BendFormState = {
  angle: '90',
  thickness: '2',
  innerRadius: '3',
  kFactor: '0.33',
};

const DEFAULT_SEGMENTS = ['100', '50'];

type FieldErrors = Record<string, string>;

type View = 'calc' | 'inspection' | 'board';

export default function App() {
  const [view, setView] = useState<View>('calc');
  const [bends, setBends] = useState<BendFormState[]>([{ ...DEFAULT_BEND }]);
  const [segments, setSegments] = useState<string[]>([...DEFAULT_SEGMENTS]);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function addBend() {
    setBends((prev) => [...prev, { ...DEFAULT_BEND }]);
    setSegments((prev) => [...prev, '']);
  }

  function removeBend(index: number) {
    if (bends.length <= 1) return;
    setBends((prev) => prev.filter((_, i) => i !== index));
    // 每道折弯对应其后一个直段，删除该道时一并移除，保持 n+1 关系
    setSegments((prev) => prev.filter((_, i) => i !== index + 1));
  }

  function updateBend(index: number, key: keyof BendFormState, value: string) {
    setBends((prev) =>
      prev.map((b, i) => (i === index ? { ...b, [key]: value } : b)),
    );
  }

  function updateSegment(index: number, value: string) {
    setSegments((prev) => prev.map((s, i) => (i === index ? value : s)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const payload = {
      segments: segments.map((s) => s.trim()),
      bends: bends.map((b) => ({
        angle: b.angle.trim(),
        thickness: b.thickness.trim(),
        inner_radius: b.innerRadius.trim(),
        k_factor: b.kFactor.trim(),
      })),
    };
    const outcome = await postCalculate(payload);
    setSubmitting(false);
    if (outcome.ok) {
      setResult(outcome.data);
      setFieldErrors({});
      setGeneralError(null);
    } else {
      // 非法提交：只展示错误，绝不清空/替换上一份有效结果
      const next: FieldErrors = {};
      const general: string[] = [];
      for (const err of outcome.errors) {
        if (err.field === 'body') general.push(err.message);
        else next[err.field] = err.message;
      }
      setFieldErrors(next);
      setGeneralError(general.length > 0 ? general.join('；') : '提交参数不合法，请按字段提示修正');
    }
  }

  function bendFieldError(bendIndex: number, key: string): string | undefined {
    return fieldErrors[`bends.${bendIndex}.${key}`];
  }

  return (
    <main className="page">
      <h1>折弯展开复核台</h1>
      <nav className="tabs" role="tablist" aria-label="视图切换">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'calc'}
          className={view === 'calc' ? 'tab active' : 'tab'}
          onClick={() => setView('calc')}
        >
          展开复核
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'inspection'}
          className={view === 'inspection' ? 'tab active' : 'tab'}
          onClick={() => setView('inspection')}
        >
          来料抽检
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'board'}
          className={view === 'board' ? 'tab active' : 'tab'}
          onClick={() => setView('board')}
        >
          换模作业牌
        </button>
      </nav>

      {view === 'inspection' ? (
        <InspectionPanel />
      ) : view === 'board' ? (
        <ChangeBoardPanel />
      ) : (
        <>
          <p className="hint">
            补偿量 = π÷180 × 角度 ×（内半径 + K因子 × 板厚）；未舍入总长 = 全部直段 +
            全部补偿量；下料长度按 ROUND_HALF_UP 保留两位。单位均为 mm。
          </p>

          <form onSubmit={onSubmit} noValidate>
        <section aria-label="直段输入">
          <h2>
            切点间直段（{segments.length} 段 = 折弯 {bends.length} 道 + 1）
          </h2>
          <div className="segments">
            {segments.map((value, i) => (
              <div className="field" key={i}>
                <label htmlFor={`segment-${i}`}>直段 L{i + 1}（mm）</label>
                <input
                  id={`segment-${i}`}
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => updateSegment(i, e.target.value)}
                  aria-invalid={Boolean(fieldErrors[`segments.${i}`])}
                  aria-describedby={
                    fieldErrors[`segments.${i}`] ? `error-segment-${i}` : undefined
                  }
                />
                {fieldErrors[`segments.${i}`] && (
                  <p className="error" id={`error-segment-${i}`} role="alert">
                    {fieldErrors[`segments.${i}`]}
                  </p>
                )}
              </div>
            ))}
          </div>
          {fieldErrors['segments'] && (
            <p className="error" role="alert" data-testid="error-segments">
              {fieldErrors['segments']}
            </p>
          )}
        </section>

        <section aria-label="折弯输入">
          <h2>折弯（按加工顺序，共 {bends.length} 道）</h2>
          {bends.map((bend, i) => (
            <fieldset className="bend" key={i} data-testid={`bend-fieldset-${i}`}>
              <legend>第 {i + 1} 道折弯</legend>
              <div className="bend-grid">
                <div className="field">
                  <label htmlFor={`bend-${i}-angle`}>角度（°，0~180 不含边界）</label>
                  <input
                    id={`bend-${i}-angle`}
                    inputMode="decimal"
                    value={bend.angle}
                    onChange={(e) => updateBend(i, 'angle', e.target.value)}
                    aria-invalid={Boolean(bendFieldError(i, 'angle'))}
                    aria-describedby={
                      bendFieldError(i, 'angle') ? `error-bend-${i}-angle` : undefined
                    }
                  />
                  {bendFieldError(i, 'angle') && (
                    <p className="error" id={`error-bend-${i}-angle`} role="alert">
                      {bendFieldError(i, 'angle')}
                    </p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor={`bend-${i}-thickness`}>板厚（mm，&gt;0）</label>
                  <input
                    id={`bend-${i}-thickness`}
                    inputMode="decimal"
                    value={bend.thickness}
                    onChange={(e) => updateBend(i, 'thickness', e.target.value)}
                    aria-invalid={Boolean(bendFieldError(i, 'thickness'))}
                    aria-describedby={
                      bendFieldError(i, 'thickness')
                        ? `error-bend-${i}-thickness`
                        : undefined
                    }
                  />
                  {bendFieldError(i, 'thickness') && (
                    <p className="error" id={`error-bend-${i}-thickness`} role="alert">
                      {bendFieldError(i, 'thickness')}
                    </p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor={`bend-${i}-inner-radius`}>内半径（mm，≥0）</label>
                  <input
                    id={`bend-${i}-inner-radius`}
                    inputMode="decimal"
                    value={bend.innerRadius}
                    onChange={(e) => updateBend(i, 'innerRadius', e.target.value)}
                    aria-invalid={Boolean(bendFieldError(i, 'inner_radius'))}
                    aria-describedby={
                      bendFieldError(i, 'inner_radius')
                        ? `error-bend-${i}-inner-radius`
                        : undefined
                    }
                  />
                  {bendFieldError(i, 'inner_radius') && (
                    <p
                      className="error"
                      id={`error-bend-${i}-inner-radius`}
                      role="alert"
                    >
                      {bendFieldError(i, 'inner_radius')}
                    </p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor={`bend-${i}-k-factor`}>K 因子（0~0.5）</label>
                  <input
                    id={`bend-${i}-k-factor`}
                    inputMode="decimal"
                    value={bend.kFactor}
                    onChange={(e) => updateBend(i, 'kFactor', e.target.value)}
                    aria-invalid={Boolean(bendFieldError(i, 'k_factor'))}
                    aria-describedby={
                      bendFieldError(i, 'k_factor')
                        ? `error-bend-${i}-k-factor`
                        : undefined
                    }
                  />
                  {bendFieldError(i, 'k_factor') && (
                    <p className="error" id={`error-bend-${i}-k-factor`} role="alert">
                      {bendFieldError(i, 'k_factor')}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="link"
                onClick={() => removeBend(i)}
                disabled={bends.length <= 1}
              >
                删除该道
              </button>
            </fieldset>
          ))}
          {fieldErrors['bends'] && (
            <p className="error" role="alert" data-testid="error-bends">
              {fieldErrors['bends']}
            </p>
          )}
          <button type="button" className="secondary" onClick={addBend}>
            + 添加一道折弯
          </button>
        </section>

        <div className="actions">
          <button type="submit" disabled={submitting}>
            {submitting ? '计算中…' : '计算下料长度'}
          </button>
        </div>
      </form>

      {generalError && (
        <p className="error general" role="alert" data-testid="general-error">
          {generalError}
        </p>
      )}

      {result && <ResultPanel result={result} />}
        </>
      )}
    </main>
  );
}
