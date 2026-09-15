"""抽检 API 测试：创建、最近记录、重复批次 409、字段级校验与持久化。"""
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app, get_repository
from app.repository import InspectionRepository

VALID_PAYLOAD = {
    "batch_no": "LOT-2026-001",
    "material": "SPCC",
    "nominal": "2.0",
    "lower_tolerance": "0.05",
    "upper_tolerance": "0.05",
    "measurements": ["1.98", "2.0", "2.02"],
}


@pytest.fixture()
def client(tmp_path):
    """每个测试独立 SQLite 库（tmp_path），通过依赖覆盖注入。"""
    repo = InspectionRepository(tmp_path / "inspections.db")
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app) as c:
        yield c, repo
    app.dependency_overrides.clear()


def post(client, payload):
    return client.post("/api/inspections", json=payload)


def fields(resp):
    return [e["field"] for e in resp.json()["detail"]]


def test_create_passed_inspection(client):
    c, _ = client
    resp = post(c, VALID_PAYLOAD)
    assert resp.status_code == 201
    data = resp.json()
    assert data["batch_no"] == "LOT-2026-001"
    assert data["material"] == "SPCC"
    assert data["nominal"] == "2.0"
    assert data["lower_tolerance"] == "0.05"
    assert data["upper_tolerance"] == "0.05"
    assert data["lower_bound"] == "1.95"
    assert data["upper_bound"] == "2.05"
    assert data["passed"] is True
    assert data["created_at"]
    measurements = data["measurements"]
    assert [m["index"] for m in measurements] == [1, 2, 3]
    assert [m["value"] for m in measurements] == ["1.98", "2.0", "2.02"]
    assert [m["deviation"] for m in measurements] == ["-0.02", "0.0", "0.02"]
    assert [m["within"] for m in measurements] == [True, True, True]
    assert [m["direction"] for m in measurements] == ["within"] * 3


