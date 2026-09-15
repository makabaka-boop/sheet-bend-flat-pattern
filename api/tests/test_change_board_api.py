"""换模作业牌 API 与仓储验收测试。

覆盖：
- 首次启动在现有数据库内补建单例（空闲、修订号 0），服务重启延续状态；
- 首次认领与归还（成功后以服务端快照为准，修订号递增）；
- 两客户端同版并发认领只有一方成功，失败方收到 412 与胜出者快照；
- 过期修订号 / 非持有人 / 空闲归还均不改变作业牌，并给出冲突原因；
- 作业牌与展开计算、inspections 表互不读写（含原入口合法/非法、重复批次复跑）。
"""
from __future__ import annotations

import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from app.main import app, get_board_repository, get_repository
from app.repository import (
    BoardConflictError,
    DieChangeBoardRepository,
    InspectionRepository,
)

VALID_INSPECTION = {
    "batch_no": "LOT-2026-001",
    "material": "SPCC",
    "nominal": "2.0",
    "lower_tolerance": "0.05",
    "upper_tolerance": "0.05",
    "measurements": ["1.98", "2.0", "2.02"],
}


@pytest.fixture()
def client(tmp_path):
    """每个测试独立库：作业牌仓储与抽检仓储共用同一数据库文件（同生产形态）。"""
    db_path = tmp_path / "shop.db"
    board_repo = DieChangeBoardRepository(db_path)
    inspection_repo = InspectionRepository(db_path)
    app.dependency_overrides[get_board_repository] = lambda: board_repo
    app.dependency_overrides[get_repository] = lambda: inspection_repo
    with TestClient(app) as c:
        yield c, board_repo, inspection_repo, db_path
    app.dependency_overrides.clear()


# ---------- 单例补建与读取 ----------


def test_first_start_creates_singleton_free_revision_zero(client):
    c, board_repo, _, db_path = client
    resp = c.get("/api/change-board")
    assert resp.status_code == 200
    data = resp.json()
    assert data == {
        "state": "free",
        "revision": 0,
        "holder": None,
        "die_description": None,
        "claimed_at": None,
    }

    # 物理表内只有单例行，id 恒为 1，且与 inspections 表共存于同一数据库
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id, state, revision, holder FROM die_change_board"
        ).fetchall()
        assert rows == [(1, "free", 0, None)]
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert {"die_change_board", "inspections"} <= tables

    # 重复初始化（模拟再次启动）不会插入第二行，也不会重置状态
    DieChangeBoardRepository(db_path)
    assert board_repo.get().revision == 0


def test_open_page_reads_state_via_existing_request_path(client):
    """页面打开时读取空闲/占用状态与递增修订号。"""
    c, _, _, _ = client
    assert c.get("/api/change-board").json()["state"] == "free"
    assert (
        c.post(
            "/api/change-board/claim",
            json={"holder": "张三", "die_description": "V 模 R3", "revision": 0},
        ).status_code
        == 200
    )
    occupied = c.get("/api/change-board").json()
    assert occupied["state"] == "occupied"
    assert occupied["revision"] == 1
    assert occupied["holder"] == "张三"


# ---------- 首次认领与归还 ----------


def test_first_claim_then_release_succeeds_with_snapshot(client):
    c, _, _, _ = client
    claim = c.post(
        "/api/change-board/claim",
        json={
            "holder": "张三",
            "die_description": "上模 V8 + 下模 R3 一套",
            "revision": 0,
        },
    )
    assert claim.status_code == 200
    snap = claim.json()
    assert snap["state"] == "occupied"
    assert snap["revision"] == 1
    assert snap["holder"] == "张三"
    assert snap["die_description"] == "上模 V8 + 下模 R3 一套"
    assert snap["claimed_at"]

    release = c.post(
        "/api/change-board/release",
        json={"holder": "张三", "revision": 1},
    )
    assert release.status_code == 200
    freed = release.json()
    assert freed["state"] == "free"
    assert freed["revision"] == 2
    assert freed["holder"] is None
    assert freed["die_description"] is None
    assert freed["claimed_at"] is None


def test_revision_increments_each_successful_transition(client):
    c, _, _, _ = client

    def claim(holder, rev):
        return c.post(
            "/api/change-board/claim",
            json={"holder": holder, "die_description": f"模具 {holder}", "revision": rev},
        )

    def release(holder, rev):
        return c.post(
            "/api/change-board/release",
            json={"holder": holder, "revision": rev},
        )

    assert claim("甲", 0).json()["revision"] == 1
    assert release("甲", 1).json()["revision"] == 2
    assert claim("乙", 2).json()["revision"] == 3
    assert release("乙", 3).json()["revision"] == 4
    # 修订号只增不减，状态跨多次交接延续
    assert c.get("/api/change-board").json()["revision"] == 4


