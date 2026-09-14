import { defineConfig } from '@playwright/test';

// 端到端真实联调：Playwright 同时拉起 API（uvicorn）与 Web（vite dev，代理 /api）
const API_PORT = Number(process.env.E2E_API_PORT ?? 8101);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5199);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
  },
  webServer: [
    {
      command: `.venv/bin/python -m uvicorn app.main:app --port ${API_PORT}`,
      cwd: '../api',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run dev -- --port ${WEB_PORT} --strictPort`,
      env: { API_ORIGIN: `http://localhost:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
