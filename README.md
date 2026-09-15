# 折弯展开复核台

供折弯机备料复核员使用的展开长度复核工具。图纸上的成品直段**不能直接相加**作为下料长度——每道折弯都要加上补偿量；本工具把折弯参数集中到一处计算，避免不同人员分别处理导致同一零件得到不同尺寸。

页面分三个彼此独立的视图：**展开复核**（下料长度计算）、**来料抽检**（板厚抽检登记）与**换模作业牌**（换模占用协调）。抽检结论不写入、也不改变展开结果；作业牌状态与展开结果、抽检记录互不读写。

## 换模作业牌

折弯机换模前，两名备料员可能同时拆装同一套模具。**换模作业牌**是本机唯一的占用协调对象：换模前先认领，持有人完成换模后再归还。

- 状态只有「空闲 / 占用」，带一个**递增修订号**：每次成功的认领或归还都令修订号 +1。
- 打开视图时通过统一请求封装读取作业牌状态与修订号；认领、归还两个动作都**提交当前修订号**，成功后以响应中的服务端快照更新卡片。
- 裁决由领域层与 SQLite 仓储以**一条带状态前置条件与修订号的条件 UPDATE** 完成（`WHERE state=? AND revision=?`，归还再加 `AND holder=?`），**禁止先读后写**。同一修订号的并发认领恰有一个成功；失败方收到 `412 Precondition Failed` 与**胜出者快照**，页面立即显示最新持有人，并保留自己填写的姓名与模具说明。
- 归还必须同时是「占用 + 当前持有人 + 修订号相符」；过期修订号（`revision_stale`）、非持有人（`holder_mismatch`）、空闲归还（`not_occupied`）任一条件不符都**不改变作业牌**，并返回可理解的中文冲突原因。
- 首次启动在**现有数据库内补建**单例记录（id 恒为 1，空闲、修订号 0）；服务重启后沿用同一数据库文件，占用状态延续。作业牌是同库中的另一张表 `die_change_board`，**不修改 `inspections` 表，也不改变 `vinfy` 卷约定**（仍是卷内 `/data/inspections.db`）。
- API：`GET /api/change-board`、`POST /api/change-board/claim`、`POST /api/change-board/release`。

## 来料板厚抽检

备料员在展开复核前登记来料板厚抽检，避免超差板材流入加工：

- 输入：唯一批次号、材料牌号、标称板厚、上/下允许偏差、至少 3 次实测值。
- 判定：用 `Decimal` 建立**闭区间** `[标称 − 下偏差, 标称 + 上偏差]`，全部实测值均在区间内才判为合格；恰等于边界的实测值判为合格。响应返回逐项偏差（实测 − 标称）与越界方向（`within` 区间内 / `above` 越上界 / `below` 越下界）。
- 持久化：批次号、原始十进制文本、判定状态与登记时间写入 SQLite（容器内落在 `vinfy` 卷 `/data/inspections.db`；本地开发 `/data` 不可写时回退 `./data/`，可用环境变量 `INSPECTION_DB_PATH` 或 `INSPECTION_DATA_DIR` 覆盖）。数值按**填写原文**逐字落库——前导零（`02.0`）、指数写法（`2e0`）等不会被改写；判定按解析后的数值进行。
- 批次号唯一：重复登记返回 `409`，**不覆盖**原记录；错误定位到 `batch_no` 字段。

## 计算公式与输入含义

每道折弯的补偿量（bend allowance）：

```
BA = π ÷ 180 × 角度 ×（内半径 + K因子 × 板厚）
```

| 公式中的量 | 输入字段 | 含义 | 约束 |
| --- | --- | --- | --- |
| 角度 | `bends[i].angle` | 第 i 道折弯的折弯角度，单位度（°） | 0 < 角度 < 180 |
| 内半径 | `bends[i].inner_radius` | 折弯内圆角半径，单位 mm | ≥ 0 |
| K因子 | `bends[i].k_factor` | 中性层位置系数（中性层到内侧距离 ÷ 板厚） | 0 ≤ K ≤ 0.5 |
| 板厚 | `bends[i].thickness` | 板材厚度，单位 mm | > 0 |
| （直段） | `segments[i]` | 相邻切点之间的直段长度，单位 mm，共 n+1 段 | 每段 > 0 |

