"""计算核心测试：公式、精度、舍入规则。"""
from decimal import Decimal, localcontext

from app.calculator import PI, BendInput, bend_allowance, calculate

D = Decimal


def make_bend(angle="90", thickness="2", inner_radius="3", k_factor="0.33"):
    return BendInput(D(angle), D(thickness), D(inner_radius), D(k_factor))


def test_allowance_formula_known_value():
    """BA = π÷180 × 角度 × (内半径 + K×板厚)，90°/r=3/K=0.33/t=2 → π/2 × 3.66。"""
    with localcontext() as ctx:
        ctx.prec = 50
        expected = +(PI / 180 * D("90") * (D("3") + D("0.33") * D("2")))
    assert bend_allowance(D("90"), D("3"), D("0.33"), D("2")) == expected
    # 参考值：5.7491145560693...
    assert str(expected).startswith("5.7491145560693")


def test_detail_six_decimals_rounds_half_up():
    """明细保留六位：第 7 位 >= 5 进位，否则舍去。"""
    res = calculate([D("100"), D("50")], [make_bend()])
    # 未舍入 5.7491145560693... → 六位明细 5.749115
    assert res.bends[0].allowance_6dp == D("5.749115")
    # π/4 = 0.7853981633974483... → 六位明细 0.785398（第 7 位为 1，舍去）
    res2 = calculate([D("1"), D("1")], [make_bend("45", "1", "1", "0")])
    assert res2.bends[0].allowance_6dp == D("0.785398")


def test_substituted_value_inner_radius_plus_kt():
    """逐道代入值：内半径 + K×板厚。"""
    res = calculate([D("100"), D("50")], [make_bend()])
    assert res.bends[0].inner_radius_plus_kt == D("3.66")


def test_unrounded_total_is_segments_plus_allowances():
    """未舍入总长 = 全部直段 + 全部补偿量（未舍入）。"""
    res = calculate(
        [D("100"), D("50.5"), D("20")],
        [make_bend(), make_bend("60", "1.5", "2", "0.4")],
    )
    assert res.segments_total == D("170.5")
    with localcontext() as ctx:
        ctx.prec = 50
        expected_allowances = +(res.bends[0].allowance + res.bends[1].allowance)
        expected_total = +(res.segments_total + expected_allowances)
    assert res.allowances_total == expected_allowances
    assert res.unrounded_total == expected_total


def test_total_uses_unrounded_allowances_not_six_digit_details():
    """总长必须基于未舍入补偿量，而不是六位明细之和。"""
    # 每道 BA = π/180 ≈ 0.017453292519943...，六位明细为 0.017453
    res = calculate(
        [D("10"), D("10"), D("10")],
        [make_bend("1", "1", "1", "0"), make_bend("1", "1", "1", "0")],
    )
    sum_of_details = sum((b.allowance_6dp for b in res.bends), D("0"))
    assert sum_of_details == D("0.034906")
    assert res.allowances_total != sum_of_details
    assert str(res.allowances_total).startswith("0.034906585039886")


def test_blank_length_round_half_up():
    """仅最终下料长度按 ROUND_HALF_UP 保留两位。"""
    # 补偿量为 0（r=0、K=0），总长 = 直段之和
    res = calculate([D("100.005"), D("1")], [make_bend("90", "2", "0", "0")])
    assert res.unrounded_total == D("101.005")
    assert res.blank_length == D("101.01")  # 五入

    res2 = calculate([D("100.004"), D("1")], [make_bend("90", "2", "0", "0")])
    assert res2.blank_length == D("101.00")  # 四舍

    # 银行家舍入会得到 101.00 的场景：101.015 → ROUND_HALF_UP 必须得 101.02
    res3 = calculate([D("100.015"), D("1")], [make_bend("90", "2", "0", "0")])
    assert res3.blank_length == D("101.02")


def test_zero_allowance_when_radius_and_k_factor_zero():
    """内半径为 0 且 K 为 0 时补偿量为 0。"""
    res = calculate([D("100"), D("50")], [make_bend("90", "2", "0", "0")])
    assert res.bends[0].allowance == 0
    assert res.unrounded_total == D("150")
    assert res.blank_length == D("150.00")


def test_bend_indices_follow_processing_order():
    """明细序号按加工顺序从 1 开始。"""
    res = calculate(
        [D("10"), D("20"), D("30"), D("40")],
        [make_bend(), make_bend("45"), make_bend("120")],
    )
    assert [b.index for b in res.bends] == [1, 2, 3]
    assert len(res.segments) == 4


def test_decimal_no_float_noise():
    """0.1 + 0.2 必须精确等于 0.3（Decimal 计算，无二进制浮点误差）。"""
    res = calculate([D("0.1"), D("0.2")], [make_bend("90", "2", "0", "0")])
    assert res.segments_total == D("0.3")
    assert res.unrounded_total == D("0.3")
    assert res.blank_length == D("0.30")


def test_huge_finite_segment_returns_blank_length():
    """超大但有限的直段必须正常返回下料长度，不得拒绝。"""
    res = calculate([D("1e30"), D("1")], [make_bend("90", "2", "0", "0")])
    # 1e30 + 1 = 1000...001（31 位，精度内精确）
    assert res.unrounded_total == D("1" + "0" * 29 + "1")
    assert format(res.blank_length, "f") == "1" + "0" * 29 + "1.00"


def test_huge_finite_segment_beyond_default_precision():
    """整数位远超 50 位精度的巨大有限直段也能返回下料长度。"""
    res = calculate([D("1e999"), D("1")], [make_bend("90", "2", "0", "0")])
    # 50 位中间精度下 +1 被舍去，总长 ≈ 1e999，下料长度正常给出
    assert format(res.blank_length, "f") == "1" + "0" * 999 + ".00"


def test_huge_inner_radius_allowance_keeps_six_decimals():
    """巨大内半径的补偿量同样能给出六位明细。"""
    res = calculate([D("1"), D("1")], [make_bend("90", "2", "1e60", "0")])
    # BA = π/2 × 1e60 ≈ 1.5707963...e60，六位明细需要 67 位系数
    q = res.bends[0].allowance_6dp
    assert q.as_tuple().exponent == -6
    assert "".join(str(d) for d in q.as_tuple().digits[:8]) == "15707963"
    # 下料长度照常返回
    assert res.blank_length > D("1e60")
