"""折弯展开（下料长度）计算核心。

全部中间计算使用 Decimal，禁止 float 参与，避免二进制浮点误差。
补偿量公式：BA = π ÷ 180 × 角度 × (内半径 + K因子 × 板厚)
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP, localcontext
from typing import Sequence

# 高精度 π（60 位有效数字），保证六位明细与两位下料长度的舍入稳定
PI = Decimal(
    "3.141592653589793238462643383279502884197169399375105820974944592"
)

# 中间计算精度（有效数字位数）
CALC_PRECISION = 50

# 明细（每道补偿量）保留六位小数
DETAIL_QUANTUM = Decimal("0.000001")
# 最终下料长度保留两位小数，ROUND_HALF_UP
BLANK_QUANTUM = Decimal("0.01")


@dataclass(frozen=True)
class BendInput:
    """单道折弯的输入参数。"""

    angle: Decimal  # 折弯角度，单位度，0 < 角度 < 180
    thickness: Decimal  # 板厚，单位 mm，> 0
    inner_radius: Decimal  # 内半径，单位 mm，>= 0
    k_factor: Decimal  # K 因子，0 <= K <= 0.5


@dataclass(frozen=True)
class BendDetail:
    """单道折弯的代入值与补偿量明细。"""

    index: int  # 加工顺序，从 1 开始
    angle: Decimal
    thickness: Decimal
    inner_radius: Decimal
    k_factor: Decimal
    inner_radius_plus_kt: Decimal  # 代入值：内半径 + K因子 × 板厚
    allowance: Decimal  # 未舍入补偿量
    allowance_6dp: Decimal  # 六位小数明细


@dataclass(frozen=True)
class CalculationResult:
    """展开计算结果。"""

    segments: tuple[Decimal, ...]  # 各直段长度（切点间直段，共 n+1 段）
    segments_total: Decimal  # 直段合计
    allowances_total: Decimal  # 补偿量合计（未舍入）
    unrounded_total: Decimal  # 未舍入总长 = 全部直段 + 全部补偿量
    blank_length: Decimal  # 下料长度：未舍入总长按 ROUND_HALF_UP 保留两位
    bends: tuple[BendDetail, ...]


def bend_allowance(
    angle: Decimal, inner_radius: Decimal, k_factor: Decimal, thickness: Decimal
) -> Decimal:
    """补偿量 = π ÷ 180 × 角度 × (内半径 + K因子 × 板厚)。"""
    with localcontext() as ctx:
        ctx.prec = CALC_PRECISION
        return +(PI / 180 * angle * (inner_radius + k_factor * thickness))


def _quantize_half_up(value: Decimal, quantum: Decimal) -> Decimal:
    """把 value 按 ROUND_HALF_UP 舍入到 quantum。

    quantize 要求上下文精度不小于结果系数的位数；这里按数值量级
    自适应提升精度，因此任意大的有限数都能正常舍入，不会被拒绝。
    """
    with localcontext() as ctx:
        ctx.prec = max(
            CALC_PRECISION, value.adjusted() - quantum.as_tuple().exponent + 1
        )
        return value.quantize(quantum, rounding=ROUND_HALF_UP)


def calculate(
    segments: Sequence[Decimal], bends: Sequence[BendInput]
) -> CalculationResult:
    """计算展开总长与下料长度。

    - segments：n+1 个切点间直段长度（mm）
    - bends：按加工顺序的 n 道折弯
    返回未舍入总长与唯一的下料长度（ROUND_HALF_UP 保留两位）。
    """
    with localcontext() as ctx:
        ctx.prec = CALC_PRECISION
        details: list[BendDetail] = []
        for i, b in enumerate(bends, start=1):
            inner_plus_kt = +(b.inner_radius + b.k_factor * b.thickness)
            allowance = +(PI / 180 * b.angle * inner_plus_kt)
            details.append(
                BendDetail(
                    index=i,
                    angle=b.angle,
                    thickness=b.thickness,
                    inner_radius=b.inner_radius,
                    k_factor=b.k_factor,
                    inner_radius_plus_kt=inner_plus_kt,
                    allowance=allowance,
                    allowance_6dp=_quantize_half_up(allowance, DETAIL_QUANTUM),
                )
            )
        segments_total = +sum(segments, Decimal("0"))
        allowances_total = +sum((d.allowance for d in details), Decimal("0"))
        unrounded_total = +(segments_total + allowances_total)
        blank_length = _quantize_half_up(unrounded_total, BLANK_QUANTUM)
        return CalculationResult(
            segments=tuple(segments),
            segments_total=segments_total,
            allowances_total=allowances_total,
            unrounded_total=unrounded_total,
            blank_length=blank_length,
            bends=tuple(details),
        )
