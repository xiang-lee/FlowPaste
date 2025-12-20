import { useEffect, useMemo, useRef, useState } from 'react';
import TurndownService from 'turndown';
import { marked } from 'marked';

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
  t = t.replace(/^["'“”]+|["'“”]+$/g, '');
  const bannedPrefixes = ['Note:', 'note:', '备注：', '说明：', 'Silently', 'silently'];
  for (let i = 0; i < 3; i += 1) {
    if (bannedPrefixes.some((p) => t.startsWith(p))) {
      t = t.replace(/^[^\n]*\n?/, '').trim();
    }
  }
  return t.trim();
};
import './App.css';

type RecordingState = 'idle' | 'recording' | 'transcribing' | 'error';
type ActionType = 'fix' | 'polish';
type ToastKind = 'info' | 'success' | 'error';

type Toast = {
  id: number;
  message: string;
  kind: ToastKind;
  action?: { label: string; onClick: () => void };
};

const FIX_SYSTEM_PROMPT = `你是一个严格克制的文字修正器。你的任务是把用户文本中的错别字、明显语法问题、标点与分段做最小必要修正。
硬性规则：
- 绝对不能改变事实、观点、逻辑顺序与段落结构
- 不要扩写，不要加入新信息，不要改变语气
- 可以保留口语风格，但把明显影响理解的地方修到可读
输出格式：只输出修正后的全文正文，不要给任何解释、清单或标题。`;

const POLISH_SYSTEM_PROMPT = `你是一个写作润色助手，目标是提升可读性、连贯性与表达质感，同时保持作者语气自然克制。
硬性规则：
- 不能引入新事实或编造细节；不确定的内容不要补
- 允许适度改写句子以更顺更清晰，但不要写得浮夸
- 尽量保留原意与重点，避免信息发生变化
输出格式：只输出润色后的全文正文，不要给任何解释、清单或标题，禁止输出类似「silently」「note」等无关提示词。`;

const selectionUserTemplate = (selection: string) =>
  `请只处理下面这段文本（保持原意，不要添加任何新信息），保持 Markdown 标记与格式，不要破坏标记。你的输出将被直接替换这段文本，因此只输出替换后的文本正文：
${selection}`;

const fullUserTemplate = (text: string) =>
  `请处理下面全文（保持原意，不要添加任何新信息），保持 Markdown 标记与格式，不要破坏标记。只输出处理后的正文：
${text}`;

const LONG_TEXT_THRESHOLD = 8000;
const isLocal =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const BASE_URL =
  (import.meta.env.DEV || isLocal ? '/api' : import.meta.env.VITE_AI_BUILDER_BASE_URL) ||
  'https://space.ai-builders.com/backend';
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
  const [text, setText] = useState('');
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

  useEffect(() => {
    if (textareaRef.current) textareaRef.current.focus();
  }, []);

  useEffect(() => {
    lastCursorRef.current = selection;
  }, [selection]);

  const baseHeaders = useMemo(() => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN ?? ''}`,
    };
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
    if (!TOKEN) {
      showToast('缺少 API token，请在 .env 配置', 'error');
      setRecordingState('idle');
      return;
    }
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
    if (!TOKEN) {
      showToast('缺少 API token，请在 .env 配置', 'error');
      return;
    }
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
      model: 'supermind-agent-v1',
      tool_choice: 'none',
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
    try {
      const res = await requestWithRetry(
        (signal) =>
          fetch(`${BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { ...baseHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          }),
        { userController: controller, timeoutMs: 30000, retries: 1 },
      );
      if (!res.ok) {
        const msg = await parseError(res);
        throw new Error(msg);
      }
      const data = await res.json();
      const contentRaw: string | null = data?.choices?.[0]?.message?.content ?? null;
      const content = contentRaw ? sanitizeModelText(contentRaw) : null;
      if (!content || !content.trim()) throw new Error('返回为空，请重试');
      setText((prev) => {
        if (hasSelection) {
          const replacement = content.trim();
          const next = `${prev.slice(0, selStart)}${replacement}${prev.slice(selEnd)}`;
          const newEnd = selStart + replacement.length;
          setSelection({ start: newEnd, end: newEnd });
          return next;
        }
        return content.trim();
      });
      showToast(`已应用 ${action === 'fix' ? 'Fix' : 'Polish'}`, 'success', {
        label: '撤销',
        onClick: handleUndo,
      });
    } catch (error) {
      const userCancelled = cancelledByUserRef.current;
      if (userCancelled) {
        showToast('已取消处理', 'info');
        return;
      }
      const message =
        error instanceof Error && error.message === 'timeout'
          ? '请求超时，请重试'
          : error instanceof Error
            ? error.message
            : '处理失败';
      showToast(message, 'error');
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
      <header className="hero">
        <div className="hero-text">
          <p className="eyebrow">FlowPaste · 口述到发布一页闭环</p>
          <h1>语音连续输出，一键 Fix / Polish，永不丢稿。</h1>
          <p className="subline">录音→转写→克制修正→润色→撤销，全部在同一屏完成，无需外部 copy/paste。</p>
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
