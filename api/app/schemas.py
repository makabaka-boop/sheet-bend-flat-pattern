"""请求 / 响应模型：字段级校验全部在这里完成。"""
from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any

from pydantic import (
    BaseModel,
    Field,
    StringConstraints,
    ValidationInfo,
    field_validator,
    model_validator,
)

# 有限正数（直段、板厚）：> 0 且不允许 NaN / Infinity
PositiveFiniteDecimal = Annotated[Decimal, Field(gt=0, allow_inf_nan=False)]

# 有限十进制数（实测值）：允许越界读数参与判定，只拒绝 NaN / Infinity
FiniteDecimal = Annotated[Decimal, Field(allow_inf_nan=False)]

# 非负有限十进制数（允许偏差）
NonNegativeFiniteDecimal = Annotated[Decimal, Field(ge=0, allow_inf_nan=False)]

# 非空文本（批次号、材料牌号）：去首尾空白后至少 1 个字符
NonEmptyText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)
]


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


# ---------- 来料板厚抽检（独立于展开计算） ----------


class InspectionCreateRequest(BaseModel):
    """来料抽检登记：唯一批次 + 标称板厚 + 上下允许偏差 + 至少三次实测。"""

    batch_no: NonEmptyText  # 唯一批次号
    material: NonEmptyText  # 材料牌号
    nominal: PositiveFiniteDecimal  # 标称板厚，> 0
    lower_tolerance: NonNegativeFiniteDecimal  # 下允许偏差，≥ 0
    upper_tolerance: NonNegativeFiniteDecimal  # 上允许偏差，≥ 0
    measurements: list[FiniteDecimal] = Field(min_length=3)  # 至少三次实测
    # 填写原文快照（前导零、指数写法等逐字保留），仅供持久化原样落库，
    # 不参与判定，也不出现在任何响应中
    raw_text: dict[str, Any] = Field(default_factory=dict, exclude=True)

    @model_validator(mode="before")
    @classmethod
    def snapshot_raw_text(cls, data: Any) -> Any:
        """快照字符串形式的填写原文（前端文本框始终以字符串提交）。

        JSON 数字的写法在 JSON 解析阶段已丢失，无法快照；落库时
        对非字符串输入回退为解析后的十进制文本。
        """
        if not isinstance(data, dict):
            return data
        raw: dict[str, Any] = {}
        for key in ("nominal", "lower_tolerance", "upper_tolerance"):
            value = data.get(key)
            if isinstance(value, str):
                raw[key] = value
        measurements = data.get("measurements")
        if isinstance(measurements, list):
            raw["measurements"] = [
                item if isinstance(item, str) else None for item in measurements
            ]
        return {**data, "raw_text": raw}


class MeasurementVerdictOut(BaseModel):
    """单次实测的判定明细（字符串以避免精度丢失）。"""

    index: int  # 实测序号，从 1 开始
    value: str  # 实测值
    deviation: str  # 偏差 = 实测值 − 标称板厚（带符号）
    within: bool  # 是否落在闭区间内
    direction: str  # within 区间内 / above 越上界 / below 越下界


class InspectionResponse(BaseModel):
    batch_no: str
    material: str
    nominal: str
    lower_tolerance: str
    upper_tolerance: str
    lower_bound: str  # 合格区间下界（闭区间）
    upper_bound: str  # 合格区间上界（闭区间）
    measurements: list[MeasurementVerdictOut]
    passed: bool  # 全部实测均在闭区间内才为 True
    created_at: str  # 登记时间（ISO 8601，UTC）
