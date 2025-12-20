# FlowPaste MVP Plan & Setup

## 最短闭环用户流程
- 打开网页即看到大字号编辑区与底部固定工具条（录音/Fix/Polish/撤销/专注）。
- 点击录音进入录音中状态；再次点击停止，UI 切换为「转写中」；完成后转写文本直接写入编辑区末尾或光标处（行为固定且可预测）。
- 选中片段后点击 Fix/Polish：先记录快照 → 调用 API → 成功后直接替换选区（无选区则处理全文）；出现轻提示 + 撤销按钮；撤销恢复快照。
- 任何错误：提示原因 + 重试入口，编辑区内容保持不变；处理状态可随时取消以恢复可操作。
- 专注模式：全屏/隐藏多余元素，不影响工具条与撤销。

## 关键界面结构（文字版 wireframe）
- 布局：单页，背景纯净；中央为高行距、大字号的可编辑文本区（textarea）。
- 底部固定工具条：`录音`（状态：空闲/录音中/转写中/失败）、`Fix`、`Polish`、`撤销`（仅可撤销时高亮）、`专注`。
- 状态提示：右下 toast/状态栏，显示「转写中」「已应用 Fix」「超时，可重试」等，并附带撤销或重试按钮。
- 交互规则：处理优先选区；无选区则全文。长文本超过阈值时，Fix 允许但提示；Polish 强提示分段处理。

## API 接入设计
- 基址：`https://space.ai-builders.com/backend`
- 鉴权：请求头 `Authorization: Bearer ${VITE_AI_BUILDER_TOKEN}`（写在 `.env`，前缀 VITE_）。
- 超时：Fetch 30s（转写建议 60s）；网络错误/超时自动重试 1 次（0.8s → 1.6s 退避）；其余情况仅手动重试。可通过 `AbortController` 取消并恢复可操作状态。

### 语音转文字
- `POST /v1/audio/transcriptions` (multipart/form-data)
- 字段：`audio_file` (binary) 或 `audio_url`；可选 `language`（如 `zh-CN`）。
- 成功：`text` 为正文。失败分类：401/403（提示检查 token）、422（参数错误）、超时/断网（提示网络问题 + 重试）。
- 插入策略：固定规则（建议光标处插入），保证可预测；若转写失败，不改编辑区。

### Fix / Polish（Chat Completions）
- `POST /v1/chat/completions`，默认 `model: supermind-agent-v1`；禁止工具调用（不传 `tools`，`tool_choice: "none"`）。
- `messages`：system 使用对应提示词，user 放选区或全文。取 `choices[0].message.content`。
- 错误处理同上；无选区且文本超阈值（6k–10k 字符）时，发送前提示用户分段；Polish 强提示分段。
- 应用流程：调用前保存快照 → 成功后替换 → toast「已应用 Fix/Polish」+ 撤销 → 撤销恢复快照。

### 请求示例
```ts
// transcription
const fd = new FormData();
fd.append('audio_file', fileBlob);
const ctrl = new AbortController();
const res = await fetch(`${BASE}/v1/audio/transcriptions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: fd,
  signal: ctrl.signal,
});

// fix/polish
const body = {
  model: 'supermind-agent-v1',
  tool_choice: 'none',
  messages: [
    { role: 'system', content: FIX_SYSTEM_PROMPT },
    { role: 'user', content: selection ? selectionUser(selection) : fullUser(text) },
  ],
};
const res2 = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
  signal: ctrl.signal,
});
```

## Fix 与 Polish 提示词（最终版，可直接用）
- Fix system：
```
你是一个严格克制的文字修正器。你的任务是把用户文本中的错别字、明显语法问题、标点与分段做最小必要修正。
硬性规则：
- 绝对不能改变事实、观点、逻辑顺序与段落结构
- 不要扩写，不要加入新信息，不要改变语气
- 可以保留口语风格，但把明显影响理解的地方修到可读
输出格式：只输出修正后的全文正文，不要给任何解释、清单或标题。
```
- Polish system：
```
你是一个写作润色助手，目标是提升可读性、连贯性与表达质感，同时保持作者语气自然克制。
硬性规则：
- 不能引入新事实或编造细节；不确定的内容不要补
- 允许适度改写句子以更顺更清晰，但不要写得浮夸
- 尽量保留原意与重点，避免信息发生变化
输出格式：只输出润色后的全文正文，不要给任何解释、清单或标题。
```
- user 模板（有选区）：
```
请只处理下面这段文本（保持原意，不要添加任何新信息）。你的输出将被直接替换这段文本，因此只输出替换后的文本正文：
<SELECTION>
```
- user 模板（无选区）：
```
请处理下面全文（保持原意，不要添加任何新信息）。只输出处理后的正文：
<FULL_TEXT>
```

## 长文本与成本策略
- 有选区优先，仅处理选区。
- 无选区且 > ~6k–10k 字符：Fix 弹出提示“建议选中段落再处理（更快、更稳、避免误改）”，仍允许继续；Polish 强提示分段处理（需确认）。
- 在 toast 中解释节省 token 的好处，避免一次大调用。

## 里程碑式实现计划
1) 基础壳：编辑区 + 工具条 UI、专注模式、toast 组件、撤销栈（1 层）。  
2) 录音状态机：录音/停止/转写中/完成/失败，调用转写 API，插入策略与重试。  
3) Fix/Polish 流程：快照、选区/全文处理、应用+撤销、长文本提示、错误兜底。  
4) 稳定性与测试：异常覆盖、自动重试、可取消；Playwright 端到端（含 mock）；视觉微调。  
5) 性能与体验：节流状态更新、loading 动画、无丢稿保障、打点/日志（可选）。

## 风险清单与应对
- 延迟：转写/LLM 响应慢 → 明确状态提示、允许取消、超时自动退避重试一次。
- 成本：长文本导致高消耗 → 选区优先、阈值提示、分段引导。
- 误改：Fix/Polish 语义漂移 → 系统提示词限制 + 默认工具禁用 + 撤销快照。
- 网络失败/断网：捕获 fetch 异常，toast 展示「网络异常，可重试」，不改编辑区。
- 权限问题：401/403 → 提示检查 token，保留重试按钮。
- 撤销丢失：至少一层快照；操作前保存；撤销后清空快照避免误覆写。

## 自动化测试方案（Playwright + mock 拦截）
- 录音状态机：模拟录音按钮点击序列，拦截转写 API，断言状态从空闲 → 录音中 → 转写中 → 成功/失败可重试。
- 转写写入：mock `/v1/audio/transcriptions` 返回固定文本，验证插入位置规则一致。
- Fix 主路径：选区 → 调用 mock 完成 → 正文被替换 → 点击撤销恢复原文。
- Polish 主路径：无选区 → 处理全文 → 应用 → 撤销恢复。
- 失败路径：mock 401/422/超时/断网，断言 toast 文案、重试按钮存在、正文未变。
- 长文本策略：构造超阈值文本，无选区触发提示但编辑区可继续输入。
- 技术实现：`page.route` 拦截 API，返回预置 JSON/错误；测试中使用 data-testid 锚点锁定按钮/状态文本；对超时使用 `abort` 或延迟响应验证可取消。

## 本地启动
```bash
npm install
npm run dev
```
默认 `http://localhost:5173/`。E2E：`npm run test:e2e`（需要先启动 dev server 或使用 `npx playwright test --ui`）。调整 token/base URL 在 `.env` 中。
