# 折弯展开复核台

供折弯机备料复核员使用的展开长度复核工具。图纸上的成品直段**不能直接相加**作为下料长度——每道折弯都要加上补偿量；本工具把折弯参数集中到一处计算，避免不同人员分别处理导致同一零件得到不同尺寸。

页面分两个独立视图：**展开复核**（下料长度计算）与**来料抽检**（板厚抽检登记）。抽检结论不写入、也不改变展开结果。

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
  app/repository.py   抽检 SQLite 仓储（写入 vinfy 卷 /data）
  app/schemas.py      请求/响应模型与字段级校验
  app/main.py         路由、字段级错误翻译
  tests/              pytest：计算、抽检判定与边界
web/            React + TypeScript + Vite 复核页面
  src/App.tsx         视图切换与展开表单（非法提交不清空上一份有效结果）
  src/components/     ResultPanel（展开结果）、InspectionPanel（来料抽检）
  src/test/           Vitest：表单交互
  e2e/                Playwright：真实联调
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