汇总规则：

```
未舍入总长 = 全部直段之和 + 全部补偿量之和        （不舍入，完整精度展示）
下料长度   = 未舍入总长按 ROUND_HALF_UP 保留两位  （唯一的最终下料尺寸）
```

- 折弯道数 n ≥ 1，直段数必须等于 n + 1（按加工顺序交替：直段 L1 → 第 1 道 → L2 → … → 第 n 道 → Ln+1）。
- 全部计算使用 `Decimal`，不经 float，杜绝二进制浮点误差。
- 直段求和、K因子×板厚、内半径+K×板厚 为**精确**十进制运算（精度随数值跨度自适应）：`1e999 + 1` 毫米这样的小数字段一个都不会丢；只有含 π 的乘法保留 50 位有效数字（无理数的固有近似）。
- 每道补偿量明细保留六位小数（仅展示用）；总长与下料长度始终基于**未舍入**补偿量计算。
- 所有输入必须为有限数值（拒绝 NaN / Infinity）；任意大的有限数都能正常算出下料长度。

## 目录结构

```
api/            FastAPI + Pydantic + Decimal 计算服务（Python 3.12）
  app/calculator.py   展开计算核心（公式实现）
  app/inspection.py   抽检判定核心（闭区间、逐项偏差与越界方向）
  app/board.py        换模作业牌领域（状态/修订号约定与冲突原因）
  app/repository.py   SQLite 仓储：抽检表与作业牌单例（条件 UPDATE 裁决）
  app/schemas.py      请求/响应模型与字段级校验
  app/main.py         路由、字段级错误翻译
  tests/              pytest：计算、抽检、作业牌裁决与并发竞争
web/            React + TypeScript + Vite 复核页面
  src/App.tsx         视图切换与展开表单（非法提交不清空上一份有效结果）
  src/components/     ResultPanel、InspectionPanel、ChangeBoardPanel
  src/test/           Vitest：表单交互
  e2e/                Playwright：真实联调（含两客户端同版竞争）
docker-compose.yml
```

## 本地开发

### API（Python 3.12）

```bash
cd api
python3.12 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload --port 8000
```

### Web

```bash
cd web
npm install
npm run dev        # http://localhost:5173，/api 自动代理到 8000 端口
```

## 测试

```bash
# 计算与边界（pytest）
cd api && .venv/bin/python -m pytest -q

# 表单交互（Vitest）
cd web && npm test

# 端到端真实联调（Playwright 自动拉起 API 与 Web）
cd web && npx playwright install chromium && npx playwright test
```

## Docker Compose 一键启动

```bash
docker compose up --build
# Web: http://localhost:8080    API: http://localhost:8000
```

宿主端口可用环境变量覆盖：

```bash
WEB_PORT=9000 API_PORT=9001 docker compose up --build
```

Compose 内含名为 `vinfy` 的卷（挂载到 API 容器 `/data`）。

## API 说明

`POST /api/calculate`

```json
{
  "segments": [100, 50],
  "bends": [
    { "angle": 90, "thickness": 2, "inner_radius": 3, "k_factor": 0.33 }
  ]
}
```

合法响应（数值以字符串返回，避免精度丢失）：

```json
{
  "bend_count": 1,
  "segment_count": 2,
  "segments": ["100", "50"],
  "segments_total": "150",
  "bends": [
    {
      "index": 1,
      "angle": "90",
      "thickness": "2",
      "inner_radius": "3",
      "k_factor": "0.33",
      "inner_radius_plus_kt": "3.66",
      "allowance": "5.749115",
      "allowance_unrounded": "5.749114556069321626386637391"
    }
  ],
  "allowances_total": "5.749114556069321626386637391",
  "unrounded_total": "155.7491145560693216263866374",
  "blank_length": "155.75"
}
```