# ---------- 同版并发竞争：只有一方成功 ----------


def test_concurrent_same_revision_claims_only_one_wins(client):
    """两个仓储实例（两客户端）持同一修订号并发认领：恰有一方成功。"""
    _, _, _, db_path = client
    repo_a = DieChangeBoardRepository(db_path)
    repo_b = DieChangeBoardRepository(db_path)
    results: list[str] = []
    errors: list[BoardConflictError] = []
    barrier = threading.Barrier(2)

    def worker(repo, name):
        barrier.wait()  # 尽量让两条条件 UPDATE 同时到达
        try:
            repo.claim(name, f"模具-{name}", 0, "2026-09-15T01:00:00+00:00")
            results.append(name)
        except BoardConflictError as exc:
            errors.append(exc)

    t1 = threading.Thread(target=worker, args=(repo_a, "张三"))
    t2 = threading.Thread(target=worker, args=(repo_b, "李四"))
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)

    assert sorted(results) == ["张三"] or sorted(results) == ["李四"]
    assert len(results) == 1
    assert len(errors) == 1
    winner = results[0]
    loser_error = errors[0]
    assert loser_error.reason == "already_occupied"
    # 失败方收到胜出者快照
    assert loser_error.snapshot.state == "occupied"
    assert loser_error.snapshot.revision == 1
    assert loser_error.snapshot.holder == winner


def test_second_claim_same_revision_via_http_gets_412_and_winner_snapshot(client):
    c, _, _, _ = client
    first = c.post(
        "/api/change-board/claim",
        json={"holder": "张三", "die_description": "V 模一套", "revision": 0},
    )
    assert first.status_code == 200

    # 另一客户端仍基于修订号 0 认领
    second = c.post(
        "/api/change-board/claim",
        json={"holder": "李四", "die_description": "W 模一套", "revision": 0},
    )
    assert second.status_code == 412
    body = second.json()
    assert body["detail"][0]["type"] == "already_occupied"
    assert "张三" in body["detail"][0]["message"]
    # 412 必须携带胜出者快照，供页面立即显示最新持有人
    assert body["snapshot"]["state"] == "occupied"
    assert body["snapshot"]["revision"] == 1
    assert body["snapshot"]["holder"] == "张三"
    # 失败方的认领没有覆盖作业牌
    assert c.get("/api/change-board").json()["holder"] == "张三"


# ---------- 归还：过期修订号 / 非持有人 / 空闲 ----------


def test_release_with_stale_revision_keeps_occupied(client):
    c, _, _, _ = client
    claim = c.post(
        "/api/change-board/claim",
        json={"holder": "张三", "die_description": "V 模", "revision": 0},
    ).json()
    current_rev = claim["revision"]

    # 作业牌经历一轮交接后，张三持旧修订号归还
    assert (
        c.post(
            "/api/change-board/release",
            json={"holder": "张三", "revision": current_rev},
        ).status_code
        == 200
    )
    assert (
        c.post(
            "/api/change-board/claim",
            json={"holder": "李四", "die_description": "W 模", "revision": current_rev + 1},
        ).status_code
        == 200
    )
    stale = c.post(
        "/api/change-board/release",
        json={"holder": "张三", "revision": current_rev},
    )
    assert stale.status_code == 412
    body = stale.json()
    assert body["detail"][0]["type"] == "revision_stale"
    assert body["snapshot"]["state"] == "occupied"
    assert body["snapshot"]["holder"] == "李四"
    # 作业牌保持占用
    board = c.get("/api/change-board").json()
    assert board["state"] == "occupied"
    assert board["holder"] == "李四"
    assert board["revision"] == current_rev + 2


def test_release_by_non_holder_keeps_occupied(client):
    c, _, _, _ = client
    claim = c.post(
        "/api/change-board/claim",
        json={"holder": "张三", "die_description": "V 模", "revision": 0},
    ).json()

    other = c.post(
        "/api/change-board/release",
        json={"holder": "李四", "revision": claim["revision"]},
    )
    assert other.status_code == 412
    body = other.json()
    assert body["detail"][0]["type"] == "holder_mismatch"
    assert "张三" in body["detail"][0]["message"]
    assert body["snapshot"]["revision"] == claim["revision"]
    board = c.get("/api/change-board").json()
    assert board["state"] == "occupied"
    assert board["holder"] == "张三"
    # 修订号不因为失败动作而递增
    assert board["revision"] == claim["revision"]


