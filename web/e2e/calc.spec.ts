import { expect, test } from '@playwright/test';

const firstBend = (page: import('@playwright/test').Page) =>
  page.getByRole('group', { name: '第 1 道折弯' });

test.describe('折弯展开复核台（真实联调）', () => {
  test('合法计算：显示逐道代入值、未舍入总长与唯一下料长度', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel(/直段 L1/).fill('100');
    await page.getByLabel(/直段 L2/).fill('50');
    await firstBend(page).getByLabel(/角度/).fill('90');
    await firstBend(page).getByLabel(/板厚/).fill('2');
    await firstBend(page).getByLabel(/内半径/).fill('3');
    await firstBend(page).getByLabel(/K 因子/).fill('0.33');
    await page.getByRole('button', { name: '计算下料长度' }).click();

    // 逐道代入值与六位补偿量
    await expect(page.getByTestId('bend-rkt-1')).toHaveText('3.66');
    await expect(page.getByTestId('bend-allowance-1')).toHaveText('5.749115');
    // 未舍入总长（完整精度）
    await expect(page.getByTestId('unrounded-total')).toContainText(
      '155.7491145560693',
    );
    // 唯一的下料长度：ROUND_HALF_UP 两位
    await expect(page.getByTestId('blank-length')).toHaveText('155.75');
    await expect(page.getByTestId('blank-length')).toHaveCount(1);
  });

  test('两道折弯：n+1 直段联动并给出正确总长', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /添加一道折弯/ }).click();

    await page.getByLabel(/直段 L1/).fill('100');
    await page.getByLabel(/直段 L2/).fill('50');
    await page.getByLabel(/直段 L3/).fill('40');
    await firstBend(page).getByLabel(/角度/).fill('90');
    await firstBend(page).getByLabel(/板厚/).fill('2');
    await firstBend(page).getByLabel(/内半径/).fill('3');
    await firstBend(page).getByLabel(/K 因子/).fill('0.33');
    const secondBend = page.getByRole('group', { name: '第 2 道折弯' });
    await secondBend.getByLabel(/角度/).fill('60');
    await secondBend.getByLabel(/板厚/).fill('1.5');
    await secondBend.getByLabel(/内半径/).fill('2');
    await secondBend.getByLabel(/K 因子/).fill('0.4');
    await page.getByRole('button', { name: '计算下料长度' }).click();

    // 第 2 道：π÷180×60×(2+0.4×1.5) = π/3×2.6 = 2.722714（六位）
    await expect(page.getByTestId('bend-rkt-2')).toHaveText('2.6');
    await expect(page.getByTestId('bend-allowance-2')).toHaveText('2.722714');
    // 总长 = 190 + 5.7491145560693... + 2.7227136331111... → 198.47
    await expect(page.getByTestId('blank-length')).toHaveText('198.47');
  });

  test('非法提交后保留上一份有效结果', async ({ page }) => {
    await page.goto('/');

    // 先做一次合法计算
    await page.getByLabel(/直段 L1/).fill('100');
    await page.getByLabel(/直段 L2/).fill('50');
    await page.getByRole('button', { name: '计算下料长度' }).click();
    await expect(page.getByTestId('blank-length')).toHaveText('155.75');

    // 改成非法角度（0 不在 0~180 开区间内）再次提交
    await firstBend(page).getByLabel(/角度/).fill('0');
    await page.getByRole('button', { name: '计算下料长度' }).click();

    // 字段级错误出现
    await expect(page.locator('#error-bend-0-angle')).toBeVisible();
    await expect(page.locator('#error-bend-0-angle')).toContainText('大于 0');
    // 上一份有效结果必须保留，不被非法提交替换
    await expect(page.getByTestId('blank-length')).toHaveText('155.75');
    await expect(page.getByTestId('unrounded-total')).toContainText(
      '155.7491145560693',
    );
  });

  test('非有限数值（NaN）被字段级拒绝', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/直段 L1/).fill('NaN');
    await page.getByRole('button', { name: '计算下料长度' }).click();
    await expect(page.locator('#error-segment-0')).toContainText('有限');
    await expect(page.getByTestId('result-panel')).toHaveCount(0);
  });

  test('超大但有限的直段返回对应下料长度', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/直段 L1/).fill('1e30');
    await page.getByLabel(/直段 L2/).fill('1');
    // 默认折弯 90°/板厚2/内半径3/K0.33 → 补偿 5.749114556...
    await page.getByRole('button', { name: '计算下料长度' }).click();

    // 1e30 + 1 + 5.749114556... → ...006.75（ROUND_HALF_UP 两位）
    await expect(page.getByTestId('blank-length')).toHaveText(
      `1${'0'.repeat(29)}6.75`,
    );
    await expect(page.getByTestId('general-error')).toHaveCount(0);
  });

  test('1e999 毫米直段加 1 毫米：1 毫米保留在下料长度里', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/直段 L1/).fill('1e999');
    await page.getByLabel(/直段 L2/).fill('1');
    // 默认折弯补偿 5.749114556... → 总长 = 1e999 + 1 + 5.749114556...
    await page.getByRole('button', { name: '计算下料长度' }).click();

    // 直段合计必须精确保住那 1 毫米
    await expect(page.getByTestId('segments-total')).toHaveText(
      `1${'0'.repeat(998)}1`,
    );
    // 下料长度：...006.75（1 + 5.749... 都在）
    await expect(page.getByTestId('blank-length')).toHaveText(
      `1${'0'.repeat(998)}6.75`,
    );
  });
});
