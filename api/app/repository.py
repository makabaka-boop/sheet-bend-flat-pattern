"""SQLite 仓储：抽检记录与换模作业牌均写入 vinfy 数据卷（容器内挂载到 /data）。

数值一律以十进制文本（TEXT）落库，不经 REAL/float，杜绝精度丢失；
批次号有唯一约束，重复写入抛 DuplicateBatchError，绝不覆盖原记录。

换模作业牌是同库内的另一张表单例（id 恒为 1），与 inspections 表互不读写；
认领/归还的裁决由**一条带状态前置条件与修订号的条件 UPDATE** 完成，
禁止先读后写：条件不命中即裁决失败，再读取胜出快照返回给调用方。
"""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from .board import (
    REASON_ALREADY_OCCUPIED,
    REASON_HOLDER_MISMATCH,
    REASON_NOT_OCCUPIED,
    REASON_REVISION_STALE,
    STATE_FREE,
    BoardSnapshot,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT NOT NULL UNIQUE,
    material TEXT NOT NULL,
    nominal TEXT NOT NULL,
    lower_tolerance TEXT NOT NULL,
    upper_tolerance TEXT NOT NULL,
    measurements TEXT NOT NULL,
    passed INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    created_at TEXT NOT NULL
)
"""


class DuplicateBatchError(Exception):
    """批次号已存在：不得重复登记，也不得覆盖原记录。"""

    def __init__(self, batch_no: str):
        super().__init__(f"批次号已存在：{batch_no}")
        self.batch_no = batch_no


@dataclass(frozen=True)
class InspectionRecord:
    """一条抽检持久化记录（数值一律为原始十进制文本）。"""

    batch_no: str  # 唯一批次号
    material: str  # 材料牌号
    nominal: str  # 标称板厚（十进制文本）
    lower_tolerance: str  # 下允许偏差（十进制文本）
    upper_tolerance: str  # 上允许偏差（十进制文本）
    measurements: tuple[str, ...]  # 各次实测值（十进制文本）
    passed: bool  # 判定状态
    verdict: str  # 完整判定快照（JSON 文本：区间与逐项偏差、越界方向）
    created_at: str  # 登记时间（ISO 8601，UTC）


def default_db_path() -> Path:
    """默认数据库路径。

    容器内 vinfy 卷挂载到 /data，直接落卷；本地开发时 /data 不可写，
    回退到当前目录 ./data。可用 INSPECTION_DB_PATH 指定完整路径，
    或用 INSPECTION_DATA_DIR 指定目录。
    """
    env_path = os.environ.get("INSPECTION_DB_PATH")
    if env_path:
        return Path(env_path)
    data_dir = Path(os.environ.get("INSPECTION_DATA_DIR", "/data"))
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        data_dir = Path("data")
        data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "inspections.db"


class InspectionRepository:
    """抽检记录的 SQLite 仓储。每次操作独立连接，线程安全。"""

    def __init__(self, db_path: str | Path):
        self._db_path = str(db_path)
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as conn:
            with conn:
                conn.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def insert(self, record: InspectionRecord) -> None:
        """写入一条抽检记录；批次号重复时抛 DuplicateBatchError。"""
        try:
            with closing(self._connect()) as conn:
                with conn:
                    conn.execute(
                        """
                        INSERT INTO inspections (
                            batch_no, material, nominal, lower_tolerance,
                            upper_tolerance, measurements, passed, verdict,
                            created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            record.batch_no,
                            record.material,
                            record.nominal,
                            record.lower_tolerance,
                            record.upper_tolerance,
                            json.dumps(list(record.measurements), ensure_ascii=False),
                            1 if record.passed else 0,
                            record.verdict,
                            record.created_at,
                        ),
                    )
        except sqlite3.IntegrityError as exc:
            raise DuplicateBatchError(record.batch_no) from exc

    def recent(self, limit: int = 10) -> list[InspectionRecord]:
        """最近写入的抽检记录，新的在前。"""
        with closing(self._connect()) as conn:
            rows = conn.execute(
                """
                SELECT batch_no, material, nominal, lower_tolerance,
                       upper_tolerance, measurements, passed, verdict, created_at
                FROM inspections
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            InspectionRecord(
                batch_no=row["batch_no"],
                material=row["material"],
                nominal=row["nominal"],
                lower_tolerance=row["lower_tolerance"],
                upper_tolerance=row["upper_tolerance"],
                measurements=tuple(json.loads(row["measurements"])),
                passed=bool(row["passed"]),
                verdict=row["verdict"],
                created_at=row["created_at"],
            )
            for row in rows
        ]


# ---------- 换模作业牌（同库另一张表单例，与 inspections 互不读写） ----------

BOARD_SCHEMA = """
CREATE TABLE IF NOT EXISTS die_change_board (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL CHECK (state IN ('free', 'occupied')),
    revision INTEGER NOT NULL,
    holder TEXT,
    die_description TEXT,
    claimed_at TEXT
)
"""


class BoardConflictError(Exception):
    """条件更新未命中：本次认领/归还未改变作业牌。

    snapshot 为服务端当前（胜出方）快照，reason 为可理解的冲突原因。
    """

    def __init__(self, reason: str, snapshot: BoardSnapshot):
        super().__init__(reason)
        self.reason = reason
        self.snapshot = snapshot


class DieChangeBoardRepository:
    """换模作业牌单例仓储。每次操作独立连接，线程安全。

    初始化时建表并**补建**单例行（空闲、修订号 0）；服务重启后
    沿用同一数据库文件，占用状态自然延续。
    """

    def __init__(self, db_path: str | Path):
        self._db_path = str(db_path)
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as conn:
            with conn:
                conn.execute(BOARD_SCHEMA)
                # 首次启动补建单例；已存在则整行保持不变（状态跨重启延续）
                conn.execute(
                    """
                    INSERT OR IGNORE INTO die_change_board
                        (id, state, revision, holder, die_description, claimed_at)
                    VALUES (1, 'free', 0, NULL, NULL, NULL)
                    """
                )

    def _connect(self) -> sqlite3.Connection:
        # busy_timeout：并发条件更新排队等锁，而不是立刻报 database is locked
        conn = sqlite3.connect(self._db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        return conn

    def _snapshot(self, conn: sqlite3.Connection) -> BoardSnapshot:
        row = conn.execute(
            """
            SELECT state, revision, holder, die_description, claimed_at
            FROM die_change_board WHERE id = 1
            """
        ).fetchone()
        return BoardSnapshot(
            state=row["state"],
            revision=row["revision"],
            holder=row["holder"],
            die_description=row["die_description"],
            claimed_at=row["claimed_at"],
        )

    def get(self) -> BoardSnapshot:
        """读取作业牌当前状态与修订号（打开页面时用，纯读不做裁决）。"""
        with closing(self._connect()) as conn:
            return self._snapshot(conn)

    def claim(
        self, holder: str, die_description: str, expected_revision: int, claimed_at: str
    ) -> BoardSnapshot:
        """认领作业牌：仅当「空闲且修订号相符」时一条条件 UPDATE 完成裁决。

        条件不命中不改变作业牌，抛 BoardConflictError 并携带胜出快照。
        """
        with closing(self._connect()) as conn:
            with conn:
                cur = conn.execute(
                    """
                    UPDATE die_change_board
                    SET state = 'occupied',
                        revision = revision + 1,
                        holder = ?,
                        die_description = ?,
                        claimed_at = ?
                    WHERE id = 1 AND state = ? AND revision = ?
                    """,
                    (
                        holder,
                        die_description,
                        claimed_at,
                        STATE_FREE,
                        expected_revision,
                    ),
                )
                if cur.rowcount == 1:
                    return self._snapshot(conn)
                snapshot = self._snapshot(conn)
        raise BoardConflictError(self._claim_failure_reason(snapshot), snapshot)

    @staticmethod
    def _claim_failure_reason(snapshot: BoardSnapshot) -> str:
        if snapshot.state != STATE_FREE:
            return REASON_ALREADY_OCCUPIED
        # 空闲但修订号不符只可能是该行处于异常历史版本；按过期处理
        return REASON_REVISION_STALE

    def release(
        self, holder: str, expected_revision: int
    ) -> BoardSnapshot:
        """归还作业牌：必须同时满足「占用 + 当前持有人 + 修订号相符」。

        任一条件不符都不改变作业牌；按 状态 → 修订号 → 持有人 的顺序
        给出可理解的冲突原因。
        """
        with closing(self._connect()) as conn:
            with conn:
                cur = conn.execute(
                    """
                    UPDATE die_change_board
                    SET state = 'free',
                        revision = revision + 1,
                        holder = NULL,
                        die_description = NULL,
                        claimed_at = NULL
                    WHERE id = 1 AND state = 'occupied'
                      AND revision = ? AND holder = ?
                    """,
                    (expected_revision, holder),
                )
                if cur.rowcount == 1:
                    return self._snapshot(conn)
                snapshot = self._snapshot(conn)
        raise BoardConflictError(
            self._release_failure_reason(snapshot, holder, expected_revision),
            snapshot,
        )

    @staticmethod
    def _release_failure_reason(
        snapshot: BoardSnapshot, holder: str, expected_revision: int
    ) -> str:
        # 任一条件不符都不改动作业牌；按 状态 → 修订号 → 持有人 顺序解释原因
        if snapshot.state == STATE_FREE:
            return REASON_NOT_OCCUPIED
        if snapshot.revision != expected_revision:
            return REASON_REVISION_STALE
        if snapshot.holder != holder:
            return REASON_HOLDER_MISMATCH
        return REASON_REVISION_STALE
