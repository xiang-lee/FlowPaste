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
    await page.getByTitle('展开').click();
    
    const editor = page.getByTestId('editor');
    await editor.fill('First article');
    
    // Check first article in list
    const firstArticle = page.locator('.article-item').first();
    await expect(firstArticle).toContainText('First article');

    // Create new
    await page.getByText('+ 新建').click();
    await expect(editor).toHaveValue('');
    
    // Check we have 2 articles
    await expect(page.locator('.article-item')).toHaveCount(2);
  });

  test('Sidebar: Switch between articles', async ({ page }) => {
    // Open sidebar first
    await page.getByTitle('展开').click();
    
    const editor = page.getByTestId('editor');
    
    // Edit first
    await editor.fill('Article A');
    
    // Create second
    await page.getByText('+ 新建').click();
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

  test('Sidebar: Delete article', async ({ page }) => {
    // Open sidebar first
    await page.getByTitle('展开').click();
    
    // Need at least 2 articles to delete one (logic constraint)
    const editor = page.getByTestId('editor');
    await editor.fill('To keep');
    
    await page.getByText('+ 新建').click();
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

  test('Sidebar: Collapse toggle', async ({ page }) => {
    const sidebar = page.locator('.sidebar');
    const toggle = page.getByTitle('展开'); // Initial state title is "展开" because it starts collapsed
    
    await expect(sidebar).toHaveClass(/collapsed/);
    
    await toggle.click();
    await expect(sidebar).not.toHaveClass(/collapsed/);
    
    const collapseToggle = page.getByTitle('收起');
    await collapseToggle.click();
    await expect(sidebar).toHaveClass(/collapsed/);
  });
});