非法输入返回 `422`，`detail` 为字段级错误数组，`field` 用点路径定位到具体输入项：

```json
{
  "detail": [
    { "field": "segments.0", "message": "必须大于 0", "type": "greater_than" },
    { "field": "bends.1.k_factor", "message": "必须小于等于 0.5", "type": "less_than_equal" }
  ]
}
```

前端收到 422 时只在对应输入框旁展示错误，**不会**用非法提交替换上一份有效结果。

## 抽检 API

`POST /api/inspections` —— 登记一批来料抽检（成功返回 `201`）：

```json
{
  "batch_no": "LOT-2026-001",
  "material": "SPCC",
  "nominal": "2.0",
  "lower_tolerance": "0.05",
  "upper_tolerance": "0.05",
  "measurements": ["1.95", "2.00", "2.05"]
}
```

响应（数值以字符串返回；`direction` 为 `within` / `above` / `below`）：

```json
{
  "batch_no": "LOT-2026-001",
  "material": "SPCC",
  "nominal": "2.0",
  "lower_tolerance": "0.05",
  "upper_tolerance": "0.05",
  "lower_bound": "1.95",
  "upper_bound": "2.05",
  "measurements": [
    { "index": 1, "value": "1.95", "deviation": "-0.05", "within": true, "direction": "within" },
    { "index": 2, "value": "2.00", "deviation": "0.00", "within": true, "direction": "within" },
    { "index": 3, "value": "2.05", "deviation": "0.05", "within": true, "direction": "within" }
  ],
  "passed": true,
  "created_at": "2026-09-15T01:00:00.000000+00:00"
}
```

- 批次号重复：返回 `409`，`detail` 结构与 422 相同（`field` 为 `batch_no`），原记录不被覆盖。
- 字段校验失败：返回 `422`，`field` 定位到 `batch_no` / `nominal` / `measurements.1` 等具体输入项。

`GET /api/inspections/recent?limit=10` —— 最近登记的抽检记录（新的在前），响应为上述对象的数组。

## 换模作业牌 API

`GET /api/change-board` —— 读取作业牌快照（页面打开时调用）：

```json
{
  "state": "free",
  "revision": 0,
  "holder": null,
  "die_description": null,
  "claimed_at": null
}
```

`POST /api/change-board/claim` —— 认领（200 返回占用快照；竞争失败返回 `412`）：

```json
{ "holder": "张三", "die_description": "上模 V8 + 下模 R3 一套", "revision": 0 }
```

`POST /api/change-board/release` —— 归还（仅当前持有人凭当前修订号；否则 `412`）：

```json
{ "holder": "张三", "revision": 1 }
```

成功响应（认领后修订号 0→1，归还后 1→2）：

```json
{
  "state": "occupied",
  "revision": 1,
  "holder": "张三",
  "die_description": "上模 V8 + 下模 R3 一套",
  "claimed_at": "2026-09-15T01:00:00.000000+00:00"
}
```

`412` 响应携带字段级冲突说明与**胜出者快照**，前端据此立即刷新卡片并保留自己的填写：

```json
{
  "detail": [
    {
      "field": "revision",
      "message": "作业牌已被他人认领，请等待其归还：当前持有人 张三",
      "type": "already_occupied"
    }
  ],
  "snapshot": {
    "state": "occupied",
    "revision": 1,
    "holder": "张三",
    "die_description": "上模 V8 + 下模 R3 一套",
    "claimed_at": "2026-09-15T01:00:00.000000+00:00"
  }
}
```

冲突 `type`：`already_occupied`（认领时已占用）、`not_occupied`（空闲归还）、`revision_stale`（修订号过期）、`holder_mismatch`（非持有人归还）。字段校验失败仍走统一 `422`（`holder` / `die_description` / `revision`）。
