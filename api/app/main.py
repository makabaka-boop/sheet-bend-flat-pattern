"""FastAPI 入口：展开复核台 API。"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from typing import Annotated

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .calculator import BendInput, calculate
from .inspection import InspectionVerdict, judge_inspection
from .repository import (
    DuplicateBatchError,
    InspectionRecord,
    InspectionRepository,
    default_db_path,
)
from .schemas import (
    BendDetailOut,
    CalculateRequest,
    CalculateResponse,
    InspectionCreateRequest,
    InspectionResponse,
    MeasurementVerdictOut,
)

app = FastAPI(title="折弯展开复核台 API", version="1.0.0")

# 开发期前端（Vite）与 API 分端口运行，放开 CORS；生产由 nginx 反代同源访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def dec_str(d: Decimal) -> str:
    """Decimal → 十进制字符串，去掉无意义的尾随零，不使用科学计数法。

    normalize 会按当前上下文精度舍入，这里把精度调到系数实际位数，
    保证任意大的有限数都原样输出、不丢有效数字。
    """
    with localcontext() as ctx:
        ctx.prec = max(28, len(d.as_tuple().digits))
        return format(d.normalize(), "f")


def fixed_str(d: Decimal) -> str:
    """已 quantize 的 Decimal → 定点字符串（保留全部小数位，如 0.20）。"""
    return format(d, "f")


def raw_str(d: Decimal) -> str:
    """Decimal → 原始十进制文本：保留输入的系数与精度（如 2.00），不 normalize。"""
    return format(d, "f")


def _translate_error(err: dict) -> str:
    """把 Pydantic 错误翻译成面向复核员的中文提示。"""
    etype = err.get("type", "")
    ctx = err.get("ctx") or {}
    if etype == "missing":
        return "必填字段缺失"
    if etype == "greater_than":
        return f"必须大于 {ctx.get('gt')}"
    if etype == "greater_than_equal":
        return f"必须大于等于 {ctx.get('ge')}"
    if etype == "less_than":
        return f"必须小于 {ctx.get('lt')}"
    if etype == "less_than_equal":
        return f"必须小于等于 {ctx.get('le')}"
    if etype == "too_short":
        return f"数量不足：至少需要 {ctx.get('min_length')} 项"
    if etype == "string_too_short":
        if ctx.get("min_length") == 1:
            return "不能为空"
        return f"长度不足：至少需要 {ctx.get('min_length')} 个字符"
    if etype == "string_too_long":
        return f"长度超限：最多 {ctx.get('max_length')} 个字符"
    if etype == "finite_number":
        return "必须为有限数值（不允许 NaN 或 Infinity）"
    if etype in ("decimal_parsing", "decimal_type", "float_parsing", "int_parsing"):
        return "必须为数字"
    if etype in ("list_type",):
        return "必须为数组"
    msg = err.get("msg", "参数不合法")
    # Pydantic 会在自定义 ValueError 前加 "Value error, " 前缀
    return msg.removeprefix("Value error, ")


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """统一返回字段级错误：field 形如 segments.0 / bends.1.angle。"""
    details = []
    for err in exc.errors():
        loc = [str(part) for part in err.get("loc", ()) if part != "body"]
        details.append(
            {
                "field": ".".join(loc) if loc else "body",
                "message": _translate_error(err),
                "type": err.get("type", ""),
            }
        )
    return JSONResponse(status_code=422, content={"detail": details})


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/calculate", response_model=CalculateResponse)
def calculate_endpoint(req: CalculateRequest) -> CalculateResponse:
    bends_in = [
        BendInput(
            angle=b.angle,
            thickness=b.thickness,
            inner_radius=b.inner_radius,
            k_factor=b.k_factor,
        )
        for b in req.bends
    ]
    # 任意大的有限数都能算出结果（舍入精度随数值量级自适应）
    result = calculate(req.segments, bends_in)
    return CalculateResponse(
        bend_count=len(result.bends),
        segment_count=len(result.segments),
        segments=[dec_str(s) for s in result.segments],
        segments_total=dec_str(result.segments_total),
        bends=[
            BendDetailOut(
                index=d.index,
                angle=dec_str(d.angle),
                thickness=dec_str(d.thickness),
                inner_radius=dec_str(d.inner_radius),
                k_factor=dec_str(d.k_factor),
                inner_radius_plus_kt=dec_str(d.inner_radius_plus_kt),
                allowance=fixed_str(d.allowance_6dp),
                allowance_unrounded=dec_str(d.allowance),
            )
            for d in result.bends
        ],
        allowances_total=dec_str(result.allowances_total),
        unrounded_total=dec_str(result.unrounded_total),
        blank_length=fixed_str(result.blank_length),
    )


# ---------- 来料板厚抽检（独立于展开计算，结论互不影响） ----------

_repository: InspectionRepository | None = None


def get_repository() -> InspectionRepository:
    """抽检仓储单例；测试可用 dependency_overrides 替换为临时库。"""
    global _repository
    if _repository is None:
        _repository = InspectionRepository(default_db_path())
    return _repository


RepoDep = Annotated[InspectionRepository, Depends(get_repository)]


def _persist_text(raw_text: dict, key: str, parsed: Decimal) -> str:
    """落库文本：字符串形式的填写原文逐字保留；非字符串输入回退为十进制文本。"""
    text = raw_text.get(key)
    return text if isinstance(text, str) else raw_str(parsed)


def _persist_measurement_texts(req: InspectionCreateRequest) -> tuple[str, ...]:
    """各次实测的落库文本：逐项保留填写原文，非字符串输入回退为十进制文本。"""
    raw_list = req.raw_text.get("measurements")
    if not isinstance(raw_list, list):
        raw_list = []
    texts: list[str] = []
    for i, parsed in enumerate(req.measurements):
        text = raw_list[i] if i < len(raw_list) else None
        texts.append(text if isinstance(text, str) else raw_str(parsed))
    return tuple(texts)


def _verdict_snapshot(
    verdict: InspectionVerdict, measurement_texts: tuple[str, ...]
) -> dict:
    """判定快照：合格区间与逐项偏差、越界方向；实测值按填写原文记录。"""
    return {
        "lower_bound": raw_str(verdict.lower_bound),
        "upper_bound": raw_str(verdict.upper_bound),
        "measurements": [
            {
                "index": m.index,
                "value": measurement_texts[i],
                "deviation": raw_str(m.deviation),
                "within": m.within,
                "direction": m.direction,
            }
            for i, m in enumerate(verdict.measurements)
        ],
    }


def _record_response(record: InspectionRecord) -> InspectionResponse:
    snapshot = json.loads(record.verdict)
    return InspectionResponse(
        batch_no=record.batch_no,
        material=record.material,
        nominal=record.nominal,
        lower_tolerance=record.lower_tolerance,
        upper_tolerance=record.upper_tolerance,
        lower_bound=snapshot["lower_bound"],
        upper_bound=snapshot["upper_bound"],
        measurements=[MeasurementVerdictOut(**m) for m in snapshot["measurements"]],
        passed=record.passed,
        created_at=record.created_at,
    )


@app.post("/api/inspections", status_code=201, response_model=InspectionResponse)
def create_inspection(
    req: InspectionCreateRequest, repo: RepoDep
) -> InspectionResponse | JSONResponse:
    """登记一批来料抽检：判定落库（vinfy 卷），批次号重复返回 409。"""
    verdict = judge_inspection(
        batch_no=req.batch_no,
        material=req.material,
        nominal=req.nominal,
        lower_tolerance=req.lower_tolerance,
        upper_tolerance=req.upper_tolerance,
        measurements=req.measurements,
    )
    # 判定按解析后的数值进行；落库按填写原文（前导零、指数写法逐字保留）
    measurement_texts = _persist_measurement_texts(req)
    record = InspectionRecord(
        batch_no=req.batch_no,
        material=req.material,
        nominal=_persist_text(req.raw_text, "nominal", req.nominal),
        lower_tolerance=_persist_text(
            req.raw_text, "lower_tolerance", req.lower_tolerance
        ),
        upper_tolerance=_persist_text(
            req.raw_text, "upper_tolerance", req.upper_tolerance
        ),
        measurements=measurement_texts,
        passed=verdict.passed,
        verdict=json.dumps(
            _verdict_snapshot(verdict, measurement_texts), ensure_ascii=False
        ),
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    try:
        repo.insert(record)
    except DuplicateBatchError:
        # 重复批次：不覆盖原记录，错误定位到批次号字段
        return JSONResponse(
            status_code=409,
            content={
                "detail": [
                    {
                        "field": "batch_no",
                        "message": f"批次号 {req.batch_no} 已存在，不得重复登记",
                        "type": "duplicate_batch",
                    }
                ]
            },
        )
    return _record_response(record)


@app.get("/api/inspections/recent", response_model=list[InspectionResponse])
def recent_inspections(repo: RepoDep, limit: int = 10) -> list[InspectionResponse]:
    """最近登记的抽检记录，新的在前。"""
    return [_record_response(r) for r in repo.recent(limit)]
