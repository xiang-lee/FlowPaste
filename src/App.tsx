import { useEffect, useMemo, useRef, useState } from 'react';
import TurndownService from 'turndown';
import { marked } from 'marked';
import './App.css';
import { useI18n } from './hooks/useI18n';

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
  
  const lines = t.split('\n');
  const resultLines = [];
  let foundStart = false;
  let inBannedSection = false;

  for (const line of lines) {
    const l = line.trim();
    if (
      l.startsWith('修正说明') || l.startsWith('修改说明') || l.startsWith('说明：') || l.startsWith('Note:') || 
      l.startsWith('Explanation:') || l.startsWith('Correction:') || l.startsWith('Remark:')
    ) {
      inBannedSection = true;
      continue;
    }
    if (inBannedSection) continue;

    if (!foundStart) {
      if (
        l.startsWith('修正后的文本') || l.startsWith('润色后的文本') || l.startsWith('结果：') || l.startsWith('基于搜索') ||
        l.startsWith('Corrected text:') || l.startsWith('Polished text:') || l.startsWith('Result:')
      ) {
        continue;
      }
      if (l === '') continue;
      foundStart = true;
    }
    resultLines.push(line);
  }
  
  return resultLines.join('\n').trim();
};

const WYSIWYG_SYNC_THROTTLE_MS = 30;
const SELECTION_START_TOKEN = 'FLOWPASTESELECTIONSTARTTOKEN';
const SELECTION_END_TOKEN = 'FLOWPASTESELECTIONENDTOKEN';

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
  const { t, lang, changeLanguage } = useI18n();

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
    return [{ id: Date.now().toString(), title: t.ui.untitled, content: '', updatedAt: Date.now() }];
  });

  const [currentArticleId, setCurrentArticleId] = useState<string>(() => {
    const savedId = localStorage.getItem('flowpaste_current_id');
    return savedId || '';
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const isResizingRef = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.max(150, Math.min(e.clientX, 600));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = 'default';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
  };

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
        } catch {
            // ignore
        }
    }
    return initialText;
  });

  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [undoSnapshot, setUndoSnapshot] = useState<string | null>(null);
  const undoSnapshotRef = useRef<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [actionState, setActionState] = useState<'idle' | 'processing'>('idle');
  const [activeAction, setActiveAction] = useState<ActionType | null>(null);
  const [viewMode, setViewMode] = useState<'markdown' | 'wysiwyg'>('markdown');
  const isMac = useMemo(
    () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform),
    [],
  );
  const shortcutHints = useMemo(() => {
    const format = (key: string) => (isMac ? `Cmd+Shift+${key}` : `Ctrl+Shift+${key}`);
    return {
      fix: format('F'),
      polish: format('P'),
    };
  }, [isMac]);
  const wysiwygRef = useRef<HTMLDivElement | null>(null);
  const turndown = useMemo(() => {
    const t = new TurndownService();
    t.addRule('blank-line', {
      filter: (node) => (node as HTMLElement).getAttribute?.('data-blank-line') !== null,
      replacement: () => '\n\n',
    });
    return t;
  }, []);
  const lastSyncedMdRef = useRef<string>('');
  const suppressWysiwygInputRef = useRef(false);
  const pendingWysiwygMdRef = useRef<string | null>(null);
  const wysiwygSyncTimerRef = useRef<number | null>(null);
  const lastWysiwygRangeRef = useRef<Range | null>(null);

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
    if (!articles.find(a => a.id === currentArticleId)) {
      if (articles.length > 0) {
        setCurrentArticleId(articles[0].id);
        setText(articles[0].content);
      } else {
         const newId = Date.now().toString();
         setArticles([{ id: newId, title: t.ui.untitled, content: '', updatedAt: Date.now() }]);
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

  useEffect(() => {
    undoSnapshotRef.current = undoSnapshot;
  }, [undoSnapshot]);

  useEffect(() => {
    setArticles(prev => {
      const idx = prev.findIndex(a => a.id === currentArticleId);
      if (idx === -1) return prev;
      if (prev[idx].content === text) return prev;

      const titleLine = text.trim().split('\n')[0] || t.ui.untitled;
      const newTitle = titleLine.length > 40 ? titleLine.slice(0, 40) + '...' : titleLine;

      const updatedArticle = { 
        ...prev[idx], 
        content: text, 
        title: newTitle || t.ui.untitled,
        updatedAt: Date.now() 
      };
      
      const newArticles = [...prev];
      newArticles[idx] = updatedArticle;
      return newArticles;
    });
  }, [text, currentArticleId, t.ui.untitled]);

  useEffect(() => {
    localStorage.setItem('flowpaste_articles', JSON.stringify(articles));
  }, [articles]);

  useEffect(() => {
    localStorage.setItem('flowpaste_current_id', currentArticleId);
  }, [currentArticleId]);

  const handleNewArticle = () => {
    const newId = Date.now().toString();
    const newArticle: Article = { id: newId, title: t.ui.untitled, content: '', updatedAt: Date.now() };
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
      showToast(t.ui.minArticleWarning, 'error');
      return;
    }
    if (!window.confirm(t.ui.deleteConfirm)) return;

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

  const readWysiwygSelectionRange = () => {
    if (!wysiwygRef.current) return null;
    const sel = window.getSelection();
    let range: Range | null = null;
    if (sel && sel.rangeCount > 0) {
      const currentRange = sel.getRangeAt(0);
      if (wysiwygRef.current.contains(currentRange.commonAncestorContainer)) {
        range = currentRange;
      }
    }
    if (!range && lastWysiwygRangeRef.current) {
      if (wysiwygRef.current.contains(lastWysiwygRangeRef.current.commonAncestorContainer)) {
        range = lastWysiwygRangeRef.current;
      }
    }
    if (!range) return null;
    if (text.includes(SELECTION_START_TOKEN) || text.includes(SELECTION_END_TOKEN)) return null;

    const startMarker = document.createTextNode(SELECTION_START_TOKEN);
    const endMarker = document.createTextNode(SELECTION_END_TOKEN);
    const restoreRange = range.cloneRange();

    suppressWysiwygInputRef.current = true;
    try {
      const endRange = range.cloneRange();
      endRange.collapse(false);
      endRange.insertNode(endMarker);

      const startRange = range.cloneRange();
      startRange.collapse(true);
      startRange.insertNode(startMarker);

      const mdWithMarkers = turndown.turndown(wysiwygRef.current.innerHTML);
      const startIndex = mdWithMarkers.indexOf(SELECTION_START_TOKEN);
      const endIndex = mdWithMarkers.indexOf(SELECTION_END_TOKEN);
      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;

      const start = startIndex;
      const end = endIndex - SELECTION_START_TOKEN.length;
      return { start, end };
    } finally {
      startMarker.parentNode?.removeChild(startMarker);
      endMarker.parentNode?.removeChild(endMarker);
      suppressWysiwygInputRef.current = false;
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(restoreRange);
      }
    }
  };

  const readSelection = () => {
    if (viewMode !== 'markdown') return readWysiwygSelectionRange() ?? selection;
    const el = textareaRef.current;
    if (!el) return selection;
    return { start: el.selectionStart, end: el.selectionEnd };
  };

  const updateSelectionFromTextarea = () => {
    setSelection(readSelection());
  };

  const captureWysiwygSelectionRange = () => {
    if (suppressWysiwygInputRef.current) return;
    if (!wysiwygRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!wysiwygRef.current.contains(range.commonAncestorContainer)) return;
    lastWysiwygRangeRef.current = range.cloneRange();
  };

  const snapshotWysiwygSelection = () => {
    captureWysiwygSelectionRange();
    const range = readWysiwygSelectionRange();
    if (range) setSelection(range);
  };

  const showToast = (message: string, kind: ToastKind = 'info', action?: Toast['action']) => {
    setToast({ id: Date.now(), message, kind, action });
  };

  const applyUndoSnapshot = (snapshot: string | null) => {
    if (!snapshot) return;
    setText(snapshot);
    setUndoSnapshot(null);
    showToast(t.ui.toast.undo, 'info');
  };

  const handleUndo = () => {
    applyUndoSnapshot(undoSnapshotRef.current);
  };

  const copyPlainTextToClipboard = async (value: string) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // fall back
      }
    }
    const el = document.createElement('textarea');
    el.value = value;
    el.setAttribute('readonly', 'true');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  };

  const copyRichTextToClipboard = async (html: string, plain: string) => {
    const ClipboardItemCtor = typeof ClipboardItem !== 'undefined' ? ClipboardItem : undefined;
    if (navigator.clipboard?.write && ClipboardItemCtor) {
      try {
        const item = new ClipboardItemCtor({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch {
        // fall back
      }
    }
    const container = document.createElement('div');
    container.setAttribute('contenteditable', 'true');
    container.setAttribute('aria-hidden', 'true');
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '0';
    container.style.opacity = '0';
    container.innerHTML = html;
    document.body.appendChild(container);
    const range = document.createRange();
    range.selectNodeContents(container);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const ok = document.execCommand('copy');
    sel?.removeAllRanges();
    document.body.removeChild(container);
    if (!ok) return copyPlainTextToClipboard(plain);
    return true;
  };

  const handleCopyMarkdown = async () => {
    if (!text.trim()) {
      showToast(t.ui.toast.noContent, 'info');
      return;
    }
    const ok = await copyPlainTextToClipboard(text);
    showToast(ok ? t.ui.toast.copySuccessMD : t.ui.toast.copyFail, ok ? 'success' : 'error');
  };

  const handleCopyRichText = async () => {
    if (!text.trim()) {
      showToast(t.ui.toast.noContent, 'info');
      return;
    }
    const html = renderMarkdownToHtml(text);
    const ok = await copyRichTextToClipboard(html, text);
    showToast(ok ? t.ui.toast.copySuccessRT : t.ui.toast.copyFail, ok ? 'success' : 'error');
  };

  const handleActionMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (viewMode === 'wysiwyg') snapshotWysiwygSelection();
  };

  const handleStartRecording = async () => {
    if (recordingState === 'recording' || recordingState === 'transcribing') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast(t.ui.toast.browserNotSupport, 'error');
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
        showToast(t.ui.toast.recordFail, 'error');
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
      showToast(t.ui.toast.recording, 'info');
    } catch {
      showToast(t.ui.toast.micPermission, 'error');
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
      showToast(t.ui.toast.cancelTranscribing, 'info');
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
      return t.ui.toast.authFail;
    }
    if (res.status === 422) return detail || t.ui.toast.paramFail;
    return detail || t.ui.toast.reqFail(res.status);
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
      if (!transcript) throw new Error(t.ui.toast.noTranscript);
      setText((prev) => {
        const [start, end] = clampRange(lastCursorRef.current.start, lastCursorRef.current.end, prev.length);
        const next = `${prev.slice(0, start)}${transcript}${prev.slice(end)}`;
        const insertionEnd = start + transcript.length;
        setSelection({ start: insertionEnd, end: insertionEnd });
        return next;
      });
      setRecordingState('idle');
      showToast(t.ui.toast.insertTranscript, 'success');
    } catch (error) {
      const userCancelled = cancelledByUserRef.current;
      if (userCancelled) {
        showToast(t.ui.toast.cancelTranscribing, 'info');
        setRecordingState('idle');
        return;
      }
      const message =
        error instanceof Error && error.message === 'timeout'
          ? t.ui.toast.transcribeTimeout
          : error instanceof Error
            ? error.message
            : t.ui.toast.transcribeFail;
      setRecordingState('error');
      showToast(message, 'error', lastAudioBlobRef.current ? { label: t.ui.toast.retry, onClick: () => transcribeAudio(lastAudioBlobRef.current!) } : undefined);
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
      showToast(t.ui.toast.cancelProcessing, 'info');
      return;
    }
    const liveSel = readSelection();
    const [selStart, selEnd] = clampRange(liveSel.start, liveSel.end, text.length);
    const hasSelection = selStart !== selEnd;
    const selectedText = hasSelection ? text.slice(selStart, selEnd) : '';
    const targetText = selectedText || text;
    if (!targetText.trim()) {
      showToast(t.ui.toast.inputFirst, 'info');
      return;
    }
    if (!hasSelection && text.length > LONG_TEXT_THRESHOLD) {
      const proceed = window.confirm(t.ui.toast.longTextWarning(action));
      if (!proceed) return;
    }
    const userMessage = hasSelection ? t.prompts.selectionUser(selectedText) : t.prompts.fullUser(text);
    const systemMessage = action === 'fix' ? t.prompts.fixSystem : t.prompts.polishSystem;
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
    
    const currentSnapshot = text;
    setUndoSnapshot(currentSnapshot);
    
    setActionState('processing');
    setActiveAction(action);
    showToast(t.ui.toast.processing, 'info');

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
      if (!reader) throw new Error('Cannot read response stream');
      
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
                setText(() => {
                  const original = currentSnapshot; 
                  if (hasSelection) {
                    return `${original.slice(0, selStart)}${accumulatedContent}${original.slice(selEnd)}`;
                  }
                  return accumulatedContent;
                });
              }
            } catch (e) {
              console.error('JSON parse error', e);
            }
          }
        }
      }
      
      const finalContent = sanitizeModelText(accumulatedContent);
      if (!finalContent || !finalContent.trim()) throw new Error(t.ui.toast.fail);
      
      setText(() => {
        const original = currentSnapshot;
        if (hasSelection) {
          const next = `${original.slice(0, selStart)}${finalContent}${original.slice(selEnd)}`;
          const newEnd = selStart + finalContent.length;
          setSelection({ start: newEnd, end: newEnd });
          return next;
        }
        return finalContent;
      });

      showToast(t.ui.toast.applied(action), 'success', {
        label: t.ui.toast.undoAction,
        onClick: () => applyUndoSnapshot(currentSnapshot),
      });
    } catch (error) {
      const userCancelled = cancelledByUserRef.current;
      if (userCancelled) {
        showToast(t.ui.toast.cancelProcessing, 'info');
        if (undoSnapshot) setText(undoSnapshot);
        return;
      }
      const message =
        error instanceof Error && error.message === 'timeout'
          ? t.ui.toast.timeout
          : error instanceof Error
            ? error.message
            : t.ui.toast.fail;
      showToast(message, 'error');
      if (undoSnapshot) setText(undoSnapshot);
    } finally {
      chatAbortRef.current = null;
      cancelledByUserRef.current = false;
      setActionState('idle');
      setActiveAction(null);
    }
  };

  const renderRecordLabel = () => {
    if (recordingState === 'recording') return t.ui.stopRecording;
    if (recordingState === 'transcribing') return t.ui.transcribingCancel;
    if (recordingState === 'error') return t.ui.retryTranscribing;
    return t.ui.startRecording;
  };

  const liveStatusText = () => {
    if (recordingState === 'transcribing') return t.ui.liveTranscribing;
    if (actionState === 'processing' && activeAction === 'fix') return t.ui.liveFixing;
    if (actionState === 'processing' && activeAction === 'polish') return t.ui.livePolishing;
    if (recordingState === 'recording') return t.ui.liveRecording;
    return '';
  };

  const showProgressBar =
    recordingState === 'transcribing' ||
    recordingState === 'recording' ||
    actionState === 'processing';
  const canCopy = text.trim().length > 0;

  const syncWysiwygFromMarkdown = (md: string) => {
    if (!wysiwygRef.current) return;
    const html = renderMarkdownToHtml(md);
    lastSyncedMdRef.current = md;
    lastWysiwygRangeRef.current = null;
    wysiwygRef.current.innerHTML = html;
  };

  const handleWysiwygInput = () => {
    if (!wysiwygRef.current) return;
    if (suppressWysiwygInputRef.current) return;
    const html = wysiwygRef.current.innerHTML;
    const md = turndown.turndown(html);
    setText(md);
    lastSyncedMdRef.current = md;
  };

  const scheduleWysiwygSync = (md: string, delay: number) => {
    pendingWysiwygMdRef.current = md;
    if (wysiwygSyncTimerRef.current !== null) {
      if (delay > 0) return;
      window.clearTimeout(wysiwygSyncTimerRef.current);
      wysiwygSyncTimerRef.current = null;
    }
    if (delay === 0) {
      syncWysiwygFromMarkdown(md);
      return;
    }
    wysiwygSyncTimerRef.current = window.setTimeout(() => {
      wysiwygSyncTimerRef.current = null;
      const next = pendingWysiwygMdRef.current;
      if (!next) return;
      syncWysiwygFromMarkdown(next);
    }, delay);
  };

  useEffect(() => {
    if (viewMode === 'wysiwyg') {
      scheduleWysiwygSync(text, 0);
    }
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== 'wysiwyg') return;
    if (text === lastSyncedMdRef.current) return;
    const delay = actionState === 'processing' ? WYSIWYG_SYNC_THROTTLE_MS : 0;
    scheduleWysiwygSync(text, delay);
  }, [text, viewMode, actionState]);

  useEffect(() => {
    if (viewMode !== 'wysiwyg') return;
    const handleSelectionChange = () => captureWysiwygSelectionRange();
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [viewMode]);

  useEffect(() => {
    return () => {
      if (wysiwygSyncTimerRef.current !== null) {
        window.clearTimeout(wysiwygSyncTimerRef.current);
        wysiwygSyncTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const matchesShortcut = (event: KeyboardEvent, key: string) => {
      const modKey = isMac ? event.metaKey : event.ctrlKey;
      return modKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === key;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (matchesShortcut(event, 'f')) {
        event.preventDefault();
        runTextAction('fix');
        return;
      }
      if (matchesShortcut(event, 'p')) {
        event.preventDefault();
        runTextAction('polish');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, recordingState]);

  return (
    <div className={`app-shell ${focusMode ? 'focus' : ''}`}>
      {/* Sidebar */}
      <aside 
        className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}
        style={!sidebarCollapsed ? { width: sidebarWidth } : {}}
      >
        <div className="sidebar-header">
          <button className="btn primary small" onClick={handleNewArticle}>
            {t.ui.new}
          </button>
          <button 
            className="btn ghost icon-only" 
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? t.ui.expand : t.ui.collapse}
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
                 <div className="article-title">{article.title || t.ui.untitled}</div>
                 <div className="article-date">
                    {new Date(article.updatedAt).toLocaleString(undefined, {
                      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                    })}
                 </div>
                 <button 
                    className="delete-btn" 
                    onClick={(e) => handleDeleteArticle(e, article.id)}
                    title={t.ui.delete}
                  >
                   ×
                 </button>
               </div>
             ))}
          </div>
        )}
        {!sidebarCollapsed && (
          <div className="resizer" onMouseDown={startResizing} />
        )}
        
        {!sidebarCollapsed && (
          <div className="sidebar-footer">
            <div className="lang-switcher">
               <button 
                 className={`btn link small ${lang === 'en' ? 'active' : ''}`} 
                 onClick={() => changeLanguage('en')}
               >
                 EN
               </button>
               <span className="sep">|</span>
               <button 
                 className={`btn link small ${lang === 'zh' ? 'active' : ''}`} 
                 onClick={() => changeLanguage('zh')}
               >
                 中
               </button>
            </div>
          </div>
        )}
      </aside>

      <div className="main-content">
        <header className="hero">
          <div className="hero-text">
            <p className="eyebrow">FlowPaste</p>
            <h1>{t.ui.heroTitle}</h1>
            <p className="subline">{t.ui.heroSubtitle}</p>
          </div>
        </header>

        <main className="editor-wrap">
          {viewMode === 'markdown' ? (
            <textarea
              ref={textareaRef}
              data-testid="editor"
              className="editor"
              value={text}
              placeholder={t.ui.editorPlaceholder}
              onChange={(e) => setText(e.target.value)}
              onSelect={updateSelectionFromTextarea}
              onKeyUp={updateSelectionFromTextarea}
              onMouseUp={updateSelectionFromTextarea}
            />
          ) : (
            <div className="preview-pane" data-testid="wysiwyg-pane">
              <div className="preview-head">{t.ui.richTextHeader}</div>
              <div
                ref={wysiwygRef}
                className="wysiwyg"
                data-testid="wysiwyg-editor"
                contentEditable
                suppressContentEditableWarning
                onInput={handleWysiwygInput}
                onKeyUp={snapshotWysiwygSelection}
                onMouseUp={snapshotWysiwygSelection}
              />
            </div>
          )}
        </main>

        <div className="toolbar">
          <div className="btn-group">
            <button
              data-testid="record-button"
              className={`btn primary small ${recordingState !== 'idle' ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={recordingState === 'recording' ? handleStopRecording : handleStartRecording}
            >
              <span className="btn-label">{renderRecordLabel()}</span>
            </button>
            {recordingState === 'recording' && (
              <button className="btn ghost" onMouseDown={(e) => e.preventDefault()} onClick={handleStopRecording}>
                {t.ui.stop}
              </button>
            )}
            {recordingState === 'transcribing' && (
              <button className="btn ghost" onMouseDown={(e) => e.preventDefault()} onClick={handleStopRecording}>
                {t.ui.cancelTranscribing}
              </button>
            )}
          </div>

          <div className="btn-group">
            <button
              data-testid="fix-button"
              className="btn"
              onMouseDown={handleActionMouseDown}
              onClick={() => runTextAction('fix')}
              title={`Shortcut: ${shortcutHints.fix}`}
              aria-keyshortcuts={isMac ? 'Meta+Shift+F' : 'Control+Shift+F'}
            >
              <span className="btn-label">
                {activeAction === 'fix' && actionState === 'processing' ? t.ui.fixProcessing : 'Fix'}
              </span>
              <span className="btn-shortcut" aria-hidden="true">
                {shortcutHints.fix}
              </span>
            </button>
            <button
              data-testid="polish-button"
              className="btn"
              onMouseDown={handleActionMouseDown}
              onClick={() => runTextAction('polish')}
              title={`Shortcut: ${shortcutHints.polish}`}
              aria-keyshortcuts={isMac ? 'Meta+Shift+P' : 'Control+Shift+P'}
            >
              <span className="btn-label">
                {activeAction === 'polish' && actionState === 'processing' ? t.ui.polishProcessing : 'Polish'}
              </span>
              <span className="btn-shortcut" aria-hidden="true">
                {shortcutHints.polish}
              </span>
            </button>
          </div>

          <div className="btn-group">
            <button
              data-testid="markdown-view-button"
              className={`btn ghost ${viewMode === 'markdown' ? 'active' : ''}`}
              onClick={() => setViewMode('markdown')}
            >
              Markdown
            </button>
            <button
              data-testid="rich-text-view-button"
              className={`btn ghost ${viewMode === 'wysiwyg' ? 'active' : ''}`}
              onClick={() => setViewMode('wysiwyg')}
            >
              Rich Text
            </button>
          </div>

          <div className="btn-group">
            <button
              data-testid="copy-markdown-button"
              className={`btn ghost small ${canCopy ? '' : 'disabled'}`}
              onClick={handleCopyMarkdown}
              disabled={!canCopy}
              title={t.ui.copyMD}
            >
              {t.ui.copyMD}
            </button>
            <button
              data-testid="copy-rich-text-button"
              className={`btn ghost small ${canCopy ? '' : 'disabled'}`}
              onClick={handleCopyRichText}
              disabled={!canCopy}
              title={t.ui.copyRT}
            >
              {t.ui.copyRT}
            </button>
          </div>

          <div className="btn-group">
            <button
              data-testid="undo-button"
              className={`btn ${undoSnapshot ? '' : 'disabled'}`}
              disabled={!undoSnapshot}
              onClick={handleUndo}
            >
              {t.ui.undo}
            </button>
            <button className="btn ghost" onClick={() => setFocusMode((v) => !v)} data-testid="focus-button">
              {focusMode ? t.ui.exitFocus : t.ui.focusMode}
            </button>
          </div>

          <div className="status">
            <span className="dot" data-testid="recording-status" aria-label={recordingState} />
            <span>
              {recordingState === 'recording'
                ? t.ui.recordingStatus
                : recordingState === 'transcribing'
                  ? t.ui.transcribingStatus
                  : recordingState === 'error'
                    ? t.ui.errorStatus
                    : t.ui.idleStatus}
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
          <button className="link" onClick={() => setToast(null)} aria-label="Close">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
