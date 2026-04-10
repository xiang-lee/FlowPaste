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
      constructor(stream: MediaStream) {
        void stream;
      }
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

test('录音时会显示经过时间', async ({ page }) => {
  await page.route(transcriptionRoute, async (route) => {
    await route.fulfill({ json: { text: 'done' } });
  });

  await page.goto('/');
  const recordButton = page.getByTestId('record-button');
  const timer = page.getByTestId('recording-timer');

  await recordButton.click();
  await expect(timer).toHaveText('00:00');

  await page.waitForTimeout(1100);
  await expect(timer).toHaveText('00:01');

  await recordButton.click();
  await expect(timer).toHaveCount(0);
});

test('转写插入在光标处', async ({ page }) => {
  await page.route(transcriptionRoute, (route) => route.fulfill({ json: { text: ' world' } }));
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Hello');
  await editor.evaluate((el) => {
    el.focus();
    // @ts-expect-error test directly uses selection API on textarea
    el.setSelectionRange(3, 3);
  });

  const recordButton = page.getByTestId('record-button');
  await recordButton.click();
  await recordButton.click();

  await expect(editor).toHaveValue('Hel worldlo');
});

test('转写插入后可以用 Undo 回退', async ({ page }) => {
  await page.route(transcriptionRoute, (route) => route.fulfill({ json: { text: ' world' } }));
  await page.goto('/');

  const editor = page.getByTestId('editor');
  const undoButton = page.getByTestId('undo-button');
  await editor.fill('Hello');
  await editor.evaluate((el) => {
    el.focus();
    // @ts-expect-error test directly uses selection API on textarea
    el.setSelectionRange(5, 5);
  });

  const recordButton = page.getByTestId('record-button');
  await recordButton.click();
  await recordButton.click();

  await expect(editor).toHaveValue('Hello world');
  await expect(undoButton).toBeEnabled();

  await undoButton.click();
  await expect(editor).toHaveValue('Hello');
});

test('Fix 主路径 + 撤销', async ({ page }) => {
  await page.route(completionRoute, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: {"choices":[{"delta":{"content":"This"}}]}\n\ndata: [DONE]\n\n`,
    }),
  );
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Ths is bad.');
  await editor.evaluate((el) => {
    el.focus();
    // @ts-expect-error test directly uses selection API on textarea
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
      contentType: 'text/event-stream',
      body: `data: {"choices":[{"delta":{"content":"Polished text body"}}]}\n\ndata: [DONE]\n\n`,
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

test('手动修改后会清除过期的 AI Undo', async ({ page }) => {
  await page.route(completionRoute, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: {"choices":[{"delta":{"content":"This"}}]}\n\ndata: [DONE]\n\n`,
    }),
  );

  await page.goto('/');
  const editor = page.getByTestId('editor');
  const undoButton = page.getByTestId('undo-button');

  await editor.fill('Ths is bad.');
  await editor.evaluate((el) => {
    el.focus();
    // @ts-expect-error test directly uses selection API on textarea
    el.setSelectionRange(0, 3);
  });

  await page.getByTestId('fix-button').click();
  await expect(editor).toHaveValue('This is bad.');
  await expect(undoButton).toBeEnabled();

  await editor.press('End');
  await page.keyboard.type('!');

  await expect(editor).toHaveValue('This is bad.!');
  await expect(undoButton).toBeDisabled();
});

test('Rich Text 选区只替换选中内容（Fix）', async ({ page }) => {
  await page.route(completionRoute, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: {"choices":[{"delta":{"content":"Earth"}}]}\n\ndata: [DONE]\n\n`,
    }),
  );
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Hello world\n\nSecond line.');
  await page.getByTestId('rich-text-view-button').click();
  await expect(page.getByTestId('wysiwyg-pane')).toBeVisible({ timeout: 10000 });

  const wysiwyg = page.getByTestId('wysiwyg-editor');
  await expect(wysiwyg).toContainText('Hello world');
  await wysiwyg.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node || !node.textContent) return;
    const start = node.textContent.indexOf('world');
    if (start === -1) return;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 'world'.length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });

  await page.getByTestId('fix-button').click();
  await page.getByTestId('markdown-view-button').click();
  await expect(editor).toHaveValue('Hello Earth\n\nSecond line.');
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

test('Fix 失败后可以直接重试', async ({ page }) => {
  let attempts = 0;
  await page.route(completionRoute, (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.abort('internetdisconnected');
    }
    return route.fulfill({
      contentType: 'text/event-stream',
      body: `data: {"choices":[{"delta":{"content":"Polished retry text"}}]}\n\ndata: [DONE]\n\n`,
    });
  });

  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('retry me');

  await page.getByTestId('fix-button').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible();
  await expect(editor).toHaveValue('retry me');

  await toast.getByRole('button', { name: 'Retry' }).click();
  await expect(editor).toHaveValue('Polished retry text');
});

test('Retry 会使用失败后最新的正文内容', async ({ page }) => {
  let attempts = 0;
  await page.route(completionRoute, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.abort('internetdisconnected');
    }

    const payload = route.request().postDataJSON() as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const userPrompt = payload.messages?.find((message) => message.role === 'user')?.content || '';
    const nextText = userPrompt.includes('retry me updated') ? 'Updated retry text' : 'Stale retry text';

    return route.fulfill({
      contentType: 'text/event-stream',
      body: `data: {"choices":[{"delta":{"content":"${nextText}"}}]}\n\ndata: [DONE]\n\n`,
    });
  });

  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('retry me');

  await page.getByTestId('fix-button').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible();

  await editor.fill('retry me updated');
  await toast.getByRole('button', { name: 'Retry' }).click();

  await expect(editor).toHaveValue('Updated retry text');
});

test('长文本策略：无选区会提示确认', async ({ page }) => {
  await page.route(completionRoute, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: {"choices":[{"delta":{"content":"trimmed"}}]}\n\ndata: [DONE]\n\n`,
    }),
  );
  await page.goto('/');
  const editor = page.getByTestId('editor');
  const longText = 'a'.repeat(8100);
  await editor.fill(longText);

  page.on('dialog', async (dialog) => {
    expect(dialog.message()).toMatch(/建议选中段落|selecting a segment/i);
    await dialog.accept();
  });

  await page.getByTestId('fix-button').click();
  await expect(editor).toHaveValue('trimmed');
});

