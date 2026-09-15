"""换模作业牌领域核心。

作业牌是本机换模唯一的占用协调对象：与展开结果、来料抽检记录互不读写。
状态只有「空闲 / 占用」两种，每次认领或归还成功都令修订号递增；
所有裁决（状态前置条件 + 修订号 + 持有人）由仓储的**单条条件更新**
完成，领域层只负责解释裁决结果——禁止先读后写。
"""
from __future__ import annotations

from dataclasses import dataclass

STATE_FREE = "free"  # 空闲：可认领
STATE_OCCUPIED = "occupied"  # 占用：仅当前持有人凭当前修订号可归还

# 条件更新未命中的冲突原因（可理解、可直接展示给备料员）
REASON_ALREADY_OCCUPIED = "already_occupied"  # 认领时已被他人占用
REASON_NOT_OCCUPIED = "not_occupied"  # 归还时作业牌空闲（无需归还）
REASON_REVISION_STALE = "revision_stale"  # 修订号过期：页面基于旧快照操作
REASON_HOLDER_MISMATCH = "holder_mismatch"  # 修订号相符但归还人不是持有人

CONFLICT_MESSAGES = {
    REASON_ALREADY_OCCUPIED: "作业牌已被他人认领，请等待其归还",
    REASON_NOT_OCCUPIED: "作业牌当前空闲，无需归还；状态可能已被更新",
    REASON_REVISION_STALE: "页面状态已过期，作业牌在此期间发生过变化",
    REASON_HOLDER_MISMATCH: "只有当前持牌人才能归还作业牌",
}


@dataclass(frozen=True)
class BoardSnapshot:
    """作业牌服务端快照：打开页面与每次裁决成功/失败后都以它为准。"""

    state: str  # free / occupied
    revision: int  # 递增修订号（每次成功的认领/归还 +1）
    holder: str | None  # 当前持有人（占用时非空）
    die_description: str | None  # 当前模具说明（占用时非空）
    claimed_at: str | None  # 认领时间（ISO 8601，UTC）


def conflict_message(reason: str, snapshot: BoardSnapshot) -> str:
    """把冲突原因翻译成面向备料员的中文，并带上最新持有人等现场信息。"""
    base = CONFLICT_MESSAGES.get(reason, "作业牌状态已变化，请按最新状态重试")
    if reason == REASON_ALREADY_OCCUPIED and snapshot.holder:
        return f"{base}：当前持有人 {snapshot.holder}"
    if reason == REASON_HOLDER_MISMATCH and snapshot.holder:
        return f"{base}：当前持有人是 {snapshot.holder}"
    if reason == REASON_REVISION_STALE:
        if snapshot.state == STATE_OCCUPIED and snapshot.holder:
            return f"{base}：当前由 {snapshot.holder} 持有"
        return f"{base}：作业牌当前空闲，可重新认领"
    return base
