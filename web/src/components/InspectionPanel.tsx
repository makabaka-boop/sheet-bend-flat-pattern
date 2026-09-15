import { FormEvent, useCallback, useEffect, useState } from 'react';
import { fetchRecentInspections, postInspection } from '../api';
import type { FieldError, InspectionRecord } from '../types';

type FieldErrors = Record<string, string>;

/** 越界方向 → 面向备料员的中文。 */
const DIRECTION_LABEL: Record<string, string> = {
  within: '区间内',
  above: '越上界',
  below: '越下界',
};

/**
 * 来料板厚抽检视图：登记 → 判定 → 最近记录。
 * 与展开计算完全独立：抽检结论不写入、也不改变展开结果。
 */
export default function InspectionPanel() {
  const [batchNo, setBatchNo] = useState('');
  const [material, setMaterial] = useState('');
  const [nominal, setNominal] = useState('');
  const [lowerTolerance, setLowerTolerance] = useState('');
  const [upperTolerance, setUpperTolerance] = useState('');
  const [measurements, setMeasurements] = useState<string[]>(['', '', '']);
  const [records, setRecords] = useState<InspectionRecord[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const outcome = await fetchRecentInspections();
    if (outcome.ok) {
      setRecords(outcome.data);
      setListError(null);
    } else {
      setListError(outcome.errors.map((e) => e.message).join('；'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function updateMeasurement(index: number, value: string) {
    setMeasurements((prev) => prev.map((m, i) => (i === index ? value : m)));
  }

  function addMeasurement() {
    setMeasurements((prev) => [...prev, '']);
  }

  function removeMeasurement(index: number) {
    // 至少保留三次实测
    if (measurements.length <= 3) return;
    setMeasurements((prev) => prev.filter((_, i) => i !== index));
  }

  function applyErrors(errors: FieldError[]) {
    // 校验失败 / 批次冲突：只展示错误，保留全部输入与已加载列表
    const next: FieldErrors = {};
    const general: string[] = [];
    for (const err of errors) {
      if (err.field === 'body') general.push(err.message);
      else next[err.field] = err.message;
    }
    setFieldErrors(next);
    setGeneralError(
      general.length > 0 ? general.join('；') : '提交参数不合法，请按字段提示修正',
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const outcome = await postInspection({
      batch_no: batchNo.trim(),
      material: material.trim(),
      nominal: nominal.trim(),
      lower_tolerance: lowerTolerance.trim(),
      upper_tolerance: upperTolerance.trim(),
      measurements: measurements.map((m) => m.trim()),
    });
    setSubmitting(false);
    if (outcome.ok) {
      setFieldErrors({});
      setGeneralError(null);
      // 登记成功：清空表单准备下一批，并刷新最近记录
      setBatchNo('');
      setMaterial('');
      setNominal('');
      setLowerTolerance('');
      setUpperTolerance('');
      setMeasurements(['', '', '']);
      await refresh();
    } else {
      applyErrors(outcome.errors);
    }
  }

  function measurementError(index: number): string | undefined {
    return fieldErrors[`measurements.${index}`];
  }

  return (
    <>
      <p className="hint">
        合格区间为闭区间 [标称板厚 − 下允许偏差, 标称板厚 + 上允许偏差]；
        全部实测值均在区间内才判为合格。抽检结论不参与、也不改变展开计算结果。
      </p>

      <form onSubmit={onSubmit} noValidate>
        <section aria-label="抽检登记">
          <h2>来料抽检登记</h2>
          <div className="bend-grid">
            <div className="field">
              <label htmlFor="inspection-batch-no">批次号（唯一）</label>
              <input
                id="inspection-batch-no"
                value={batchNo}
                onChange={(e) => setBatchNo(e.target.value)}
                aria-invalid={Boolean(fieldErrors['batch_no'])}
                aria-describedby={
                  fieldErrors['batch_no'] ? 'error-inspection-batch-no' : undefined
                }
              />
              {fieldErrors['batch_no'] && (
                <p className="error" id="error-inspection-batch-no" role="alert">
                  {fieldErrors['batch_no']}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor="inspection-material">材料牌号</label>
              <input
                id="inspection-material"
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
                aria-invalid={Boolean(fieldErrors['material'])}
                aria-describedby={
                  fieldErrors['material'] ? 'error-inspection-material' : undefined
                }
              />
              {fieldErrors['material'] && (
                <p className="error" id="error-inspection-material" role="alert">
                  {fieldErrors['material']}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor="inspection-nominal">标称板厚（mm，&gt;0）</label>
              <input
                id="inspection-nominal"
                inputMode="decimal"
                value={nominal}
                onChange={(e) => setNominal(e.target.value)}
                aria-invalid={Boolean(fieldErrors['nominal'])}
                aria-describedby={
                  fieldErrors['nominal'] ? 'error-inspection-nominal' : undefined
                }
              />
              {fieldErrors['nominal'] && (
                <p className="error" id="error-inspection-nominal" role="alert">
                  {fieldErrors['nominal']}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor="inspection-lower-tolerance">
                下允许偏差（mm，≥0）
              </label>
              <input
                id="inspection-lower-tolerance"
                inputMode="decimal"
                value={lowerTolerance}
                onChange={(e) => setLowerTolerance(e.target.value)}
                aria-invalid={Boolean(fieldErrors['lower_tolerance'])}
                aria-describedby={
                  fieldErrors['lower_tolerance']
                    ? 'error-inspection-lower-tolerance'
                    : undefined
                }
              />
              {fieldErrors['lower_tolerance'] && (
                <p
                  className="error"
                  id="error-inspection-lower-tolerance"
                  role="alert"
                >
                  {fieldErrors['lower_tolerance']}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor="inspection-upper-tolerance">
                上允许偏差（mm，≥0）
              </label>
              <input
                id="inspection-upper-tolerance"
                inputMode="decimal"
                value={upperTolerance}
                onChange={(e) => setUpperTolerance(e.target.value)}
                aria-invalid={Boolean(fieldErrors['upper_tolerance'])}
                aria-describedby={
                  fieldErrors['upper_tolerance']
                    ? 'error-inspection-upper-tolerance'
                    : undefined
                }
              />
              {fieldErrors['upper_tolerance'] && (
                <p
                  className="error"
                  id="error-inspection-upper-tolerance"
                  role="alert"
                >
                  {fieldErrors['upper_tolerance']}
                </p>
              )}
            </div>
          </div>
        </section>

        <section aria-label="实测值输入">
          <h2>板厚实测值（至少 3 次，当前 {measurements.length} 次）</h2>
          <div className="segments">
            {measurements.map((value, i) => (
              <div className="field" key={i}>
                <label htmlFor={`measurement-${i}`}>实测值 {i + 1}（mm）</label>
                <input
                  id={`measurement-${i}`}
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => updateMeasurement(i, e.target.value)}
                  aria-invalid={Boolean(measurementError(i))}
                  aria-describedby={
                    measurementError(i) ? `error-measurement-${i}` : undefined
                  }
                />
                {measurementError(i) && (
                  <p className="error" id={`error-measurement-${i}`} role="alert">
                    {measurementError(i)}
                  </p>
                )}
                {measurements.length > 3 && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => removeMeasurement(i)}
                  >
                    删除该次
                  </button>
                )}
              </div>
            ))}
          </div>
          {fieldErrors['measurements'] && (
            <p className="error" role="alert" data-testid="error-measurements">
              {fieldErrors['measurements']}
            </p>
          )}
          <button type="button" className="secondary" onClick={addMeasurement}>
            + 添加一次实测
          </button>
        </section>

        <div className="actions">
          <button type="submit" disabled={submitting}>
            {submitting ? '登记中…' : '登记抽检'}
          </button>
        </div>
      </form>

      {generalError && (
        <p className="error general" role="alert" data-testid="inspection-general-error">
          {generalError}
        </p>
      )}

      <section aria-label="最近抽检记录" className="result">
        <h2>最近抽检记录</h2>
        {listError && (
          <p className="error general" role="alert" data-testid="inspection-list-error">
            {listError}
          </p>
        )}
        {!listError && records.length === 0 && (
          <p className="hint" data-testid="inspection-empty">
            暂无抽检记录
          </p>
        )}
        {records.map((r) => (
          <article
            className={`inspection-record ${r.passed ? 'passed' : 'failed'}`}
            key={r.batch_no}
            data-testid={`inspection-record-${r.batch_no}`}
          >
            <header>
              <strong>{r.batch_no}</strong>
              <span>{r.material}</span>
              <span
                className={`verdict ${r.passed ? 'passed' : 'failed'}`}
                data-testid={`inspection-verdict-${r.batch_no}`}
              >
                {r.passed ? '合格' : '不合格'}
              </span>
              <time>{r.created_at}</time>
            </header>
            <p className="range">
              标称 {r.nominal} mm，允许偏差 −{r.lower_tolerance} / +
              {r.upper_tolerance}，合格区间 [{r.lower_bound}, {r.upper_bound}] mm
            </p>
            <table className="detail-table">
              <thead>
                <tr>
                  <th>次数</th>
                  <th>实测值（mm）</th>
                  <th>偏差（mm）</th>
                  <th>判定</th>
                </tr>
              </thead>
              <tbody>
                {r.measurements.map((m) => (
                  <tr
                    key={m.index}
                    data-testid={`inspection-measurement-${r.batch_no}-${m.index}`}
                  >
                    <td>第 {m.index} 次</td>
                    <td>{m.value}</td>
                    <td>{m.deviation}</td>
                    <td>{DIRECTION_LABEL[m.direction] ?? m.direction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        ))}
      </section>
    </>
  );
}