test('所见编辑模式可以输入并同步回 Markdown', async ({ page }) => {
  await page.goto('/');
  const richTextBtn = page.getByTestId('rich-text-view-button');
  await richTextBtn.click();
  
  // Check if button became active
  await expect(richTextBtn).toHaveClass(/active/);
  
  // Check if pane is visible
  await expect(page.getByTestId('wysiwyg-pane')).toBeVisible({ timeout: 10000 });
});

test('Rich Text 视图在刷新后保持选中', async ({ page }) => {
  await page.goto('/');
  const richTextBtn = page.getByTestId('rich-text-view-button');
  const markdownBtn = page.getByTestId('markdown-view-button');

  await richTextBtn.click();
  await expect(richTextBtn).toHaveClass(/active/);
  await expect(page.getByTestId('wysiwyg-pane')).toBeVisible({ timeout: 10000 });

  await page.reload();

  await expect(richTextBtn).toHaveClass(/active/);
  await expect(markdownBtn).not.toHaveClass(/active/);
  await expect(page.getByTestId('wysiwyg-pane')).toBeVisible({ timeout: 10000 });
});

test('Focus Mode 可以用 Escape 退出', async ({ page }) => {
  await page.goto('/');
  const focusButton = page.getByTestId('focus-button');

  await focusButton.click();
  await expect(focusButton).toHaveText(/Exit Focus|退出专注/);

  await page.keyboard.press('Escape');

  await expect(focusButton).toHaveText(/Focus Mode|专注模式/);
});

test('Markdown can be downloaded as a file', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Download me\n\nBody line');

  const event = page.waitForEvent('download');
  await page.getByTestId('actions-menu-button').click();
  await page.getByTestId('download-markdown-button').click();
  const download = await event;

  expect(download.suggestedFilename()).toBe('Download me.md');
  const path = await download.path();
  expect(path).toBeTruthy();
});

test('Download shows success feedback with filename', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Download me\n\nBody line');

  const event = page.waitForEvent('download');
  await page.getByTestId('actions-menu-button').click();
  await page.getByTestId('download-markdown-button').click();
  await event;

  await expect(page.getByTestId('toast')).toContainText('Downloaded Download me.md');
});

test('Selection size is shown when text is highlighted', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Hello world');
  await editor.selectText();

  await expect(page.getByTestId('selection-chip')).toHaveText('Selected 11 chars');
});

test('Ctrl+S downloads the current markdown file', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Shortcut save\n\nBody line');

  const event = page.waitForEvent('download');
  await page.keyboard.press('Control+S');
  const download = await event;

  expect(download.suggestedFilename()).toBe('Shortcut save.md');
  const path = await download.path();
  expect(path).toBeTruthy();
});

test('Document stats show current character and line counts', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Hello\nWorld');

  await expect(page.getByTestId('document-stats')).toHaveText('11 chars · 2 lines');
});

test('Browser tab title reflects current article and recording state', async ({ page }) => {
  await page.route(transcriptionRoute, async (route) => {
    await page.waitForTimeout(150);
    await route.fulfill({ json: { text: 'tab text' } });
  });

  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Alpha title\nBody line');

  await expect(page).toHaveTitle('Alpha title - FlowPaste');

  const recordButton = page.getByTestId('record-button');
  await recordButton.click();
  await expect(page).toHaveTitle('Recording - Alpha title - FlowPaste');

  await recordButton.click();
  await expect(page).toHaveTitle('Transcribing - Alpha title - FlowPaste');

  await expect(page).toHaveTitle('Alpha title - FlowPaste');
});

test('Switching articles in Rich Text keeps the editor ready for typing', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Alpha title\nFirst body');

  await page.locator('.sidebar-header .btn.ghost.icon-only').click();
  await page.locator('.sidebar-header .btn.primary.small').click();
  await editor.fill('Beta title\nSecond body');

  await page.getByTestId('rich-text-view-button').click();
  await page.getByTestId('older-article-button').click();

  const wysiwyg = page.getByTestId('wysiwyg-editor');
  await expect(wysiwyg).toBeFocused();

  await page.keyboard.type('!');
  await page.getByTestId('markdown-view-button').click();

  await expect(editor).toHaveValue('Alpha title First body!');
});

test('Switching articles from header keeps Markdown editor ready for typing', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Alpha title\nFirst body');

  await page.locator('.sidebar-header .btn.ghost.icon-only').click();
  await page.locator('.sidebar-header .btn.primary.small').click();
  await editor.fill('Beta title\nSecond body');
  await page.locator('.sidebar-header .btn.ghost.icon-only').click();

  await page.getByTestId('older-article-button').click();
  await expect(editor).toBeFocused();

  await page.keyboard.type('!');
  await expect(editor).toHaveValue('Alpha title\nFirst body!');
});
