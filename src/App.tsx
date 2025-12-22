import { useEffect, useMemo, useRef, useState } from 'react';
import TurndownService from 'turndown';
import { marked } from 'marked';
import './App.css';

const injectBlankPlaceholders = (md: string) =>
  md.replace(/\n{3,}/g, (match) => {
    const extra = match.length - 2;
    const placeholders = Array.from({ length: extra }, () => '<div data-blank-line></div>').join('\n');
    return '\n\n' + placeholders;
  });

const renderMarkdownToHtml = (md: string) => {
  const withBlanks = injectBlankPlaceholders(md || '');
  return marked.parse(withBlanks, { async: false }) as string;
};

const sanitizeModelText = (raw: string) => {
  let t = raw.trim();
  // 移除开头和结尾的引号
  t = t.replace(/^["'“”]+|["'“”]+$/g, '');
  
  // 移除常见的 AI 废话开头（多行匹配）
  const lines = t.split('\n');
  const resultLines = [];
  let foundStart = false;
  let inBannedSection = false;

  for (const line of lines) {
    const l = line.trim();
    // 如果匹配到这些关键词，说明进入了“解释说明”区域，跳过后续所有行
    if (l.startsWith('修正说明') || l.startsWith('修改说明') || l.startsWith('说明：') || l.startsWith('Note:')) {
      inBannedSection = true;
      continue;
    }
    if (inBannedSection) continue;

    // 过滤掉引导性的短句
    if (!foundStart) {
      if (l.startsWith('修正后的文本') || l.startsWith('润色后的文本') || l.startsWith('结果：') || l.startsWith('基于搜索')) {
        continue;
      }
      if (l === '') continue;
      foundStart = true;
    }
    resultLines.push(line);
  }
  
  return resultLines.join('\n').trim();
};

type RecordingState = 'idle' | 'recording' | 'transcribing' | 'error';
type ActionType = 'fix' | 'polish';
type ToastKind = 'info' | 'success' | 'error';

type Toast = {
  id: number;
  message: string;
  kind: ToastKind;
  action?: { label: string; onClick: () => void };
};

type Article = {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
};

const FIX_SYSTEM_PROMPT = `你是一个严格的文字修正接口。
你的输出将直接替换用户的原始文本，因此必须：
1. 只输出修正后的文本内容。
2. 严禁包含任何解释、分析、备注、修正说明或前言。
3. 严禁输出类似“修正后的文本如下”之类的引导语。
4. 保持原有的 Markdown 格式。
5. 如果内容没有错别字，请原样返回，不要做任何说明。`;

const POLISH_SYSTEM_PROMPT = `你是一个专业的文字润色接口。
你的输出将直接替换用户的原始文本，因此必须：
1. 只输出润色后的文本内容。
2. 严禁包含任何解释、评价、建议、润色说明或前言。
3. 严禁输出类似“润色后的结果：”之类的引导语。
4. 保持原有的 Markdown 格式。
5. 保持语气自然，不要过度修饰。`;

const selectionUserTemplate = (selection: string) =>
  `请只处理下面这段文本（保持原意，不要添加任何新信息），保持 Markdown 标记与格式，不要破坏标记。你的输出将被直接替换这段文本，因此只输出替换后的文本正文：
${selection}`;

const fullUserTemplate = (text: string) =>
  `请处理下面全文（保持原意，不要添加任何新信息），保持 Markdown 标记与格式，不要破坏标记。只输出处理后的正文：
${text}`;

const LONG_TEXT_THRESHOLD = 8000;
const BASE_URL = '/api';
const TOKEN = import.meta.env.VITE_AI_BUILDER_TOKEN;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isNetworkError = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof Error &&
    (error.message.includes('NetworkError') || error.message.includes('network')));

function clampRange(start: number, end: number, max: number) {
  const safeStart = Math.max(0, Math.min(start, max));
  const safeEnd = Math.max(0, Math.min(end, max));
  return [Math.min(safeStart, safeEnd), Math.max(safeStart, safeEnd)] as const;
}

function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    if (toast.kind === 'error' || toast.action) return;
    const id = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(id);
  }, [toast]);
  return { toast, setToast };
}