def test_release_when_free_returns_not_occupied_and_state_unchanged(client):
    c, _, _, _ = client
    resp = c.post(
        "/api/change-board/release",
        json={"holder": "张三", "revision": 0},
    )
    assert resp.status_code == 412
    assert resp.json()["detail"][0]["type"] == "not_occupied"
    board = c.get("/api/change-board").json()
    assert board["state"] == "free"
    assert board["revision"] == 0


def test_claim_when_occupied_then_release_conflicts_do_not_mutate_row(client):
    """连续冲突（认领竞争、非持有人归还、过期归还）后物理行只被成功动作改过。"""
    c, _, _, _ = client
    assert (
        c.post(
            "/api/change-board/claim",
            json={"holder": "张三", "die_description": "V 模", "revision": 0},
        ).status_code
        == 200
    )
    for payload in [
        {"holder": "李四", "die_description": "W 模", "revision": 0},
        {"holder": "李四", "revision": 1},
        {"holder": "张三", "revision": 99},
    ]:
        path = (
            "/api/change-board/claim"
            if "die_description" in payload
            else "/api/change-board/release"
        )
        resp = c.post(path, json=payload)
        assert resp.status_code == 412
    board = c.get("/api/change-board").json()
    assert board["state"] == "occupied"
    assert board["holder"] == "张三"
    assert board["revision"] == 1


# ---------- 服务重启延续状态 ----------


def test_state_survives_repository_reopen(client, tmp_path):
    c, board_repo, _, db_path = client
    claim = c.post(
        "/api/change-board/claim",
        json={"holder": "张三", "die_description": "V 模 R3 一套", "revision": 0},
    ).json()
    assert claim["revision"] == 1

    # 同一数据库文件重新打开仓储（模拟服务重启）：占用状态延续，不补建成空闲
    reopened = DieChangeBoardRepository(db_path)
    snap = reopened.get()
    assert snap.state == "occupied"
    assert snap.revision == 1
    assert snap.holder == "张三"
    assert snap.die_description == "V 模 R3 一套"
    assert snap.claimed_at

    # 重启后持有人仍可凭当前修订号归还
    released = reopened.release("张三", 1)
    assert released.state == "free"
    assert released.revision == 2

    # 再次重开仍见最新状态
    assert DieChangeBoardRepository(db_path).get().state == "free"


def test_free_state_also_persists_across_reopen(client, tmp_path):
    _, _, _, db_path = client
    repo = DieChangeBoardRepository(db_path)
    snap = repo.claim("张三", "V 模", 0, "2026-09-15T01:00:00+00:00")
    repo.release("张三", snap.revision)
    reopened = DieChangeBoardRepository(db_path)
    snap2 = reopened.get()
    assert snap2.state == "free"
    assert snap2.revision == 2
    # 空闲后下一名备料员基于修订号 2 认领
    assert reopened.claim("李四", "W 模", 2, "2026-09-15T02:00:00+00:00").revision == 3


# ---------- 字段级校验（仍走统一 422 入口） ----------


def test_claim_validation_errors_locate_fields(client):
    c, _, _, _ = client
    resp = c.post(
        "/api/change-board/claim",
        json={"holder": "   ", "die_description": "", "revision": -1},
    )
    assert resp.status_code == 422
    fields = [e["field"] for e in resp.json()["detail"]]
    assert "holder" in fields
    assert "die_description" in fields
    assert "revision" in fields
    # 校验失败不改变作业牌
    assert c.get("/api/change-board").json()["revision"] == 0


def test_release_validation_errors_locate_fields(client):
    c, _, _, _ = client
    resp = c.post(
        "/api/change-board/release",
        json={"holder": "", "revision": -1},
    )
    assert resp.status_code == 422
    fields = [e["field"] for e in resp.json()["detail"]]
    assert "holder" in fields
    assert "revision" in fields


# ---------- 互不读写：复跑展开合法/非法与抽检重复批次 ----------


def test_board_does_not_affect_inspections_table(client):
    """认领/归还作业牌不写入、不改变 inspections 表。"""
    c, board_repo, inspection_repo, _ = client
    assert (
        c.post(
            "/api/inspections",
            json=VALID_INSPECTION,
        ).status_code
        == 201
    )
    assert (
        c.post(
            "/api/change-board/claim",
            json={"holder": "张三", "die_description": "V 模", "revision": 0},
        ).status_code
        == 200
    )
    assert (
        c.post(
            "/api/change-board/release",
            json={"holder": "张三", "revision": 1},
        ).status_code
        == 200
    )
    records = inspection_repo.recent()
    assert len(records) == 1
    assert records[0].batch_no == "LOT-2026-001"