def test_create_boundary_values_pass(client):
    """边界值：实测恰等于上下界（闭区间）→ 合格。"""
    c, _ = client
    payload = {**VALID_PAYLOAD, "measurements": ["1.95", "2.05", "2.0"]}
    resp = post(c, payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["passed"] is True
    assert [m["within"] for m in data["measurements"]] == [True, True, True]


def test_create_out_of_bounds_returns_directions(client):
    """越界实测：返回逐项偏差与越界方向（below / above）。"""
    c, _ = client
    payload = {**VALID_PAYLOAD, "measurements": ["1.94", "2.0", "2.06"]}
    resp = post(c, payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["passed"] is False
    measurements = data["measurements"]
    assert [m["direction"] for m in measurements] == ["below", "within", "above"]
    assert [m["deviation"] for m in measurements] == ["-0.06", "0.0", "0.06"]
    assert [m["within"] for m in measurements] == [False, True, False]


def test_duplicate_batch_returns_409_and_keeps_original(client):
    """重复批次：409 且不覆盖原记录；错误定位到 batch_no。"""
    c, repo = client
    assert post(c, VALID_PAYLOAD).status_code == 201
    conflicting = {
        **VALID_PAYLOAD,
        "material": "SUS304",
        "nominal": "3.0",
        "measurements": ["9", "9", "9"],
    }
    resp = post(c, conflicting)
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail[0]["field"] == "batch_no"
    assert "LOT-2026-001" in detail[0]["message"]
    # 原记录未被覆盖：仍是第一次的内容
    records = repo.recent()
    assert len(records) == 1
    assert records[0].material == "SPCC"
    assert records[0].nominal == "2.0"
    assert records[0].measurements == ("1.98", "2.0", "2.02")
    # 通过接口再次确认内容未变
    recent = c.get("/api/inspections/recent").json()
    assert len(recent) == 1
    assert recent[0]["material"] == "SPCC"
    assert recent[0]["passed"] is True


def test_recent_returns_latest_first(client):
    c, _ = client
    for batch_no in ["LOT-A", "LOT-B", "LOT-C"]:
        assert post(c, {**VALID_PAYLOAD, "batch_no": batch_no}).status_code == 201
    resp = c.get("/api/inspections/recent")
    assert resp.status_code == 200
    assert [r["batch_no"] for r in resp.json()] == ["LOT-C", "LOT-B", "LOT-A"]


def test_recent_limit(client):
    c, _ = client
    for i in range(5):
        assert post(c, {**VALID_PAYLOAD, "batch_no": f"LOT-{i}"}).status_code == 201
    resp = c.get("/api/inspections/recent?limit=2")
    assert resp.status_code == 200
    assert [r["batch_no"] for r in resp.json()] == ["LOT-4", "LOT-3"]


def test_recent_empty(client):
    c, _ = client
    resp = c.get("/api/inspections/recent")
    assert resp.status_code == 200
    assert resp.json() == []


def test_record_persisted_as_decimal_text(client, tmp_path):
    """批次、原始十进制文本、判定状态与时间写入 SQLite，重连后仍在。"""
    c, repo = client
    payload = {
        **VALID_PAYLOAD,
        "nominal": "2.00",
        "lower_tolerance": "0.050",
        "upper_tolerance": "0.050",
        "measurements": ["1.980", "2.00", "2.020"],
    }
    assert post(c, payload).status_code == 201
    # 同一库文件重新打开（模拟服务重启），记录仍在且文本原样
    reopened = InspectionRepository(tmp_path / "inspections.db")
    records = reopened.recent()
    assert len(records) == 1
    rec = records[0]
    assert rec.batch_no == "LOT-2026-001"
    assert rec.nominal == "2.00"  # 原始十进制文本，未经 float
    assert rec.lower_tolerance == "0.050"
    assert rec.upper_tolerance == "0.050"
    assert rec.measurements == ("1.980", "2.00", "2.020")
    assert rec.passed is True
    assert rec.created_at
    snapshot = json.loads(rec.verdict)
    assert snapshot["lower_bound"] == "1.950"
    assert snapshot["upper_bound"] == "2.050"
    assert [m["deviation"] for m in snapshot["measurements"]] == [
        "-0.020",
        "0.00",
        "0.020",
    ]


def test_failed_verdict_persisted(client):
    """不合格判定同样落库，判定状态为 False。"""
    c, repo = client
    payload = {**VALID_PAYLOAD, "measurements": ["1.90", "2.0", "2.0"]}
    assert post(c, payload).status_code == 201
    rec = repo.recent()[0]
    assert rec.passed is False


def test_leading_zeros_stored_verbatim(client):
    """前导零写法：判定按数值进行，落库与接口返回均为填写原文。"""
    c, repo = client
    payload = {
        **VALID_PAYLOAD,
        "batch_no": "LOT-ZEROS",
        "nominal": "02.00",
        "lower_tolerance": "00.05",
        "upper_tolerance": "0.050",
        "measurements": ["01.95", "002.00", "2.05"],
    }
    resp = post(c, payload)
    assert resp.status_code == 201
    data = resp.json()
    # 判定按解析后的数值：02.00 = 2，01.95 = 下界（闭区间）→ 合格
    assert data["passed"] is True
    assert data["lower_bound"] == "1.95"
    assert data["upper_bound"] == "2.050"  # 2.00 + 0.050，按操作数精度得 3 位小数
    # 创建响应即为填写原文
    assert data["nominal"] == "02.00"
    assert data["lower_tolerance"] == "00.05"
    assert data["upper_tolerance"] == "0.050"
    assert [m["value"] for m in data["measurements"]] == ["01.95", "002.00", "2.05"]
    # 落库原文
    rec = repo.recent()[0]
    assert rec.nominal == "02.00"
    assert rec.lower_tolerance == "00.05"
    assert rec.upper_tolerance == "0.050"
    assert rec.measurements == ("01.95", "002.00", "2.05")
    # 最近记录接口同样返回原文
    recent = c.get("/api/inspections/recent").json()
    assert recent[0]["nominal"] == "02.00"
    assert recent[0]["lower_tolerance"] == "00.05"
    assert [m["value"] for m in recent[0]["measurements"]] == [
        "01.95",
        "002.00",
        "2.05",
    ]


def test_exponent_notation_stored_verbatim(client):
    """指数写法：判定按数值进行，落库与接口返回均为填写原文。"""
    c, repo = client
    payload = {
        **VALID_PAYLOAD,
        "batch_no": "LOT-EXP",
        "nominal": "2e0",
        "lower_tolerance": "5e-2",
        "upper_tolerance": "0.5e-1",
        "measurements": ["1.95e0", "2.0E0", "0.205e1"],
    }
    resp = post(c, payload)
    assert resp.status_code == 201
    data = resp.json()
    # 2e0 = 2，5e-2 = 0.05，0.205e1 = 2.05 = 上界（闭区间）→ 合格
    assert data["passed"] is True
    assert data["lower_bound"] == "1.95"
    assert data["upper_bound"] == "2.05"
    assert data["nominal"] == "2e0"
    assert data["lower_tolerance"] == "5e-2"
    assert data["upper_tolerance"] == "0.5e-1"
    assert [m["value"] for m in data["measurements"]] == [
        "1.95e0",
        "2.0E0",
        "0.205e1",
    ]
    rec = repo.recent()[0]
    assert rec.nominal == "2e0"
    assert rec.lower_tolerance == "5e-2"
    assert rec.upper_tolerance == "0.5e-1"
    assert rec.measurements == ("1.95e0", "2.0E0", "0.205e1")
    recent = c.get("/api/inspections/recent").json()
    assert recent[0]["nominal"] == "2e0"
    assert [m["value"] for m in recent[0]["measurements"]] == [
        "1.95e0",
        "2.0E0",
        "0.205e1",
    ]


def test_json_numbers_fall_back_to_decimal_text(client):
    """JSON 数字没有填写原文：按解析后的十进制文本落库（字符串项仍保原文）。"""
    c, repo = client
    payload = {
        **VALID_PAYLOAD,
        "batch_no": "LOT-NUM",
        "nominal": 2.0,
        "measurements": [1.95, "02.0", 2.05],
    }
    resp = post(c, payload)
    assert resp.status_code == 201
    assert resp.json()["passed"] is True
    rec = repo.recent()[0]
    assert rec.nominal == "2.0"
    # 数字项按解析文本，字符串项保留原文
    assert rec.measurements == ("1.95", "02.0", "2.05")


def test_validation_errors_locate_each_field(client):
    """非法提交：422 且错误定位到批次号 / 标称 / 偏差 / 具体测量项。"""
    c, _ = client
    resp = post(
        c,
        {
            "batch_no": "   ",
            "material": "",
            "nominal": "0",
            "lower_tolerance": "-0.1",
            "upper_tolerance": "0.05",
            "measurements": ["2.0", "abc"],
        },
    )
    assert resp.status_code == 422
    got = fields(resp)
    assert "batch_no" in got
    assert "material" in got
    assert "nominal" in got
    assert "lower_tolerance" in got
    assert "measurements.1" in got  # 第 2 次实测不是数字


def test_fewer_than_three_measurements_rejected(client):
    c, _ = client
    resp = post(c, {**VALID_PAYLOAD, "measurements": ["2.0", "2.0"]})
    assert resp.status_code == 422
    assert "measurements" in fields(resp)


def test_measurement_error_locates_exact_item(client):
    """第 3 次实测非法 → 错误定位到 measurements.2。"""
    c, _ = client
    resp = post(
        c, {**VALID_PAYLOAD, "measurements": ["2.0", "2.0", "not-a-number"]}
    )
    assert resp.status_code == 422
    assert "measurements.2" in fields(resp)


def test_nan_measurement_rejected_as_non_finite(client):
    c, _ = client
    body = json.dumps(VALID_PAYLOAD).replace('"1.98"', "NaN")
    resp = c.post(
        "/api/inspections", content=body, headers={"Content-Type": "application/json"}
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert any(
        e["field"] == "measurements.0" and "有限" in e["message"] for e in detail
    )


def test_missing_required_fields(client):
    c, _ = client
    resp = post(c, {"batch_no": "LOT-X"})
    assert resp.status_code == 422
    got = fields(resp)
    for expected in [
        "material",
        "nominal",
        "lower_tolerance",
        "upper_tolerance",
        "measurements",
    ]:
        assert expected in got


def test_inspection_does_not_affect_calculate(client):
    """抽检登记（含不合格批次）不改变展开计算入口与结果。"""
    c, _ = client
    payload = {**VALID_PAYLOAD, "measurements": ["9", "9", "9"]}  # 明显超差
    assert post(c, payload).status_code == 201
    resp = c.post(
        "/api/calculate",
        json={
            "segments": [100, 50],
            "bends": [
                {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": 0.33}
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["blank_length"] == "155.75"
