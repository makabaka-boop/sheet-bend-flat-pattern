import { expect, test } from '@playwright/test';

/** 每次运行使用唯一批次号，避免与既有数据冲突（重复批次返回 409）。 */
const uniqueBatch = () => `E2E-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function openInspectionView(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: '来料抽检' }).click();
}

async function fillForm(
  page: import('@playwright/test').Page,
  batchNo: string,
  measurements: [string, string, string],
) {
  await page.getByLabel(/批次号/).fill(batchNo);
  await page.getByLabel(/材料牌号/).fill('SPCC');
  await page.getByLabel(/标称板厚/).fill('2.0');
  await page.getByLabel(/下允许偏差/).fill('0.05');
  await page.getByLabel(/上允许偏差/).fill('0.05');
  await page.getByLabel(/实测值 1/).fill(measurements[0]);
  await page.getByLabel(/实测值 2/).fill(measurements[1]);
  await page.getByLabel(/实测值 3/).fill(measurements[2]);
}

test.describe('来料板厚抽检（真实联调）', () => {
  test('边界值实测（恰等上下界）判合格并出现在最近记录', async ({ page }) => {
    const batchNo = uniqueBatch();
    await openInspectionView(page);
    // 1.95 = 下界，2.05 = 上界（闭区间，边界判合格）
    await fillForm(page, batchNo, ['1.95', '2.00', '2.05']);
    await page.getByRole('button', { name: '登记抽检' }).click();

    const record = page.getByTestId(`inspection-record-${batchNo}`);
    await expect(record).toBeVisible();
    await expect(page.getByTestId(`inspection-verdict-${batchNo}`)).toHaveText(
      '合格',
    );
    await expect(record).toContainText('合格区间 [1.95, 2.05] mm');
  });

  test('越界实测判不合格并给出越界方向', async ({ page }) => {
    const batchNo = uniqueBatch();
    await openInspectionView(page);
    await fillForm(page, batchNo, ['1.94', '2.00', '2.06']);
    await page.getByRole('button', { name: '登记抽检' }).click();

    await expect(page.getByTestId(`inspection-verdict-${batchNo}`)).toHaveText(
      '不合格',
    );
    await expect(
      page.getByTestId(`inspection-measurement-${batchNo}-1`),
    ).toContainText('越下界');
    await expect(
      page.getByTestId(`inspection-measurement-${batchNo}-3`),
    ).toContainText('越上界');
  });

  test('重复批次：409 错误定位到批次号，输入与列表保留', async ({ page }) => {
    const batchNo = uniqueBatch();
    await openInspectionView(page);
    await fillForm(page, batchNo, ['1.98', '2.00', '2.02']);
    await page.getByRole('button', { name: '登记抽检' }).click();
    await expect(page.getByTestId(`inspection-record-${batchNo}`)).toBeVisible();

    // 同一批次再次登记 → 409，错误落在批次号输入框旁
    await fillForm(page, batchNo, ['2.01', '2.00', '1.99']);
    await page.getByRole('button', { name: '登记抽检' }).click();
    await expect(page.locator('#error-inspection-batch-no')).toContainText(
      '已存在',
    );
    // 输入保留，已加载列表保留
    await expect(page.getByLabel(/批次号/)).toHaveValue(batchNo);
    await expect(page.getByTestId(`inspection-record-${batchNo}`)).toBeVisible();
  });

  test('非法实测值：422 错误定位到具体测量项', async ({ page }) => {
    const batchNo = uniqueBatch();
    await openInspectionView(page);
    await fillForm(page, batchNo, ['1.98', 'abc', '2.02']);
    await page.getByRole('button', { name: '登记抽检' }).click();

    await expect(page.locator('#error-measurement-1')).toContainText('数字');
    // 未出错的测量项不标错
    await expect(page.locator('#error-measurement-0')).toHaveCount(0);
    // 输入保留
    await expect(page.getByLabel(/实测值 2/)).toHaveValue('abc');
  });

  test('抽检登记不影响展开计算结果', async ({ page }) => {
    const batchNo = uniqueBatch();
    await openInspectionView(page);
    // 登记一批明显超差的来料（不合格）
    await fillForm(page, batchNo, ['9', '9', '9']);
    await page.getByRole('button', { name: '登记抽检' }).click();
    await expect(page.getByTestId(`inspection-verdict-${batchNo}`)).toHaveText(
      '不合格',
    );

    // 展开复核结果与抽检前一致
    await page.getByRole('tab', { name: '展开复核' }).click();
    await page.getByLabel(/直段 L1/).fill('100');
    await page.getByLabel(/直段 L2/).fill('50');
    await page.getByRole('button', { name: '计算下料长度' }).click();
    await expect(page.getByTestId('blank-length')).toHaveText('155.75');
  });
});
