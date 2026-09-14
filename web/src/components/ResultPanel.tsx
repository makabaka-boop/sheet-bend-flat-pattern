import type { CalcResult } from '../types';

interface Props {
  result: CalcResult;
}

/** 展示最近一次合法计算的结果：逐道代入值、未舍入总长、唯一下料长度。 */
export default function ResultPanel({ result }: Props) {
  return (
    <section className="result" aria-label="计算结果" data-testid="result-panel">
      <h2>复核结果</h2>
      <table className="detail-table">
        <thead>
          <tr>
            <th>道次</th>
            <th>角度（°）</th>
            <th>板厚（mm）</th>
            <th>内半径（mm）</th>
            <th>K 因子</th>
            <th>内半径+K×板厚</th>
            <th>补偿量（六位）</th>
          </tr>
        </thead>
        <tbody>
          {result.bends.map((b) => (
            <tr key={b.index} data-testid={`bend-row-${b.index}`}>
              <td>第 {b.index} 道</td>
              <td>{b.angle}</td>
              <td>{b.thickness}</td>
              <td>{b.inner_radius}</td>
              <td>{b.k_factor}</td>
              <td data-testid={`bend-rkt-${b.index}`}>{b.inner_radius_plus_kt}</td>
              <td data-testid={`bend-allowance-${b.index}`}>{b.allowance}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="totals">
        <div>
          <dt>直段合计（mm）</dt>
          <dd data-testid="segments-total">{result.segments_total}</dd>
        </div>
        <div>
          <dt>补偿量合计（mm）</dt>
          <dd data-testid="allowances-total">{result.allowances_total}</dd>
        </div>
        <div>
          <dt>未舍入总长（mm）</dt>
          <dd data-testid="unrounded-total">{result.unrounded_total}</dd>
        </div>
      </dl>
      <p className="blank">
        下料长度：
        <strong data-testid="blank-length">{result.blank_length}</strong>
        <span className="unit">mm（ROUND_HALF_UP 保留两位）</span>
      </p>
    </section>
  );
}
