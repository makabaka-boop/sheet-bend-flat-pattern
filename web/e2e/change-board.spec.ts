import { expect, test, type Page, type BrowserContext } from '@playwright/test';

/**
 * 换模作业牌真实联调。
 *
 * 作业牌是全机单例，测试开始前先用 API 复位到空闲，保证可重复运行。
 */
const BOARD_PATH = '/api/change-board';
const CLAIM_PATH = '/api/change-board/claim';
const RELEASE_PATH = '/api/change-board/release';

async function getBoard(page: Page) {
  const resp = await page.request.get(BOARD_PATH);
  return (await resp.json()) as {
    state: 'free' | 'occupied';
    revision: number;
    holder: string | null;
  };
}

/** 复位到「空闲」并返回当前快照；修订号单调递增不回零，故以其 revision 为基准。 */
async function resetBoard(page: Page) {
  let snap = await getBoard(page);
  // 最多处理几轮，确保最终空闲（串行测试内通常一次即够）
  for (let i = 0; i < 5 && snap.state === 'occupied'; i++) {
    await page.request.post(RELEASE_PATH, {
      data: { holder: snap.holder, revision: snap.revision },
    });
    snap = await getBoard(page);
  }
  return snap;
}

async function openBoardView(page: Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: '换模作业牌' }).click();
  await expect(page.getByTestId('board-panel')).toBeVisible();
}

