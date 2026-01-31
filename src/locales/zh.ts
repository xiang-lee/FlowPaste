export const zh = {
  prompts: {
    fixSystem: `你是一个严格的文字修正接口。
你的输出将直接替换用户的原始文本，因此必须：
1. 只输出修正后的文本内容。
2. 严禁包含任何解释、分析、备注、修正说明或前言。
3. 严禁输出类似“修正后的文本如下”之类的引导语。
4. 保持原有的 Markdown 格式。
5. 如果内容没有错别字，请原样返回，不要做任何说明。`,
    polishSystem: `你是一个专业的文字润色接口。
你的输出将直接替换用户的原始文本，因此必须：
1. 只输出润色后的文本内容。
2. 严禁包含任何解释、评价、建议、润色说明或前言。
3. 严禁输出类似“润色后的结果：”之类的引导语。
4. 保持原有的 Markdown 格式。
5. 保持语气自然，不要过度修饰。`,
    selectionUser: (text: string) => `请只处理下面这段文本（保持原意，不要添加任何新信息），保持 Markdown 标记与格式，不要破坏标记。你的输出将被直接替换这段文本，因此只输出替换后的文本正文：
${text}`,
    fullUser: (text: string) => `请处理下面全文（保持原意，不要添加任何新信息），保持 Markdown 标记与格式，不要破坏标记。只输出处理后的正文：
${text}`
  },
  ui: {
    new: "+ 新建",
    expand: "展开",
    collapse: "收起",
    delete: "删除",
    untitled: "Untitled",
    deleteConfirm: "确定删除这篇文章吗？",
    minArticleWarning: "至少保留一篇文章",
    heroTitle: "语音转写，一键润色，创作永不中断",
    heroSubtitle: "录音、转写、修正、润色全流程一屏搞定。无需频繁复制粘贴，多文档轻松切换，数据本地存储，安全更私密。",
    editorPlaceholder: "开始口述或粘贴你的 Markdown 草稿；录音结束会自动插入转写。选中段落后点击 Fix/Polish 直接替换。",
    richTextHeader: "Rich Text (可直接修改，自动同步 Markdown)",
    startRecording: "开始录音",
    stopRecording: "停止录音",
    stop: "停止",
    transcribingCancel: "转写中... (点击取消)",
    retryTranscribing: "重试转写",
    cancelTranscribing: "取消转写",
    fixProcessing: "Fix 中…(点击取消)",
    polishProcessing: "Polish 中…(点击取消)",
    copyMD: "复制 MD",
    copyRT: "复制 RT",
    undo: "撤销",
    focusMode: "专注模式",
    exitFocus: "退出专注",
    recordingStatus: "录音中",
    transcribingStatus: "转写中",
    errorStatus: "录音失败，可重试",
    idleStatus: "空闲",
    liveTranscribing: "正在转写录音...",
    liveFixing: "正在 Fix，稍等...",
    livePolishing: "正在 Polish，稍等...",
    liveRecording: "录音中，点击停止以转写",
    toast: {
      undo: "已撤销上次修改",
      noContent: "没有可复制的内容",
      copySuccessMD: "已复制 Markdown",
      copySuccessRT: "已复制 Rich Text",
      copyFail: "复制失败，请检查浏览器权限",
      browserNotSupport: "当前浏览器不支持录音",
      recordFail: "录音失败，请重试",
      recording: "录音中，完成后再点击停止",
      micPermission: "无法开始录音，请检查麦克风权限",
      cancelTranscribing: "已取消转写",
      noTranscript: "未收到转写文本",
      insertTranscript: "已插入转写文本",
      transcribeTimeout: "转写超时，请重试",
      transcribeFail: "转写失败",
      cancelProcessing: "已取消处理",
      inputFirst: "请输入内容后再处理",
      longTextWarning: (action: string) => `${action === 'polish' ? 'Polish 更适合分段处理，' : ''}当前正文较长，建议选中段落再处理以节省成本并降低误改。仍要继续吗？`,
      processing: "处理中...",
      applied: (action: string) => `已应用 ${action === 'fix' ? 'Fix' : 'Polish'}`,
      timeout: "请求超时，请重试",
      fail: "处理失败",
      authFail: "鉴权失败，请在 .env 设置有效的 token",
      paramFail: "参数校验失败，请检查内容",
      reqFail: (status: number) => `请求失败 (${status})`,
      retry: "重试",
      undoAction: "撤销"
    },
    language: "语言"
  }
};
