import { expect, test } from '@playwright/test';

const completionRoute = '**/v1/chat/completions';

test('Regression: Streaming updates should not swallow surrounding text', async ({ page }) => {
  // Mock a streaming response with multiple chunks
  // We simulate the AI returning "FIXED" in 3 chunks: "FI", "X", "ED"
  const streamBody = [
    `data: {"choices":[{"delta":{"content":"FI"}}]}`, 
    `data: {"choices":[{"delta":{"content":"X"}}]}`, 
    `data: {"choices":[{"delta":{"content":"ED"}}]}`, 
    `data: [DONE]`
  ].join('\n\n');

  await page.route(completionRoute, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: streamBody,
    });
  });

  await page.goto('/');
  const editor = page.getByTestId('editor');
  
  // Setup initial text: "PREFIX-[TARGET]-SUFFIX"
  // We want to replace "TARGET" with "FIXED"
  // If the bug exists, "SUFFIX" might be deleted or corrupted
  await editor.fill('PREFIX-TARGET-SUFFIX');
  
  // Select "TARGET"
  // "PREFIX-" is 7 chars. "TARGET" is 6 chars.
  // Start: 7, End: 13
  await editor.evaluate((el) => {
    el.focus();
    // @ts-ignore
    el.setSelectionRange(7, 13);
  });

  // Trigger Fix
  await page.getByTestId('fix-button').click();

  // Wait for the final text
  await expect(editor).toHaveValue('PREFIX-FIXED-SUFFIX');
});

test('Regression: Polish button should also handle streaming and preserve context', async ({ page }) => {
  const streamBody = [
    `data: {"choices":[{"delta":{"content":"BEAUTIFUL"}}]}`,
    `data: [DONE]`
  ].join('\n\n');

  await page.route(completionRoute, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: streamBody,
    });
  });

  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Old text');
  await editor.selectText(); // Select all
  
  await page.getByTestId('polish-button').click();

  await expect(editor).toHaveValue('BEAUTIFUL');
});

test('Regression: Toolbar buttons (Fix & Polish) should not cause editor to lose focus', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor');
  await editor.fill('Test Focus');
  
  await page.route(completionRoute, (route) => route.abort());

  // Test Fix Button
  await editor.focus();
  await page.getByTestId('fix-button').click();
  await expect(editor).toBeFocused();

  // Test Polish Button
  await editor.focus();
  await page.getByTestId('polish-button').click();
  await expect(editor).toBeFocused();
});
test('Regression: Missing Token should not crash/block but allow Proxy to handle it', async ({ page }) => {
    // This tests the removal of "if (!TOKEN) return" check.
    // We simulate a scenario where the frontend doesn't have a token (default in test env usually), 
    // and we ensure the request is actually sent to the backend (mocked).
    
    let requestMade = false;
    await page.route(completionRoute, (route) => {
        requestMade = true;
        route.fulfill({ status: 200, body: `data: [DONE]\n\n` }); // empty stream
    });

    await page.goto('/');
    const editor = page.getByTestId('editor');
    await editor.fill('content');
    
    // Setup state so button works
    await editor.evaluate((el) => {
        // @ts-ignore
        el.setSelectionRange(0, 7);
    });

    await page.getByTestId('fix-button').click();
    
    // Wait a bit for the async action
    await page.waitForTimeout(500);
    
    expect(requestMade).toBe(true);
});