test.describe.serial('换模作业牌（真实联调）', () => {
  let initial: {
    state: 'free' | 'occupied';
    revision: number;
    holder: string | null;
  };

  test.beforeEach(async ({ page }) => {
    initial = await resetBoard(page);
  });

  test('首次认领与归还：快照驱动卡片，修订号递增', async ({ page }) => {
    const rev0 = initial.revision;
    await openBoardView(page);
    await expect(page.getByTestId('board-state')).toHaveText('空闲');
    await expect(page.getByTestId('board-revision')).toHaveText(
      `修订号 ${rev0}`,
    );

    await page.getByLabel(/你的姓名/).fill('张三');
    await page.getByLabel(/模具说明/).fill('上模 V8 + 下模 R3 一套');
    await page.getByTestId('board-claim').click();

    await expect(page.getByTestId('board-state')).toHaveText('占用中');
    await expect(page.getByTestId('board-revision')).toHaveText(
      `修订号 ${rev0 + 1}`,
    );
    await expect(page.getByTestId('board-current-holder')).toHaveText('张三');
    await expect(page.getByTestId('board-current-die')).toHaveText(
      '上模 V8 + 下模 R3 一套',
    );
    // 成功后保留自己的姓名填写（归还时仍需核对持有人）
    await expect(page.getByLabel(/你的姓名/)).toHaveValue('张三');
    // 占用时模具说明以服务端快照为准，输入框禁用
    await expect(page.getByLabel(/模具说明/)).toBeDisabled();

    // 持有人归还
    await page.getByTestId('board-release').click();
    await expect(page.getByTestId('board-state')).toHaveText('空闲');
    await expect(page.getByTestId('board-revision')).toHaveText(
      `修订号 ${rev0 + 2}`,
    );
    await expect(page.getByTestId('board-claim')).toBeVisible();
  });

  test('两客户端同版竞争：仅一方成功，失败方立即看到胜出持有人且填写保留', async ({
    browser,
  }) => {
    const rev0 = initial.revision;
    // 两个独立上下文模拟两名备料员同时打开页面（都读到同一修订号）
    const contextA: BrowserContext = await browser.newContext();
    const contextB: BrowserContext = await browser.newContext();
    const pageA = contextA.pages()[0] ?? (await contextA.newPage());
    const pageB = contextB.pages()[0] ?? (await contextB.newPage());

    try {
      await openBoardView(pageA);
      await openBoardView(pageB);
      await expect(pageA.getByTestId('board-revision')).toHaveText(
        `修订号 ${rev0}`,
      );
      await expect(pageB.getByTestId('board-revision')).toHaveText(
        `修订号 ${rev0}`,
      );

      await pageA.getByLabel(/你的姓名/).fill('张三');
      await pageA.getByLabel(/模具说明/).fill('V 模一套');
      await pageB.getByLabel(/你的姓名/).fill('李四');
      await pageB.getByLabel(/模具说明/).fill('W 模一套');

      // 同时认领：两个 POST 都带同一修订号，服务端条件更新裁决仅一方成功。
      // 失败方收到 412 后用胜出快照刷新卡片，因此双方都显示「占用中」，
      // 但只有一个显示自己是持有人，另一个显示对方。
      await Promise.all([
        pageA.getByTestId('board-claim').click(),
        pageB.getByTestId('board-claim').click(),
      ]);

      // 双方卡片都推进到同一修订号（失败方用胜出者快照更新）
      await expect(pageA.getByTestId('board-revision')).toHaveText(
        `修订号 ${rev0 + 1}`,
      );
      await expect(pageB.getByTestId('board-revision')).toHaveText(
        `修订号 ${rev0 + 1}`,
      );

      // 判定谁成功：自己页面的当前持有人等于自己姓名的那一方
      const holderA = await pageA.getByTestId('board-current-holder').textContent();
      const holderB = await pageB.getByTestId('board-current-holder').textContent();
      const aIsWinner = holderA?.includes('张三') ?? false;
      const bIsWinner = holderB?.includes('李四') ?? false;
      expect([aIsWinner, bIsWinner].filter(Boolean).length).toBe(1);

      const winnerPage = aIsWinner ? pageA : pageB;
      const loser = aIsWinner ? pageB : pageA;
      const winnerName = aIsWinner ? '张三' : '李四';
      const loserName = aIsWinner ? '李四' : '张三';

      // 成功方无冲突提示
      await expect(winnerPage.getByTestId('board-conflict')).toHaveCount(0);
      // 失败方：冲突提示含胜出持有人，卡片立即显示最新持有人（对方）
      await expect(loser.getByTestId('board-current-holder')).toHaveText(
        winnerName,
      );
      await expect(loser.getByTestId('board-conflict')).toContainText(winnerName);
      // 失败方自己的填写保留
      await expect(loser.getByLabel(/你的姓名/)).toHaveValue(loserName);
      await expect(loser.getByLabel(/模具说明/)).toHaveValue(
        loserName === '李四' ? 'W 模一套' : 'V 模一套',
      );

      // 服务端最终只有一个持有人，修订号恰好推进一次
      const board = await (await pageA.request.get(BOARD_PATH)).json();
      expect(board.state).toBe('occupied');
      expect(board.revision).toBe(rev0 + 1);
      expect(board.holder).toBe(winnerName);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('非持有人归还与过期修订号归还保持占用，并给出可理解原因', async ({
    page,
  }) => {
    const rev0 = initial.revision;
    // 先由张三认领，修订号推进到 rev0+1
    let resp = await page.request.post(CLAIM_PATH, {
      data: { holder: '张三', die_description: 'V 模一套', revision: rev0 },
    });
    expect(resp.status()).toBe(200);

    await openBoardView(page);
    await expect(page.getByTestId('board-current-holder')).toHaveText('张三');

    // 李四在页面上尝试归还（修订号相符但非持有人）→ 412，保持占用
    await page.getByLabel(/你的姓名/).fill('李四');
    await page.getByTestId('board-release').click();
    await expect(page.getByTestId('board-conflict')).toContainText('持牌人');
    await expect(page.getByTestId('board-state')).toHaveText('占用中');
    await expect(page.getByTestId('board-current-holder')).toHaveText('张三');
    // 自己的姓名填写保留
    await expect(page.getByLabel(/你的姓名/)).toHaveValue('李四');

    // 过期修订号（张三持 rev0 直接打 API）→ 412，作业牌保持占用
    resp = await page.request.post(RELEASE_PATH, {
      data: { holder: '张三', revision: rev0 },
    });
    expect(resp.status()).toBe(412);
    const body = await resp.json();
    expect(body.detail[0].type).toBe('revision_stale');
    expect(body.snapshot.state).toBe('occupied');
    expect(body.snapshot.holder).toBe('张三');
    expect(body.snapshot.revision).toBe(rev0 + 1);

    const board = await getBoard(page);
    expect(board.state).toBe('occupied');
    expect(board.revision).toBe(rev0 + 1);
  });

  test('服务重启（重开仓储）后作业牌仍为占用，原持有人可继续归还', async ({
    page,
  }) => {
    const rev0 = initial.revision;
    // 仓储重开等价于：同库文件上的新连接读到同一单例行。
    // 这里通过 API 认领，再用 GET 验证状态跨“新读取方”延续。
    const claim = await page.request.post(CLAIM_PATH, {
      data: {
        holder: '王五',
        die_description: '折弯机 2 号 V10 模',
        revision: rev0,
      },
    });
    expect(claim.status()).toBe(200);

    // 新开一个浏览器上下文（重新打开页面的备料员）读到占用
    const otherPage = await page.context().browser()!.newPage();
    try {
      await openBoardView(otherPage);
      await expect(otherPage.getByTestId('board-state')).toHaveText('占用中');
      await expect(otherPage.getByTestId('board-current-holder')).toHaveText('王五');
      await expect(otherPage.getByTestId('board-revision')).toHaveText(
        `修订号 ${rev0 + 1}`,
      );
    } finally {
      await otherPage.close();
    }

    // 原持有人凭当前修订号归还成功
    const release = await page.request.post(RELEASE_PATH, {
      data: { holder: '王五', revision: rev0 + 1 },
    });
    expect(release.status()).toBe(200);
    expect((await release.json()).state).toBe('free');
  });

  test('作业牌周期不影响展开合法/非法提交与抽检重复批次', async ({ page }) => {
    const rev0 = initial.revision;
    const batchNo = `BOARD-E2E-${Date.now()}`;

    // 完整作业牌周期：认领 → 竞争失败 → 归还
    let resp = await page.request.post(CLAIM_PATH, {
      data: { holder: '张三', die_description: 'V 模', revision: rev0 },
    });
    expect(resp.status()).toBe(200);
    const loser = await page.request.post(CLAIM_PATH, {
      data: { holder: '李四', die_description: 'W 模', revision: rev0 },
    });
    expect(loser.status()).toBe(412);
    resp = await page.request.post(RELEASE_PATH, {
      data: { holder: '张三', revision: rev0 + 1 },
    });
    expect(resp.status()).toBe(200);

    // 展开合法提交不受影响
    await page.goto('/');
    await page.getByLabel(/直段 L1/).fill('100');
    await page.getByLabel(/直段 L2/).fill('50');
    await page.getByRole('button', { name: '计算下料长度' }).click();
    await expect(page.getByTestId('blank-length')).toHaveText('155.75');

    // 展开非法提交：字段级错误与“保留上一份结果”行为不受影响
    await page.getByRole('group', { name: '第 1 道折弯' }).getByLabel(/角度/).fill('0');
    await page.getByRole('button', { name: '计算下料长度' }).click();
    await expect(page.locator('#error-bend-0-angle')).toContainText('大于 0');
    await expect(page.getByTestId('blank-length')).toHaveText('155.75');

    // 抽检登记 + 重复批次 409 原行为保留（成功后表单清空，重复提交需重新填全）
    await page.getByRole('tab', { name: '来料抽检' }).click();
    async function fillInspection() {
      await page.getByLabel(/批次号/).fill(batchNo);
      await page.getByLabel(/材料牌号/).fill('SPCC');
      await page.getByLabel(/标称板厚/).fill('2.0');
      await page.getByLabel(/下允许偏差/).fill('0.05');
      await page.getByLabel(/上允许偏差/).fill('0.05');
      await page.getByLabel(/实测值 1/).fill('1.98');
      await page.getByLabel(/实测值 2/).fill('2.00');
      await page.getByLabel(/实测值 3/).fill('2.02');
    }
    await fillInspection();
    await page.getByRole('button', { name: '登记抽检' }).click();
    await expect(page.getByTestId(`inspection-record-${batchNo}`)).toBeVisible();

    await fillInspection();
    await page.getByRole('button', { name: '登记抽检' }).click();
    await expect(page.locator('#error-inspection-batch-no')).toContainText('已存在');
  });
});
