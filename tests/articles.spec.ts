import { expect, test } from '@playwright/test';

test.describe('Article Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Clear localStorage to start fresh for each test (though Playwright contexts are usually fresh, explicit is good for some setups)
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('Persistence: Content survives reload', async ({ page }) => {
    const editor = page.getByTestId('editor');
    await editor.fill('Persisted content');
    await page.reload();
    await expect(editor).toHaveValue('Persisted content');
  });

  test('Sidebar: Create new article', async ({ page }) => {
    // Open sidebar first
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();
    
    const editor = page.getByTestId('editor');
    await editor.fill('First article');
    
    // Check first article in list
    const firstArticle = page.locator('.article-item').first();
    await expect(firstArticle).toContainText('First article');

    // Create new
    await page.locator('.sidebar-header .btn.primary.small').click();
    await expect(editor).toHaveValue('');
    
    // Check we have 2 articles
    await expect(page.locator('.article-item')).toHaveCount(2);
  });

  test('Sidebar: Switch between articles', async ({ page }) => {
    // Open sidebar first
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();
    
    const editor = page.getByTestId('editor');
    
    // Edit first
    await editor.fill('Article A');
    
    // Create second
    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Article B');
    
    // Switch back to first (it's the second in list because new ones are added to top usually, or we need to check logic)
    // My logic: setArticles(prev => [newArticle, ...prev]); -> Newest on top.
    // So "Article A" is now the second item.
    
    const articles = page.locator('.article-item');
    await articles.nth(1).click(); // Click the second one (older)
    await expect(editor).toHaveValue('Article A');
    
    await articles.nth(0).click(); // Click the first one (newer)
    await expect(editor).toHaveValue('Article B');
  });

  test('Sidebar: Recently edited article moves to top', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const editor = page.getByTestId('editor');
    await editor.fill('Article A');

    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Article B');

    const articles = page.locator('.article-item');
    await expect(articles.first()).toContainText('Article B');

    await articles.nth(1).click();
    await expect(editor).toHaveValue('Article A');

    await editor.fill('Article A updated');

    await expect(articles.first()).toContainText('Article A updated');
    await expect(articles.nth(1)).toContainText('Article B');
  });

  test('Sidebar: Delete article', async ({ page }) => {
    // Open sidebar first
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();
    
    // Need at least 2 articles to delete one (logic constraint)
    const editor = page.getByTestId('editor');
    await editor.fill('To keep');
    
    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('To delete');
    
    // Confirm dialog
    page.on('dialog', dialog => dialog.accept());
    
    // Hover over the first article (the active one "To delete") to show delete button
    const firstArticle = page.locator('.article-item').first();
    await firstArticle.hover();
    await firstArticle.locator('.delete-btn').click();
    
    await expect(page.locator('.article-item')).toHaveCount(1);
    await expect(editor).toHaveValue('To keep');
  });

  test('Sidebar: Delete article can be undone', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const editor = page.getByTestId('editor');
    await editor.fill('To keep');

    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Delete me');

    page.on('dialog', (dialog) => dialog.accept());

    const firstArticle = page.locator('.article-item').first();
    await firstArticle.hover();
    await firstArticle.locator('.delete-btn').click();

    await expect(page.locator('.article-item')).toHaveCount(1);
    await expect(editor).toHaveValue('To keep');

    await page.getByTestId('toast').getByRole('button', { name: 'Undo' }).click();

    await expect(page.locator('.article-item')).toHaveCount(2);
    await expect(editor).toHaveValue('Delete me');
  });

  test('Sidebar: Collapse toggle', async ({ page }) => {
    const sidebar = page.locator('.sidebar');
    const toggle = page.locator('.sidebar-header .btn.ghost.icon-only');
    
    await expect(sidebar).toHaveClass(/collapsed/);
    
    await toggle.click();
    await expect(sidebar).not.toHaveClass(/collapsed/);
    
    await toggle.click();
    await expect(sidebar).toHaveClass(/collapsed/);
  });

  test('Sidebar: Collapse state survives reload', async ({ page }) => {
    const sidebar = page.locator('.sidebar');
    const toggle = page.locator('.sidebar-header .btn.ghost.icon-only');

    await toggle.click();
    await expect(sidebar).not.toHaveClass(/collapsed/);

    await page.reload();

    await expect(sidebar).not.toHaveClass(/collapsed/);
  });

  test('Sidebar: Empty article title follows current language', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const firstArticle = page.locator('.article-item').first();
    await expect(firstArticle).toContainText('Untitled');

    await page.getByRole('button', { name: '中' }).click();

    await expect(firstArticle).toContainText('未命名');
  });

  test('Toolbar: Duplicate current article', async ({ page }) => {
    const editor = page.getByTestId('editor');
    await editor.fill('Original title\nSecond line');

    await page.getByTestId('actions-menu-button').click();
    await page.getByTestId('duplicate-article-button').click();
    await expect(editor).toHaveValue('Original title\nSecond line');
    await expect(page.getByTestId('toast')).toContainText('Article duplicated');

    await page.locator('.sidebar-header .btn.ghost.icon-only').click();
    const articles = page.locator('.article-item');

    await expect(articles).toHaveCount(2);
    await expect(articles.first()).toContainText('Original title (copy)');
    await expect(articles.nth(1)).toContainText('Original title');
  });

  test('Sidebar: Search filters articles', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const editor = page.getByTestId('editor');
    await editor.fill('Alpha note');

    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Beta note');

    await page.getByTestId('article-search-input').fill('Alpha');

    const articles = page.locator('.article-item');
    await expect(articles).toHaveCount(1);
    await expect(articles.first()).toContainText('Alpha note');

    await page.getByTestId('article-search-input').fill('Gamma');
    await expect(page.locator('.article-item')).toHaveCount(0);
    await expect(page.getByTestId('article-search-empty')).toContainText('No matching articles');
  });

  test('Sidebar: Search can be cleared quickly', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const editor = page.getByTestId('editor');
    await editor.fill('Alpha note');

    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Beta note');

    const search = page.getByTestId('article-search-input');
    await search.fill('Alpha');
    await expect(page.locator('.article-item')).toHaveCount(1);

    await page.getByTestId('article-search-clear').click();
    await expect(search).toHaveValue('');
    await expect(page.locator('.article-item')).toHaveCount(2);

    await search.fill('Beta');
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page.locator('.article-item')).toHaveCount(2);
  });

  test('Sidebar: Search shows matching content preview', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const editor = page.getByTestId('editor');
    await editor.fill('Alpha title\nSecond line');

    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Project note\nContains zebra keyword in the body');

    await page.getByTestId('article-search-input').fill('zebra');

    const articles = page.locator('.article-item');
    await expect(articles).toHaveCount(1);
    await expect(articles.first()).toContainText('Project note');
    await expect(page.getByTestId('article-search-snippet')).toContainText('zebra');
    await expect(page.locator('.article-item .match-mark')).toContainText('zebra');
  });

  test('Sidebar: Ctrl+K opens and focuses article search', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const editor = page.getByTestId('editor');
    await editor.fill('Alpha note');

    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Beta note');

    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    await page.keyboard.press('Control+K');

    const search = page.getByTestId('article-search-input');
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();

    await search.fill('Alpha');
    await expect(page.locator('.article-item')).toHaveCount(1);
    await expect(page.locator('.article-item').first()).toContainText('Alpha note');
  });

  test('Sidebar: Enter opens the first filtered article', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const editor = page.getByTestId('editor');
    await editor.fill('Alpha note');

    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Beta note');

    const search = page.getByTestId('article-search-input');
    await search.fill('Alpha');
    await search.press('Enter');

    await expect(editor).toHaveValue('Alpha note');
  });

  test('Sidebar: Arrow keys change which search result Enter opens', async ({ page }) => {
    await page.locator('.sidebar-header .btn.ghost.icon-only').click();

    const editor = page.getByTestId('editor');
    await editor.fill('Alpha first');

    await page.locator('.sidebar-header .btn.primary.small').click();
    await editor.fill('Alpha second');

    const search = page.getByTestId('article-search-input');
    await search.fill('Alpha');

    await expect(page.locator('.article-item')).toHaveCount(2);
    await expect(page.locator('.article-item').first()).toContainText('Alpha second');

    await search.press('ArrowDown');
    await search.press('Enter');

    await expect(editor).toHaveValue('Alpha first');
  });
});