def test_duplicate_batch_still_409_while_board_occupied(client):
    """作业牌占用期间，抽检重复批次仍返回 409 且不覆盖原记录。"""
    c, _, _, _ = client
    assert (
        c.post(
            "/api/change-board/claim",
            json={"holder": "张三", "die_description": "V 模", "revision": 0},
        ).status_code
        == 200
    )
    assert c.post("/api/inspections", json=VALID_INSPECTION).status_code == 201
    conflict = c.post(
        "/api/inspections",
        json={**VALID_INSPECTION, "material": "SUS304", "measurements": ["9", "9", "9"]},
    )
    assert conflict.status_code == 409
    detail = conflict.json()["detail"]
    assert detail[0]["field"] == "batch_no"
    recent = c.get("/api/inspections/recent").json()
    assert len(recent) == 1
    assert recent[0]["material"] == "SPCC"
    # 作业牌仍是占用，抽检 409 没有动作业牌
    board = c.get("/api/change-board").json()
    assert board["state"] == "occupied"
    assert board["holder"] == "张三"
    assert board["revision"] == 1


def test_calculate_valid_and_invalid_unchanged_alongside_board(client):
    """复跑展开合法与非法提交：原入口响应与字段级错误保持不变。"""
    c, _, _, _ = client
    valid = c.post(
        "/api/calculate",
        json={
            "segments": [100, 50],
            "bends": [
                {"angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": 0.33}
            ],
        },
    )
    assert valid.status_code == 200
    assert valid.json()["blank_length"] == "155.75"

    invalid = c.post(
        "/api/calculate",
        json={
            "segments": [0, 50],
            "bends": [
                {"angle": 180, "thickness": 2, "inner_radius": 3, "k_factor": 0.9}
            ],
        },
    )
    assert invalid.status_code == 422
    fields = [e["field"] for e in invalid.json()["detail"]]
    assert "segments.0" in fields
    assert "bends.0.angle" in fields
    assert "bends.0.k_factor" in fields

    # 作业牌仍是初始空闲，展开调用没有动作业牌
    assert c.get("/api/change-board").json() == {
        "state": "free",
        "revision": 0,
        "holder": None,
        "die_description": None,
        "claimed_at": None,
    }


def test_inspection_endpoint_unchanged_after_board_lifecycle(client):
    """完整认领→竞争失败→归还周期后，抽检登记与最近列表行为不变。"""
    c, _, _, _ = client
    assert (
        c.post(
            "/api/change-board/claim",
            json={"holder": "张三", "die_description": "V 模", "revision": 0},
        ).status_code
        == 200
    )
    loser = c.post(
        "/api/change-board/claim",
        json={"holder": "李四", "die_description": "W 模", "revision": 0},
    )
    assert loser.status_code == 412
    assert (
        c.post(
            "/api/change-board/release",
            json={"holder": "张三", "revision": 1},
        ).status_code
        == 200
    )
    payload = {
        **VALID_INSPECTION,
        "batch_no": "LOT-AFTER-BOARD",
        "measurements": ["1.95", "2.05", "2.0"],
    }
    resp = c.post("/api/inspections", json=payload)
    assert resp.status_code == 201
    assert resp.json()["passed"] is True
    recent = c.get("/api/inspections/recent").json()
    assert [r["batch_no"] for r in recent] == ["LOT-AFTER-BOARD"]


# ---------- 仓储层并发归还 ----------


def test_concurrent_release_only_owner_with_revision_succeeds(client):
    """持有人与非持有人同时归还：仅持有人（修订号相符）成功，作业牌转空闲一次。"""
    _, _, _, db_path = client
    owner = DieChangeBoardRepository(db_path)
    other = DieChangeBoardRepository(db_path)
    owner.claim("张三", "V 模", 0, "2026-09-15T01:00:00+00:00")

    outcomes: list[str] = []
    barrier = threading.Barrier(2)

    def worker(repo, name, expect):
        barrier.wait()
        try:
            repo.release(name, 1)
            outcomes.append(f"ok-{name}")
        except BoardConflictError as exc:
            outcomes.append(f"fail-{name}-{exc.reason}")

    t1 = threading.Thread(target=worker, args=(owner, "张三", None))
    t2 = threading.Thread(target=worker, args=(other, "李四", None))
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)

    assert "ok-张三" in outcomes
    assert any(o.startswith("fail-李四") for o in outcomes)
    snap = DieChangeBoardRepository(db_path).get()
    assert snap.state == "free"
    assert snap.revision == 2
