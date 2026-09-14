"""FastAPI 入口：展开复核台 API。"""
from __future__ import annotations

from decimal import Decimal, localcontext

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .calculator import BendInput, calculate
from .schemas import (
    BendDetailOut,
    CalculateRequest,
    CalculateResponse,
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
