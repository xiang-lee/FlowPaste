\[AI Architect课程实践\] 语音写作润色编辑器
==============================

分享一下我最近学习完AI Architect课程后， build的一个小工具**FlowPaste**。[https://flow-paste.ai-builders.space/](https://flow-paste.ai-builders.space/) 

### 为什么做这个？

最近在输出文字，写写文章，我发现“语音转写”和“AI 润色”通常是割裂的。我需要先用Wispr等工具一顿说话转成文字到本地编辑器，其中有一些不通顺的句子，丢失的标点符号等等，我会复制到 ChatGPT 让他改错别字或者不通顺的句子，再粘贴回文档。 这个工具旨在减少摩擦。灵感来源于课程的第一个项目“A World Unlocked by Frictionless Interaction”。还有一个想法是尽量把space.ai-builders的API用一用：）

工具有下面几个功能：

1.  **语音直录**：网页直接录音 （用了ai-builders的audio API）
2.  **原地 AI修复和润色**：选中文字，一键点 **Fix**（修错字/句子/标点 等小问题）或 **Polish**（润色，直接在编辑器里流式替换 （用了ai-builders的/chat/completions API）
3.  **极简&隐私**：所有文章数据只存在浏览器 LocalStorage，没有后端数据库，刷新不丢，隐私安全。
4.  支持 Markdown 和RichText的编辑与一键复制。

* * *

### 技术栈

我一开始用的是codex，后面添加的功能和修bug用的是gemini cli, 纯粹想试试不同的AI工具，表现都不错。技术栈我其实没有care， 把OKR写好以后，然后让AI决定。

*   **前端**：React + Vite + TypeScript
*   **后端**：Node.js Express (仅作为 API Proxy，不存数据)
*   **AI 能力**： DeepSeek 模型（通过 AI Builders API）
*   **部署**：Docker + Koyeb （这个AI Builders已经帮忙封装成MCP，直接让我们AI工具用就可以）

* * *

### 经验分享

在开发过程中遇到了几个问题：

**1\. 模型选择：Agent vs Chat Model** 起初codex默认使用了 `supermind-agent-v1` 模型。让gemini cli帮忙减少latency, 发现对于单纯的“改错别字”任务，貌似Agent 经常会去思考甚至尝试搜索，导致 Latency 高，用户体验很差。 **解决**：切换到 **DeepSeek,** 对于纯文本处理任务，它的速度快、中文理解好，且成本更低。

2\. 告别超时：**从等待到流式输出 (Streaming)** ，同样是减少latency的topic， 后端等待 AI 生成往往需要 30-40 秒以上，前端经常报 Timeout 错误。 **解决**：后端请求开启 `stream: true`，同样是genminiCLI读了MCP里的文档，给了2个option, 增加timeout或者改成streaming, 我当然选择了后者，如果OKR写清楚用户体验最重要，估计它不会propose增加timeout的这个Option。 于是让它重写了 fetch 逻辑对接 Server-Sent Events (SSE)。现在字是一个个蹦出来的，首字延迟不到 1 秒，解决了超时问题。

**3\. 并发更新时的“吞字” Bug， （**这一段是让gemini自己写的总结，我没有怎么改**）** 在做流式替换时，最初犯了一个错误：每次收到 AI 的新字符，都基于 `prev`（当前最新文本）去拼接。导致流式更新极快时，光标位置错乱。 后来我改用了 `undoSnapshot`（状态变量）来做基准，结果发现 React 的 `async` 函数闭包里取到的 `undoSnapshot` 竟然是旧值（null），导致非选区文字全部被吞掉。 **解决**：**Local Variable Snapshot**。不要在异步回调里直接依赖 React State，而是在函数一开始就用一个 `const currentSnapshot = text` 本地变量把状态锁死，后续所有逻辑都只认这个本地变量。

**4\. 细节体验：点击按钮导致失焦** 每次我点 "Fix" 或 "录音" 按钮，编辑器就失去焦点了，光标也没了，用户不知道录完音会插在哪里。 **解决 （by gemini）**：给按钮加一个简单的 `onMouseDown={(e) => e.preventDefault()}`。能阻止按钮抢走焦点，点击后编辑器依然保持激活状态，体验丝滑了很多。

**5\. 部署后的缓存陷阱** 部署上线后，我发现推了新代码，浏览器显示却还在跑旧代码。 **解决**：这是因为 Nginx/Express 默认缓存了 `index.html`。需要在后端代码里专门针对 `index.html` 设置 `Cache-Control: no-cache`，强制浏览器每次拉取最新的入口文件。（同样也是gemini 修复的）

**6\. 回归测试：** 为了防止上述问题，我让gemini建立了本地回归测试（Playwright），Mock 了流式接口和用户操作。先写测试复现 Bug，再修 Bug。

**7.** 这篇文章就是用这个工具写的，我个人体验比之前好不少。少了很多 Friction

**8.** 对UI的设计审美，Gemini CLI貌似比codex要更好。

### 一些想法

*   部署很丝滑，直接让AI 工具帮我部署，AI工具直接用ai-builders MCP （中间有个小插曲，我一开始想自己call API部署，少了一个参数，感谢鸭哥帮忙debug）
*   重启项目的成本很低：该工具是第二次创建，第一次生成的工具不太令人满意。我提供了反馈，修改了提示，更新了 OKR，删除了项目，然后让 Codex 从头重新开始。
* 如果把上面经验分享总结在OKR里，再一次build的成功率会非常高，和coaching 员工同理。

* * *