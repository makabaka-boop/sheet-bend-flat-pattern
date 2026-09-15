"""抽检记录 SQLite 仓储：数据写入 vinfy 数据卷（容器内挂载到 /data）。

数值一律以十进制文本（TEXT）落库，不经 REAL/float，杜绝精度丢失；
批次号有唯一约束，重复写入抛 DuplicateBatchError，绝不覆盖原记录。
"""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

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
