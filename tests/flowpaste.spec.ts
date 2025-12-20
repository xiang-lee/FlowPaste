import { expect, test } from '@playwright/test';

const transcriptionRoute = '**/v1/audio/transcriptions';
const completionRoute = '**/v1/chat/completions';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Minimal MediaRecorder stub for tests
    class FakeMediaRecorder {
      public ondataavailable: ((event: { data: Blob }) => void) | null = null;
      public onstop: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public state: 'inactive' | 'recording' = 'inactive';
      constructor(_stream: MediaStream) {}
      start() {
        this.state = 'recording';
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(['fake audio'], { type: 'audio/webm' }) });
        }, 10);
      }
      stop() {
        this.state = 'inactive';
        setTimeout(() => this.onstop?.(), 10);
      }
      addEventListener() {}
    }

    Object.defineProperty(window, 'MediaRecorder', {
      value: FakeMediaRecorder,
      configurable: true,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
      configurable: true,
    });
  });
});

test('录音状态机：开始→停止→转写→成功', async ({ page }) => {
  await page.route(transcriptionRoute, async (route) => {
    await page.waitForTimeout(150); // allow UI to show转写中
    await route.fulfill({ json: { text: 'transcribed text' } });
  });

  await page.goto('/');
  const recordButton = page.getByTestId('record-button');
  const statusDot = page.getByTestId('recording-status');

  await recordButton.click();
  await expect(statusDot).toHaveAttribute('aria-label', 'recording');

  await recordButton.click();
  await expect(statusDot).toHaveAttribute('aria-label', 'transcribing');

  await expect(page.getByTestId('editor')).toHaveValue('transcribed text');
  await expect(statusDot).toHaveAttribute('aria-label', 'idle');
});

test('转写插入在光标处', async ({ page }) => {
  await page.route(transcriptionRoute, (route) => route.fulfill({ json: { text: ' world' } }));
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Hello');
  await editor.evaluate((el) => {
    el.focus();
    // @ts-ignore
    el.setSelectionRange(3, 3);
  });

  const recordButton = page.getByTestId('record-button');
  await recordButton.click();
  await recordButton.click();

  await expect(editor).toHaveValue('Hel worldlo');
});

test('Fix 主路径 + 撤销', async ({ page }) => {
  await page.route(completionRoute, (route) =>
    route.fulfill({
      json: { choices: [{ message: { content: 'This' } }] },
    }),
  );
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Ths is bad.');
  await editor.evaluate((el) => {
    el.focus();
    // @ts-ignore
    el.setSelectionRange(0, 3);
  });
  await page.getByTestId('fix-button').click();
  await expect(editor).toHaveValue('This is bad.');
  await page.getByTestId('undo-button').click();
  await expect(editor).toHaveValue('Ths is bad.');
});

test('Polish 主路径 + 撤销', async ({ page }) => {
  await page.route(completionRoute, (route) =>
    route.fulfill({
      json: { choices: [{ message: { content: 'Polished text body' } }] },
    }),
  );
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('rough text');
  await page.getByTestId('polish-button').click();
  await expect(editor).toHaveValue('Polished text body');
  await page.getByTestId('undo-button').click();
  await expect(editor).toHaveValue('rough text');
});

test('失败路径：401 与网络错误保持正文不变并提示', async ({ page }) => {
  await page.route(completionRoute, (route) => route.fulfill({ status: 401, json: { detail: 'bad token' } }));
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('text to fix');
  await page.getByTestId('fix-button').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible();
  await expect(editor).toHaveValue('text to fix');

  await page.unroute(completionRoute);
  await page.route(completionRoute, (route) => route.abort('internetdisconnected'));
  await page.getByTestId('fix-button').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(editor).toHaveValue('text to fix');
});

test('长文本策略：无选区会提示确认', async ({ page }) => {
  await page.route(completionRoute, (route) =>
    route.fulfill({ json: { choices: [{ message: { content: 'trimmed' } }] } }),
  );
  await page.goto('/');
  const editor = page.getByTestId('editor');
  const longText = 'a'.repeat(8100);
  await editor.fill(longText);

  page.on('dialog', async (dialog) => {
    expect(dialog.message()).toContain('建议选中段落');
    await dialog.accept();
  });

  await page.getByTestId('fix-button').click();
  await expect(editor).toHaveValue('trimmed');
});

test('所见编辑模式可以输入并同步回 Markdown', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '所见编辑' }).click();
  const wysiwyg = page.getByTestId('wysiwyg-editor');
  await wysiwyg.click();
  await wysiwyg.type('Hello WYSIWYG');
  await page.getByRole('button', { name: 'Markdown' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toHaveValue('Hello WYSIWYG');
});
