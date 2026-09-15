"""抽检判定核心测试：闭区间边界值、逐项偏差与越界方向。"""
from decimal import Decimal

from app.inspection import judge_inspection

D = Decimal


def judge(measurements, nominal="2.0", lower="0.05", upper="0.05"):
    return judge_inspection(
        batch_no="LOT-T",
        material="SPCC",
        nominal=D(nominal),
        lower_tolerance=D(lower),
        upper_tolerance=D(upper),
        measurements=[D(m) for m in measurements],
    )


def test_closed_interval_bounds():
    """合格区间 = [标称 − 下偏差, 标称 + 上偏差]（闭区间）。"""
    v = judge(["2.0", "2.0", "2.0"])
    assert v.lower_bound == D("1.95")
    assert v.upper_bound == D("2.05")


def test_values_exactly_on_bounds_pass():
    """边界值：恰等于下界 / 标称 / 上界，全部判为合格。"""
    v = judge(["1.95", "2.0", "2.05"])
    assert v.passed is True
    assert [m.within for m in v.measurements] == [True, True, True]
    assert [m.direction for m in v.measurements] == ["within"] * 3


def test_just_below_lower_bound_fails():
    """低于下界一个最小刻度 → 不合格，方向 below。"""
    v = judge(["1.949999", "2.0", "2.0"])
    assert v.passed is False
    m = v.measurements[0]
    assert m.within is False
    assert m.direction == "below"
    assert m.deviation == D("-0.050001")
    # 其余两项不受影响
    assert [x.within for x in v.measurements[1:]] == [True, True]


def test_just_above_upper_bound_fails():
    """高于上界一个最小刻度 → 不合格，方向 above。"""
    v = judge(["2.0", "2.0", "2.050001"])
    assert v.passed is False
    m = v.measurements[2]
    assert m.within is False
    assert m.direction == "above"
    assert m.deviation == D("0.050001")


def test_deviation_is_signed_difference_from_nominal():
    """逐项偏差 = 实测值 − 标称板厚（带符号，精确十进制）。"""
    v = judge(["1.98", "2.0", "2.03"])
    assert [m.deviation for m in v.measurements] == [
        D("-0.02"),
        D("0"),
        D("0.03"),
    ]


def test_all_measurements_must_pass():
    """只要有一项越界，整批判定为不合格。"""
    v = judge(["1.95", "2.0", "2.06"])
    assert v.passed is False
    assert [m.direction for m in v.measurements] == ["within", "within", "above"]


def test_asymmetric_tolerances():
    """上下允许偏差可以不同：区间 [1.98, 2.10]。"""
    v = judge(["1.98", "2.09", "2.10"], lower="0.02", upper="0.10")
    assert v.lower_bound == D("1.98")
    assert v.upper_bound == D("2.10")
    assert v.passed is True
    v2 = judge(["1.97", "2.0", "2.0"], lower="0.02", upper="0.10")
    assert v2.passed is False
    assert v2.measurements[0].direction == "below"


def test_zero_tolerances_only_exact_nominal_passes():
    """零偏差：只有实测恰等于标称才合格。"""
    v = judge(["2.0", "2.0", "2.0"], lower="0", upper="0")
    assert v.passed is True
    v2 = judge(["2.0", "2.0001", "2.0"], lower="0", upper="0")
    assert v2.passed is False
    assert v2.measurements[1].direction == "above"


def test_decimal_exactness_no_float_noise():
    """0.1 级十进制边界：2.1 − 0.1 = 2.0 精确成立，不经 float。"""
    v = judge(["2.0", "2.0", "2.0"], nominal="2.1", lower="0.1", upper="0.1")
    assert v.lower_bound == D("2.0")
    assert v.upper_bound == D("2.2")
    assert v.passed is True
    assert [m.deviation for m in v.measurements] == [D("-0.1")] * 3


def test_measurement_indices_start_at_one():
    v = judge(["2.0", "2.01", "2.02"])
    assert [m.index for m in v.measurements] == [1, 2, 3]
