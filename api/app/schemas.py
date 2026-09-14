"""请求 / 响应模型：字段级校验全部在这里完成。"""
from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, Field, ValidationInfo, field_validator

# 有限正数（直段、板厚）：> 0 且不允许 NaN / Infinity
PositiveFiniteDecimal = Annotated[Decimal, Field(gt=0, allow_inf_nan=False)]


class BendIn(BaseModel):
    """单道折弯输入。"""

    angle: Annotated[Decimal, Field(gt=0, lt=180, allow_inf_nan=False)]
    thickness: PositiveFiniteDecimal
    inner_radius: Annotated[Decimal, Field(ge=0, allow_inf_nan=False)]
    k_factor: Annotated[Decimal, Field(ge=0, le=Decimal("0.5"), allow_inf_nan=False)]


class CalculateRequest(BaseModel):
    """展开复核请求：n 道折弯 + n+1 个直段。"""

    bends: list[BendIn] = Field(min_length=1)
    segments: list[PositiveFiniteDecimal] = Field(min_length=2)

    @field_validator("segments")
    @classmethod
    def segment_count_must_match(
        cls, v: list[Decimal], info: ValidationInfo
    ) -> list[Decimal]:
        bends = info.data.get("bends")
        if bends is not None and len(v) != len(bends) + 1:
            raise ValueError(
                f"直段数量必须等于折弯道数+1：当前 {len(v)} 段，"
                f"折弯 {len(bends)} 道，应为 {len(bends) + 1} 段"
            )
        return v


class BendDetailOut(BaseModel):
    """单道折弯的代入值与补偿量（字符串以避免精度丢失）。"""

    index: int
    angle: str
    thickness: str
    inner_radius: str
    k_factor: str
    inner_radius_plus_kt: str  # 代入值：内半径 + K因子 × 板厚
    allowance: str  # 补偿量，六位小数明细
    allowance_unrounded: str  # 未舍入补偿量


class CalculateResponse(BaseModel):
    bend_count: int
    segment_count: int
    segments: list[str]
    segments_total: str
    bends: list[BendDetailOut]
    allowances_total: str
    unrounded_total: str  # 未舍入总长
    blank_length: str  # 唯一的下料长度（ROUND_HALF_UP 两位）
