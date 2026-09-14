"""API 测试：合法计算与各类字段级错误。"""
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

VALID_PAYLOAD = {
    "segments": [100, 50],
    "bends": [
        {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": 0.33}
    ],
}


def post(payload):
    return client.post("/api/calculate", json=payload)


def post_raw(body: str):
    return client.post(
        "/api/calculate",
        content=body,
        headers={"Content-Type": "application/json"},
    )


def fields(resp):
    return [e["field"] for e in resp.json()["detail"]]


def test_valid_request_returns_full_result():
    resp = post(VALID_PAYLOAD)
    assert resp.status_code == 200
    data = resp.json()
    assert data["bend_count"] == 1
    assert data["segment_count"] == 2
    assert data["segments"] == ["100", "50"]
    assert data["segments_total"] == "150"
    assert data["blank_length"] == "155.75"
    assert data["unrounded_total"].startswith("155.7491145560693")
    bend = data["bends"][0]
    assert bend["index"] == 1
    assert bend["angle"] == "90"
    assert bend["thickness"] == "2"
    assert bend["inner_radius"] == "3"
    assert bend["k_factor"] == "0.33"
    assert bend["inner_radius_plus_kt"] == "3.66"
    assert bend["allowance"] == "5.749115"
    assert bend["allowance_unrounded"].startswith("5.7491145560693")


def test_string_numbers_accepted():
    resp = post(
        {
            "segments": ["100.5", "50"],
            "bends": [
                {"angle": "90", "thickness": "2", "inner_radius": "3", "k_factor": "0.33"}
            ],
        }
    )
    assert resp.status_code == 200
    assert resp.json()["segments_total"] == "150.5"


def test_decimal_exactness_no_float_noise():
    resp = post(
        {
            "segments": [0.1, 0.2],
            "bends": [{"angle": 90, "thickness": 2, "inner_radius": 0, "k_factor": 0}],
        }
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["segments_total"] == "0.3"
    assert data["unrounded_total"] == "0.3"
    assert data["blank_length"] == "0.30"


def test_segment_count_mismatch():
    resp = post({**VALID_PAYLOAD, "segments": [100, 50, 30]})
    assert resp.status_code == 422
    assert "segments" in fields(resp)
    msgs = [e["message"] for e in resp.json()["detail"] if e["field"] == "segments"]
    assert any("折弯" in m and "直段" in m for m in msgs)


def test_segment_count_too_few():
    resp = post({**VALID_PAYLOAD, "segments": [100]})
    assert resp.status_code == 422
    assert "segments" in fields(resp)


def test_zero_bends_rejected():
    resp = post({"segments": [100, 50], "bends": []})
    assert resp.status_code == 422
    assert "bends" in fields(resp)


@pytest.mark.parametrize(
    "segments,bad_field",
    [
        ([0, 50], "segments.0"),
        ([100, -1], "segments.1"),
        ([-0.0001, 50], "segments.0"),
    ],
)
def test_non_positive_segments_rejected(segments, bad_field):
    resp = post({**VALID_PAYLOAD, "segments": segments})
    assert resp.status_code == 422
    assert bad_field in fields(resp)


@pytest.mark.parametrize("angle", [0, -10, 180, 181])
def test_angle_out_of_range(angle):
    payload = {
        "segments": [100, 50],
        "bends": [{"angle": angle, "thickness": 2, "inner_radius": 3, "k_factor": 0.33}],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert "bends.0.angle" in fields(resp)


@pytest.mark.parametrize("thickness", [0, -0.5])
def test_thickness_must_be_positive(thickness):
    payload = {
        "segments": [100, 50],
        "bends": [
            {"angle": 90, "thickness": thickness, "inner_radius": 3, "k_factor": 0.33}
        ],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert "bends.0.thickness" in fields(resp)


def test_inner_radius_negative_rejected():
    payload = {
        "segments": [100, 50],
        "bends": [{"angle": 90, "thickness": 2, "inner_radius": -0.1, "k_factor": 0.33}],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert "bends.0.inner_radius" in fields(resp)


def test_inner_radius_zero_allowed():
    payload = {
        "segments": [100, 50],
        "bends": [{"angle": 90, "thickness": 2, "inner_radius": 0, "k_factor": 0.33}],
    }
    assert post(payload).status_code == 200


@pytest.mark.parametrize("k_factor", [-0.01, 0.51, 1])
def test_k_factor_out_of_range(k_factor):
    payload = {
        "segments": [100, 50],
        "bends": [
            {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": k_factor}
        ],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert "bends.0.k_factor" in fields(resp)


@pytest.mark.parametrize("k_factor", [0, 0.5])
def test_k_factor_boundaries_allowed(k_factor):
    payload = {
        "segments": [100, 50],
        "bends": [
            {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": k_factor}
        ],
    }
    assert post(payload).status_code == 200


def test_nan_rejected_as_non_finite():
    body = json.dumps(VALID_PAYLOAD).replace("100", "NaN", 1)
    resp = post_raw(body)
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert any(e["field"] == "segments.0" and "有限" in e["message"] for e in detail)


def test_infinity_rejected_as_non_finite():
    body = json.dumps(VALID_PAYLOAD).replace("90", "Infinity", 1)
    resp = post_raw(body)
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert any(e["field"] == "bends.0.angle" and "有限" in e["message"] for e in detail)


def test_non_numeric_rejected():
    resp = post({**VALID_PAYLOAD, "segments": ["abc", 50]})
    assert resp.status_code == 422
    assert "segments.0" in fields(resp)


def test_missing_bends_field():
    resp = post({"segments": [100, 50]})
    assert resp.status_code == 422
    assert "bends" in fields(resp)


def test_multiple_errors_reported_per_field():
    payload = {
        "segments": [0, -5],
        "bends": [{"angle": 200, "thickness": 0, "inner_radius": 3, "k_factor": 0.9}],
    }
    resp = post(payload)
    assert resp.status_code == 422
    got = fields(resp)
    for expected in [
        "segments.0",
        "segments.1",
        "bends.0.angle",
        "bends.0.thickness",
        "bends.0.k_factor",
    ]:
        assert expected in got


def test_second_bend_error_has_correct_index():
    payload = {
        "segments": [100, 50, 30],
        "bends": [
            {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": 0.33},
            {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": 0.6},
        ],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert "bends.1.k_factor" in fields(resp)


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_huge_finite_segment_accepted():
    """超大但有限的直段（文本框输入以字符串到达）必须返回下料长度。"""
    resp = post(
        {
            "segments": ["1e30", 1],
            "bends": [
                {"angle": 90, "thickness": 2, "inner_radius": 0, "k_factor": 0}
            ],
        }
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["blank_length"] == "1" + "0" * 29 + "1.00"
    assert data["unrounded_total"] == "1" + "0" * 29 + "1"


def test_astronomical_finite_segment_plus_1mm_preserved():
    """1e999 毫米直段加 1 毫米：1 毫米必须保留，不得 422 也不得丢。"""
    resp = post(
        {
            "segments": ["1e999", "1"],
            "bends": [
                {"angle": 90, "thickness": 2, "inner_radius": 0, "k_factor": 0}
            ],
        }
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["segments_total"] == "1" + "0" * 998 + "1"
    assert data["unrounded_total"] == "1" + "0" * 998 + "1"
    assert data["blank_length"] == "1" + "0" * 998 + "1.00"


def test_huge_finite_segment_with_allowance():
    """超大直段 + 正常补偿量：下料长度 = 大数 + 补偿量，两位舍入正常。"""
    resp = post(
        {
            "segments": ["1e30", 1],
            "bends": [
                {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": 0.33}
            ],
        }
    )
    assert resp.status_code == 200
    data = resp.json()
    # 1e30 + 1 + 5.749114556... → ...006.75（ROUND_HALF_UP）
    assert data["blank_length"] == "1" + "0" * 29 + "6.75"
    assert data["bends"][0]["allowance"] == "5.749115"


def test_astronomical_segment_with_allowance_tail_preserved():
    """1e999 直段 + 1 毫米 + 补偿量 5.749...：尾部全部保留。"""
    resp = post(
        {
            "segments": ["1e999", "1"],
            "bends": [
                {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": 0.33}
            ],
        }
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["blank_length"] == "1" + "0" * 998 + "6.75"
    assert data["bends"][0]["inner_radius_plus_kt"] == "3.66"
