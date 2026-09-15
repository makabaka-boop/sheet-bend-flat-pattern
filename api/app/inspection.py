"""来料板厚抽检判定核心。

判定与展开计算完全独立：抽检结论不写入、也不改变任何展开结果。
合格区间为闭区间 [标称板厚 − 下允许偏差, 标称板厚 + 上允许偏差]，
全部比较使用 Decimal，不经 float。
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Sequence

# 复用展开计算的精确求和（精度随数值跨度自适应，不丢任何输入数字）
from .calculator import _exact_sum

# 越界方向
DIRECTION_WITHIN = "within"  # 区间内（含边界）
DIRECTION_ABOVE = "above"  # 越上界
DIRECTION_BELOW = "below"  # 越下界


@dataclass(frozen=True)
class MeasurementVerdict:
    """单次实测的判定明细。"""

    index: int  # 实测序号，从 1 开始
    value: Decimal  # 实测值
    deviation: Decimal  # 偏差 = 实测值 − 标称板厚（带符号）
    within: bool  # 是否落在闭区间内
    direction: str  # within / above / below


@dataclass(frozen=True)
class InspectionVerdict:
    """一批来料的抽检判定结果。"""

    batch_no: str  # 唯一批次号
    material: str  # 材料牌号
    nominal: Decimal  # 标称板厚
    lower_tolerance: Decimal  # 下允许偏差（≥ 0）
    upper_tolerance: Decimal  # 上允许偏差（≥ 0）
    lower_bound: Decimal  # 合格区间下界 = 标称 − 下允许偏差
    upper_bound: Decimal  # 合格区间上界 = 标称 + 上允许偏差
    measurements: tuple[MeasurementVerdict, ...]
    passed: bool  # 全部实测均在闭区间内才为 True


def judge_inspection(
    batch_no: str,
    material: str,
    nominal: Decimal,
    lower_tolerance: Decimal,
    upper_tolerance: Decimal,
    measurements: Sequence[Decimal],
) -> InspectionVerdict:
    """闭区间判定：下界 ≤ 实测值 ≤ 上界 才算该项合格。

    边界值（恰等于上/下界）判为合格；越界项给出方向：
    实测 > 上界 → above；实测 < 下界 → below。
    全部实测合格，整批才判为合格。
    """
    lower_bound = _exact_sum([nominal, -lower_tolerance])
    upper_bound = _exact_sum([nominal, upper_tolerance])
    verdicts: list[MeasurementVerdict] = []
    for i, value in enumerate(measurements, start=1):
        deviation = _exact_sum([value, -nominal])
        if value < lower_bound:
            within, direction = False, DIRECTION_BELOW
        elif value > upper_bound:
            within, direction = False, DIRECTION_ABOVE
        else:
            within, direction = True, DIRECTION_WITHIN
        verdicts.append(
            MeasurementVerdict(
                index=i,
                value=value,
                deviation=deviation,
                within=within,
                direction=direction,
            )
        )
    return InspectionVerdict(
        batch_no=batch_no,
        material=material,
        nominal=nominal,
        lower_tolerance=lower_tolerance,
        upper_tolerance=upper_tolerance,
        lower_bound=lower_bound,
        upper_bound=upper_bound,
        measurements=tuple(verdicts),
        passed=all(v.within for v in verdicts),
    )