export default function App() {
  // --- Article State ---
  const [articles, setArticles] = useState<Article[]>(() => {
    const saved = localStorage.getItem('flowpaste_articles');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch (e) {
        console.error('Failed to parse articles', e);
      }
    }
    return [{ id: Date.now().toString(), title: 'Untitled', content: '', updatedAt: Date.now() }];
  });

  const [currentArticleId, setCurrentArticleId] = useState<string>(() => {
    const savedId = localStorage.getItem('flowpaste_current_id');
    return savedId || '';
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  // Initialize text based on currentArticleId or default
  const [text, setText] = useState(() => {
    const savedId = localStorage.getItem('flowpaste_current_id');
    const savedArticlesStr = localStorage.getItem('flowpaste_articles');
    let initialText = '';
    
    if (savedArticlesStr) {
        try {
            const savedArticles = JSON.parse(savedArticlesStr);
            const targetId = savedId || (savedArticles.length > 0 ? savedArticles[0].id : null);
            const article = savedArticles.find((a: Article) => a.id === targetId);
            if (article) {
                initialText = article.content;
            } else if (savedArticles.length > 0) {
                initialText = savedArticles[0].content;
            }
        } catch {}
    }
    return initialText;
  });

  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [undoSnapshot, setUndoSnapshot] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [actionState, setActionState] = useState<'idle' | 'processing'>('idle');
  const [activeAction, setActiveAction] = useState<ActionType | null>(null);
  const [viewMode, setViewMode] = useState<'markdown' | 'wysiwyg'>('markdown');
  const wysiwygRef = useRef<HTMLDivElement | null>(null);
  const turndown = useMemo(() => {
    const t = new TurndownService();
    t.addRule('blank-line', {
      filter: (node) => (node as HTMLElement).getAttribute?.('data-blank-line') !== null,
      replacement: () => '\n\n',
    });
    return t;
  }, []);
  const isWysiwygInputRef = useRef(false);
  const lastSyncedMdRef = useRef<string>('');

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const lastAudioBlobRef = useRef<Blob | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const cancelledByUserRef = useRef(false);
  const lastCursorRef = useRef({ start: 0, end: 0 });

  const { toast, setToast } = useToast();

  // Validate currentArticleId on mount
  useEffect(() => {
    if (!articles.find(a => a.id === currentArticleId)) {
      if (articles.length > 0) {
        setCurrentArticleId(articles[0].id);
        setText(articles[0].content);
      } else {
         // Should ideally not happen due to initial state, but for safety
         const newId = Date.now().toString();
         setArticles([{ id: newId, title: 'Untitled', content: '', updatedAt: Date.now() }]);
         setCurrentArticleId(newId);
         setText('');
      }
    }
  }, []);

  useEffect(() => {
    if (textareaRef.current && !sidebarCollapsed) textareaRef.current.focus();
  }, [currentArticleId]);

  useEffect(() => {
    lastCursorRef.current = selection;
  }, [selection]);

  // Sync text to current article in the list
  useEffect(() => {
    setArticles(prev => {
      const idx = prev.findIndex(a => a.id === currentArticleId);
      if (idx === -1) return prev;
      
      // If content hasn't changed, don't update (avoids unnecessary re-renders/saves)
      if (prev[idx].content === text) return prev;

      const titleLine = text.trim().split('\n')[0] || 'Untitled';
      const newTitle = titleLine.length > 40 ? titleLine.slice(0, 40) + '...' : titleLine;

      const updatedArticle = { 
        ...prev[idx], 
        content: text, 
        title: newTitle || 'Untitled',
        updatedAt: Date.now() 
      };
      
      const newArticles = [...prev];
      newArticles[idx] = updatedArticle;
      return newArticles;
    });
  }, [text, currentArticleId]);

  // Persistence
  useEffect(() => {
    localStorage.setItem('flowpaste_articles', JSON.stringify(articles));
  }, [articles]);

  useEffect(() => {
    localStorage.setItem('flowpaste_current_id', currentArticleId);
  }, [currentArticleId]);

  const handleNewArticle = () => {
    const newId = Date.now().toString();
    const newArticle: Article = { id: newId, title: 'Untitled', content: '', updatedAt: Date.now() };
    setArticles(prev => [newArticle, ...prev]);
    setCurrentArticleId(newId);
    setText('');
    if (window.innerWidth < 900) {
        setSidebarCollapsed(true);
    }
  };

  const handleSelectArticle = (id: string) => {
    if (id === currentArticleId) return;
    const article = articles.find(a => a.id === id);
    if (article) {
      setCurrentArticleId(id);
      setText(article.content);
      if (window.innerWidth < 900) {
        setSidebarCollapsed(true);
      }
    }
  };

  const handleDeleteArticle = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (articles.length <= 1) {
      showToast('至少保留一篇文章', 'error');
      return;
    }
    if (!window.confirm('确定删除这篇文章吗？')) return;

    const newArticles = articles.filter(a => a.id !== id);
    setArticles(newArticles);

    if (currentArticleId === id) {
      const next = newArticles[0];
      setCurrentArticleId(next.id);
      setText(next.content);
    }
  };

  const baseHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    return headers;
  }, []);

  const readSelection = () => {
    if (viewMode !== 'markdown') return selection;
    const el = textareaRef.current;
    if (!el) return selection;
    return { start: el.selectionStart, end: el.selectionEnd };
  };

  const updateSelectionFromTextarea = () => {
    setSelection(readSelection());
  };

  const showToast = (message: string, kind: ToastKind = 'info', action?: Toast['action']) => {
    setToast({ id: Date.now(), message, kind, action });
  };

  const handleUndo = () => {
    if (!undoSnapshot) return;
    setText(undoSnapshot);
    setUndoSnapshot(null);
    showToast('已撤销上次修改', 'info');
  };

  const handleStartRecording = async () => {
    if (recordingState === 'recording' || recordingState === 'transcribing') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('当前浏览器不支持录音', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        showToast('录音失败，请重试', 'error');
        setRecordingState('error');
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        lastAudioBlobRef.current = blob;
        stream.getTracks().forEach((t) => t.stop());
        transcribeAudio(blob);
      };

      const liveSel = readSelection();
      setSelection(liveSel);
      lastCursorRef.current = { ...liveSel };
      recorderRef.current = recorder;
      setRecordingState('recording');
      recorder.start();
      showToast('录音中，完成后再点击停止', 'info');
    } catch (error) {
      showToast('无法开始录音，请检查麦克风权限', 'error');
      setRecordingState('error');
    }
  };

  const handleStopRecording = () => {
    if (recordingState === 'recording') {
      setRecordingState('transcribing');
      recorderRef.current?.stop();
    } else if (recordingState === 'transcribing') {
      cancelledByUserRef.current = true;
      transcribeAbortRef.current?.abort();
      setRecordingState('idle');
      showToast('已取消转写', 'info');
    } else if (recordingState === 'error') {
      if (lastAudioBlobRef.current) {
        transcribeAudio(lastAudioBlobRef.current);
      } else {
        setRecordingState('idle');
      }
    }
  };

  const requestWithRetry = async (
    request: (signal: AbortSignal) => Promise<Response>,
    options: { userController?: AbortController; timeoutMs: number; retries: number },
  ) => {
    let attempt = 0;
    let backoff = 800;
    while (attempt <= options.retries) {
      const attemptController = new AbortController();
      let timedOut = false;
      const timer = window.setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, options.timeoutMs);
      const onUserAbort = () => attemptController.abort();
      if (options.userController) {
        options.userController.signal.addEventListener('abort', onUserAbort, { once: true });
      }
      try {
        const res = await request(attemptController.signal);
        window.clearTimeout(timer);
        if (options.userController) {
          options.userController.signal.removeEventListener('abort', onUserAbort);
        }
        return res;
      } catch (error) {
        window.clearTimeout(timer);
        if (options.userController) {
          options.userController.signal.removeEventListener('abort', onUserAbort);
        }
        const cancelledByUser = options.userController?.signal.aborted && !timedOut;
        if (cancelledByUser) throw error;
        const retryable = timedOut || isNetworkError(error);
        if (retryable && attempt < options.retries) {
          await delay(backoff);
          backoff *= 2;
          attempt += 1;
          continue;
        }
        if (timedOut) throw new Error('timeout');
        throw error;
      }
    }
    throw new Error('unreachable');
  };

  const parseError = async (res: Response) => {
    let detail = '';
    try {
      const data = await res.json();
      detail =
        data?.error?.message ||
        data?.message ||
        data?.detail?.[0]?.msg ||
        data?.detail ||
        '';
    } catch {
      // ignore
    }
    if (res.status === 401 || res.status === 403) {
      return '鉴权失败，请在 .env 设置有效的 token';
    }
    if (res.status === 422) return detail || '参数校验失败，请检查内容';
    return detail || `请求失败 (${res.status})`;
  };

  const transcribeAudio = async (blob: Blob) => {
    const controller = new AbortController();
    cancelledByUserRef.current = false;
    transcribeAbortRef.current = controller;
    setRecordingState('transcribing');
    try {
      const res = await requestWithRetry(
        (signal) => {
          const fd = new FormData();
          fd.append('audio_file', blob, 'recording.webm');
          return fetch(`${BASE_URL}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: baseHeaders,
            body: fd,
            signal,
          });
        },
        { userController: controller, timeoutMs: 60000, retries: 1 },
      );
      if (!res.ok) {
        const msg = await parseError(res);
        throw new Error(msg);
      }
      const data = await res.json();
      const transcript: string = data?.text || data?.transcript || '';
      if (!transcript) throw new Error('未收到转写文本');
      setText((prev) => {
        const [start, end] = clampRange(lastCursorRef.current.start, lastCursorRef.current.end, prev.length);
        const next = `${prev.slice(0, start)}${transcript}${prev.slice(end)}`;
        const insertionEnd = start + transcript.length;
        setSelection({ start: insertionEnd, end: insertionEnd });
        return next;
      });
      setRecordingState('idle');
      showToast('已插入转写文本', 'success');
    } catch (error) {
      const userCancelled = cancelledByUserRef.current;
      if (userCancelled) {
        showToast('已取消转写', 'info');
        setRecordingState('idle');
        return;
      }
      const message =
        error instanceof Error && error.message === 'timeout'
          ? '转写超时，请重试'
          : error instanceof Error
            ? error.message
            : '转写失败';
      setRecordingState('error');
      showToast(message, 'error', lastAudioBlobRef.current ? { label: '重试', onClick: () => transcribeAudio(lastAudioBlobRef.current!) } : undefined);
    } finally {
      transcribeAbortRef.current = null;
      cancelledByUserRef.current = false;
    }
  };

  const runTextAction = async (action: ActionType) => {
    if (actionState === 'processing') {
      cancelledByUserRef.current = true;
      chatAbortRef.current?.abort();
      setActionState('idle');
      setActiveAction(null);
      showToast('已取消处理', 'info');
      return;
    }
    const liveSel = readSelection();
    const [selStart, selEnd] = clampRange(liveSel.start, liveSel.end, text.length);
    const hasSelection = selStart !== selEnd;
    const selectedText = hasSelection ? text.slice(selStart, selEnd) : '';
    const targetText = selectedText || text;
    if (!targetText.trim()) {
      showToast('请输入内容后再处理', 'info');
      return;
    }
    if (!hasSelection && text.length > LONG_TEXT_THRESHOLD) {
      const proceed = window.confirm(
        `${action === 'polish' ? 'Polish 更适合分段处理，' : ''}当前正文较长，建议选中段落再处理以节省成本并降低误改。仍要继续吗？`,
      );
      if (!proceed) return;
    }
    const userMessage = hasSelection ? selectionUserTemplate(selectedText) : fullUserTemplate(text);
    const systemMessage = action === 'fix' ? FIX_SYSTEM_PROMPT : POLISH_SYSTEM_PROMPT;
    const body = {
      model: 'deepseek',
      tool_choice: 'none',
      stream: true,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
    };
    const controller = new AbortController();
    cancelledByUserRef.current = false;
    chatAbortRef.current = controller;
    setUndoSnapshot(text);
    setActionState('processing');
    setActiveAction(action);
    showToast(`${action === 'fix' ? 'Fix' : 'Polish'} 处理中...`, 'info');

    let accumulatedContent = '';
    
    try {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const msg = await parseError(res);
        throw new Error(msg);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('无法读取响应流');
      
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta?.content || '';
              if (delta) {
                accumulatedContent += delta;
                
                // Real-time update
                setText(() => {
                  // Always reconstruct from the snapshot to avoid messing up indices or accumulating errors
                  // undoSnapshot is the full text BEFORE we started generating
                  const original = undoSnapshot || ''; 
                  if (hasSelection) {
                    return `${original.slice(0, selStart)}${accumulatedContent}${original.slice(selEnd)}`;
                  }
                  return accumulatedContent; // For full text replacement
                });
              }
            } catch (e) {
              console.error('JSON parse error', e);
            }
          }
        }
      }
      
      // Final sanitization
      const finalContent = sanitizeModelText(accumulatedContent);
      if (!finalContent || !finalContent.trim()) throw new Error('返回为空，请重试');
      
      setText(() => {
        const original = undoSnapshot || '';
        if (hasSelection) {
          const next = `${original.slice(0, selStart)}${finalContent}${original.slice(selEnd)}`;
          const newEnd = selStart + finalContent.length;
          setSelection({ start: newEnd, end: newEnd });
          return next;
        }
        return finalContent;
      });

      showToast(`已应用 ${action === 'fix' ? 'Fix' : 'Polish'}`, 'success', {
        label: '撤销',
        onClick: handleUndo,
      });
    } catch (error) {
      const userCancelled = cancelledByUserRef.current;
      if (userCancelled) {
        showToast('已取消处理', 'info');
        // Revert to undo snapshot if cancelled?
        if (undoSnapshot) setText(undoSnapshot);
        return;
      }
      const message =
        error instanceof Error && error.message === 'timeout'
          ? '请求超时，请重试'
          : error instanceof Error
            ? error.message
            : '处理失败';
      showToast(message, 'error');
      // On error, revert changes to avoid partial text
      if (undoSnapshot) setText(undoSnapshot);
    } finally {
      chatAbortRef.current = null;
      cancelledByUserRef.current = false;
      setActionState('idle');
      setActiveAction(null);
    }
  };

  const renderRecordLabel = () => {
    if (recordingState === 'recording') return '停止录音';
    if (recordingState === 'transcribing') return '转写中... (点击取消)';
    if (recordingState === 'error') return '重试转写';
    return '开始录音';
  };

  const liveStatusText = () => {
    if (recordingState === 'transcribing') return '正在转写录音...';
    if (actionState === 'processing' && activeAction === 'fix') return '正在 Fix，稍等...';
    if (actionState === 'processing' && activeAction === 'polish') return '正在 Polish，稍等...';
    if (recordingState === 'recording') return '录音中，点击停止以转写';
    return '';
  };

  const showProgressBar =
    recordingState === 'transcribing' ||
    recordingState === 'recording' ||
    actionState === 'processing';

  const syncWysiwygFromMarkdown = (md: string) => {
    if (!wysiwygRef.current) return;
    const html = renderMarkdownToHtml(md);
    lastSyncedMdRef.current = md;
    wysiwygRef.current.innerHTML = html;
  };

  useEffect(() => {
    if (viewMode === 'wysiwyg') {
      syncWysiwygFromMarkdown(text);
    }
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== 'wysiwyg') return;
    if (isWysiwygInputRef.current) return;
    if (text === lastSyncedMdRef.current) return;
    syncWysiwygFromMarkdown(text);
  }, [text, viewMode]);

  return (
    <div className={`app-shell ${focusMode ? 'focus' : ''}`}>
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <button className="btn primary small" onClick={handleNewArticle}>
            + 新建
          </button>
          <button 
            className="btn ghost icon-only" 
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "展开" : "收起"}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        </div>
        
        {!sidebarCollapsed && (
          <div className="article-list"> 
             {articles.map(article => (
               <div 
                  key={article.id} 
                  className={`article-item ${article.id === currentArticleId ? 'active' : ''}`}
                  onClick={() => handleSelectArticle(article.id)}
               >
                 <div className="article-title">{article.title || 'Untitled'}</div>
                 <div className="article-date">
                    {new Date(article.updatedAt).toLocaleString(undefined, {
                      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                    })}
                 </div>
                 <button 
                    className="delete-btn" 
                    onClick={(e) => handleDeleteArticle(e, article.id)}
                    title="删除"
                 >
                   ×
                 </button>
               </div>
             ))}
          </div>
        )}
      </aside>

      <div className="main-content">
        <header className="hero">
          <div className="hero-text">
            <p className="eyebrow">FlowPaste</p>
            <h1>语音转写，一键润色，创作永不中断</h1>
            <p className="subline">录音、转写、修正、润色全流程一屏搞定。无需频繁复制粘贴，多文档轻松切换，数据本地存储，安全更私密。</p>
          </div>
        </header>

        <main className="editor-wrap">
          {viewMode === 'markdown' ? (
            <textarea
              ref={textareaRef}
              data-testid="editor"
              className="editor"
              value={text}
              placeholder="开始口述或粘贴你的 Markdown 草稿；录音结束会自动插入转写。选中段落后点击 Fix/Polish 直接替换。"
              onChange={(e) => setText(e.target.value)}
              onSelect={updateSelectionFromTextarea}
              onKeyUp={updateSelectionFromTextarea}
              onMouseUp={updateSelectionFromTextarea}
            />
          ) : (
            <div className="preview-pane" data-testid="wysiwyg-pane">
              <div className="preview-head">所见编辑（可直接修改，自动同步 Markdown）</div>
              <div
                className="wysiwyg"
                data-testid="wysiwyg-editor"
                ref={wysiwygRef}
                contentEditable
                suppressContentEditableWarning
                onInput={(e) => {
                  isWysiwygInputRef.current = true;
                  const html = (e.currentTarget as HTMLDivElement).innerHTML;
                  const md = turndown.turndown(html || '');
                  if (import.meta.env.DEV) {
                    console.debug('[wysiwyg input]', { htmlSnippet: html.slice(0, 80), mdSnippet: md.slice(0, 80) });
                  }
                  setText(md);
                  requestAnimationFrame(() => {
                    isWysiwygInputRef.current = false;
                  });
                }}
              />
            </div>
          )}
        </main>

        <div className="toolbar">
          <div className="btn-group">
            <button
              data-testid="record-button"
              className={`btn primary ${recordingState !== 'idle' ? 'active' : ''}`}
              onClick={recordingState === 'recording' ? handleStopRecording : handleStartRecording}
            >
              {renderRecordLabel()}
            </button>
            {recordingState === 'recording' && (
              <button className="btn ghost" onClick={handleStopRecording}>
                停止
              </button>
            )}
            {recordingState === 'transcribing' && (
              <button className="btn ghost" onClick={handleStopRecording}>
                取消转写
              </button>
            )}
          </div>

          <div className="btn-group">
            <button
              data-testid="fix-button"
              className="btn"
              onClick={() => runTextAction('fix')}
            >
              {activeAction === 'fix' && actionState === 'processing' ? 'Fix 中…(点击取消)' : 'Fix'}
            </button>
            <button
              data-testid="polish-button"
              className="btn"
              onClick={() => runTextAction('polish')}
            >
              {activeAction === 'polish' && actionState === 'processing' ? 'Polish 中…(点击取消)' : 'Polish'}
            </button>
          </div>

          <div className="btn-group">
            <button
              className={`btn ghost ${viewMode === 'markdown' ? 'active' : ''}`}
              onClick={() => setViewMode('markdown')}
            >
              Markdown
            </button>
            <button
              className={`btn ghost ${viewMode === 'wysiwyg' ? 'active' : ''}`}
              onClick={() => setViewMode('wysiwyg')}
            >
              所见编辑
            </button>
          </div>

          <div className="btn-group">
            <button
              data-testid="undo-button"
              className={`btn ${undoSnapshot ? '' : 'disabled'}`}
              disabled={!undoSnapshot}
              onClick={handleUndo}
            >
              撤销
            </button>
            <button className="btn ghost" onClick={() => setFocusMode((v) => !v)} data-testid="focus-button">
              {focusMode ? '退出专注' : '专注模式'}
            </button>
          </div>

          <div className="status">
            <span className="dot" data-testid="recording-status" aria-label={recordingState} />
            <span>
              {recordingState === 'recording'
                ? '录音中'
                : recordingState === 'transcribing'
                  ? '转写中'
                  : recordingState === 'error'
                    ? '录音失败，可重试'
                    : '空闲'}
            </span>
            {liveStatusText() && (
              <span className="live-chip">
                <span className="spinner" aria-hidden="true" />
                {liveStatusText()}
              </span>
            )}
          </div>
        </div>
      </div>

      {showProgressBar && (
        <div className="progress" role="status" aria-live="polite">
          <div className="progress-bar" />
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} data-testid="toast">
          <span>{toast.message}</span>
          {toast.action && (
            <button className="link" onClick={toast.action.onClick}>
              {toast.action.label}
            </button>
          )}
          <button className="link" onClick={() => setToast(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
