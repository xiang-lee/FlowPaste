import { useEffect, useMemo, useRef, useState } from 'react';
import TurndownService from 'turndown';
import { marked } from 'marked';
import './App.css';
import { useI18n } from './hooks/useI18n';
import { en } from './locales/en';
import { zh } from './locales/zh';

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

const sortArticlesByRecent = (articles: Article[]) =>
  [...articles].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return b.id.localeCompare(a.id);
  });

const normalizeQuery = (value: string) => value.trim().toLocaleLowerCase();

function getHighlightedParts(value: string, query: string) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return [{ text: value, match: false }];

  const normalizedValue = value.toLocaleLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;

  while (cursor < value.length) {
    const matchIndex = normalizedValue.indexOf(normalizedQuery, cursor);
    if (matchIndex === -1) break;
    if (matchIndex > cursor) {
      parts.push({ text: value.slice(cursor, matchIndex), match: false });
    }
    const nextCursor = matchIndex + normalizedQuery.length;
    parts.push({ text: value.slice(matchIndex, nextCursor), match: true });
    cursor = nextCursor;
  }

  if (cursor < value.length) {
    parts.push({ text: value.slice(cursor), match: false });
  }

  return parts.length > 0 ? parts : [{ text: value, match: false }];
}

function getArticleSearchSnippet(content: string, query: string) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return '';

  const flattened = content.replace(/\s+/g, ' ').trim();
  if (!flattened) return '';

  const normalizedContent = flattened.toLocaleLowerCase();
  const matchIndex = normalizedContent.indexOf(normalizedQuery);
  if (matchIndex === -1) return '';

  const start = Math.max(0, matchIndex - 24);
  const end = Math.min(flattened.length, matchIndex + normalizedQuery.length + 32);
  let snippet = flattened.slice(start, end).trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < flattened.length) snippet = `${snippet}...`;
  return snippet;
}

const LONG_TEXT_THRESHOLD = 8000;
const BASE_URL = '/api';
const TOKEN = import.meta.env.VITE_AI_BUILDER_TOKEN;
const SIDEBAR_COLLAPSED_KEY = 'flowpaste_sidebar_collapsed';
const SIDEBAR_WIDTH_KEY = 'flowpaste_sidebar_width';
const VIEW_MODE_KEY = 'flowpaste_view_mode';
const UNTITLED_TITLES = new Set([en.ui.untitled, zh.ui.untitled]);

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

function filename(value: string) {
  const safe = Array.from(value, (char) => (char.charCodeAt(0) < 32 ? ' ' : char))
    .join('')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return safe || 'flowpaste';
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

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return saved === null ? true : saved === 'true';
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!Number.isFinite(saved)) return 220;
    return Math.max(150, Math.min(saved, 600));
  });
  const [articleQuery, setArticleQuery] = useState('');
  const isResizingRef = useRef(false);
  const sortedArticles = useMemo(() => sortArticlesByRecent(articles), [articles]);
  const filteredArticles = useMemo(() => {
    const query = normalizeQuery(articleQuery);
    if (!query) return sortedArticles;
    return sortedArticles.filter((article) => {
      const title = article.title.toLocaleLowerCase();
      const content = article.content.toLocaleLowerCase();
      return title.includes(query) || content.includes(query);
    });
  }, [articleQuery, sortedArticles]);

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
  const [viewMode, setViewMode] = useState<'markdown' | 'wysiwyg'>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return saved === 'wysiwyg' ? 'wysiwyg' : 'markdown';
  });
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const isMac = useMemo(
    () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform),
    [],
  );
  const shortcutHints = useMemo(() => {
    const formatAction = (key: string) => (isMac ? `Cmd+Shift+${key}` : `Ctrl+Shift+${key}`);
    const formatPrimary = (key: string) => (isMac ? `Cmd+${key}` : `Ctrl+${key}`);
    return {
      fix: formatAction('F'),
      polish: formatAction('P'),
      search: formatPrimary('K'),
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSearchFocusRef = useRef(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const lastAudioBlobRef = useRef<Blob | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const cancelledByUserRef = useRef(false);
  const lastCursorRef = useRef({ start: 0, end: 0 });
  const runTextActionRef = useRef<(action: ActionType) => void>(() => {});
  const downloadMarkdownRef = useRef<() => void>(() => {});

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

  useEffect(() => {
    setArticles((prev) => {
      let changed = false;
      const next = prev.map((article) => {
        if (article.content.trim()) return article;
        if (!UNTITLED_TITLES.has(article.title)) return article;
        if (article.title === t.ui.untitled) return article;
        changed = true;
        return { ...article, title: t.ui.untitled };
      });
      return changed ? next : prev;
    });
  }, [t.ui.untitled]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (!actionsMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (actionsMenuRef.current?.contains(event.target as Node)) return;
      setActionsMenuOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActionsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [actionsMenuOpen]);

  useEffect(() => {
    if (sidebarCollapsed || !pendingSearchFocusRef.current) return;
    if (!searchInputRef.current) return;
    searchInputRef.current.focus();
    searchInputRef.current.select();
    pendingSearchFocusRef.current = false;
  }, [sidebarCollapsed]);

  const handleNewArticle = () => {
    const newId = Date.now().toString();
    const newArticle: Article = { id: newId, title: t.ui.untitled, content: '', updatedAt: Date.now() };
    setArticles(prev => [newArticle, ...prev]);
    setArticleQuery('');
    setCurrentArticleId(newId);
    setText('');
    setUndoSnapshot(null);
    if (window.innerWidth < 900) {
        setSidebarCollapsed(true);
    }
  };

  const handleDuplicateArticle = () => {
    const currentArticle = articles.find((article) => article.id === currentArticleId);
    const baseTitle = text.trim().split('\n')[0] || currentArticle?.title || t.ui.untitled;
    const newId = Date.now().toString();
    const duplicatedArticle: Article = {
      id: newId,
      title: t.ui.duplicateTitle(baseTitle),
      content: text,
      updatedAt: Date.now(),
    };
    setArticles((prev) => [duplicatedArticle, ...prev]);
    setArticleQuery('');
    setCurrentArticleId(newId);
    setText(text);
    setSelection({ start: 0, end: 0 });
    setUndoSnapshot(null);
    showToast(t.ui.toast.articleDuplicated, 'success');
    if (window.innerWidth < 900) {
      setSidebarCollapsed(true);
    }
  };

  const clearArticleSearch = () => {
    setArticleQuery('');
    searchInputRef.current?.focus();
  };

  const focusArticleSearch = () => {
    pendingSearchFocusRef.current = true;
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      return;
    }
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
    pendingSearchFocusRef.current = false;
  };

  const handleSelectArticle = (id: string) => {
    if (id === currentArticleId) return;
    const article = articles.find(a => a.id === id);
    if (article) {
      setCurrentArticleId(id);
      setText(article.content);
      setUndoSnapshot(null);
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

    const previousArticles = articles;
    const previousCurrentArticleId = currentArticleId;
    const previousText = text;
    const newArticles = articles.filter(a => a.id !== id);
    setArticles(newArticles);

    if (currentArticleId === id) {
      const next = sortArticlesByRecent(newArticles)[0];
      setCurrentArticleId(next.id);
      setText(next.content);
      setUndoSnapshot(null);
    }

    showToast(t.ui.toast.articleDeleted, 'info', {
      label: t.ui.toast.undoAction,
      onClick: () => {
        setArticles(previousArticles);
        setCurrentArticleId(previousCurrentArticleId);
        const restoredArticle = previousArticles.find((article) => article.id === previousCurrentArticleId);
        setText(restoredArticle?.content ?? previousText);
        setUndoSnapshot(null);
      },
    });
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

  const handleDownloadMarkdown = () => {
    if (!text.trim()) {
      showToast(t.ui.toast.noContent, 'info');
      return;
    }
    const article = articles.find((item) => item.id === currentArticleId);
    const outputName = `${filename(article?.title || text.trim().split('\n')[0] || t.ui.untitled)}.md`;
    try {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = outputName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      showToast(t.ui.toast.downloadSuccess(outputName), 'success');
    } catch {
      showToast(t.ui.toast.downloadFail, 'error');
    }
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
          if (lang === 'zh') {
              fd.append('language', 'zh-CN');
          } else {
              fd.append('language', 'en');
          }
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
        setText(currentSnapshot);
        return;
      }
      const message =
        error instanceof Error && error.message === 'timeout'
          ? t.ui.toast.timeout
          : error instanceof Error
            ? error.message
            : t.ui.toast.fail;
      showToast(message, 'error');
      setText(currentSnapshot);
    } finally {
      chatAbortRef.current = null;
      cancelledByUserRef.current = false;
      setActionState('idle');
      setActiveAction(null);
    }
  };

  useEffect(() => {
    runTextActionRef.current = (action: ActionType) => {
      void runTextAction(action);
    };
  }, [runTextAction]);

  useEffect(() => {
    downloadMarkdownRef.current = handleDownloadMarkdown;
  }, [handleDownloadMarkdown]);

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
  const lineCount = text ? text.split('\n').length : 0;
  const [selectionStart, selectionEnd] = clampRange(selection.start, selection.end, text.length);
  const selectionSize = selectionEnd - selectionStart;

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
    if (viewMode !== 'markdown') return;
    const handleSelectionChange = () => {
      const el = textareaRef.current;
      if (!el || document.activeElement !== el) return;
      setSelection({ start: el.selectionStart, end: el.selectionEnd });
    };
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
    const matchesPrimaryShortcut = (event: KeyboardEvent, key: string) => {
      const modKey = isMac ? event.metaKey : event.ctrlKey;
      return modKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === key;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key === 'Escape' && focusMode) {
        event.preventDefault();
        setFocusMode(false);
        return;
      }
      if (matchesPrimaryShortcut(event, 's')) {
        event.preventDefault();
        downloadMarkdownRef.current();
        return;
      }
      if (matchesPrimaryShortcut(event, 'k')) {
        event.preventDefault();
        focusArticleSearch();
        return;
      }
      if (matchesShortcut(event, 'f')) {
        event.preventDefault();
        runTextActionRef.current('fix');
        return;
      }
      if (matchesShortcut(event, 'p')) {
        event.preventDefault();
        runTextActionRef.current('polish');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusMode, isMac, sidebarCollapsed]);

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
          <>
            <div className="sidebar-search">
              <div className="sidebar-search-row">
                <input
                  ref={searchInputRef}
                  data-testid="article-search-input"
                  className="sidebar-search-input"
                  type="search"
                  value={articleQuery}
                  onChange={(e) => setArticleQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && articleQuery) {
                      e.preventDefault();
                      clearArticleSearch();
                      return;
                    }
                    if (e.key === 'Enter' && filteredArticles.length > 0) {
                      e.preventDefault();
                      handleSelectArticle(filteredArticles[0].id);
                    }
                  }}
                  placeholder={t.ui.articleSearchPlaceholder}
                  title={`${t.ui.articleSearchPlaceholder} (${shortcutHints.search})`}
                />
                {articleQuery && (
                  <button
                    type="button"
                    className="sidebar-search-clear"
                    data-testid="article-search-clear"
                    onClick={clearArticleSearch}
                    aria-label={t.ui.clearSearch}
                    title={t.ui.clearSearch}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
            <div className="article-list"> 
             {filteredArticles.map(article => (
                <div 
                   key={article.id} 
                   className={`article-item ${article.id === currentArticleId ? 'active' : ''}`}
                   onClick={() => handleSelectArticle(article.id)}
                >
                 <div className="article-title">
                   {getHighlightedParts(article.title || t.ui.untitled, articleQuery).map((part, index) =>
                     part.match ? (
                       <mark key={`${article.id}-title-${index}`} className="match-mark">
                         {part.text}
                       </mark>
                     ) : (
                       <span key={`${article.id}-title-${index}`}>{part.text}</span>
                     ),
                   )}
                 </div>
                 {articleQuery && getArticleSearchSnippet(article.content, articleQuery) && (
                   <div className="article-snippet" data-testid="article-search-snippet">
                     {getHighlightedParts(getArticleSearchSnippet(article.content, articleQuery), articleQuery).map((part, index) =>
                       part.match ? (
                         <mark key={`${article.id}-snippet-${index}`} className="match-mark">
                           {part.text}
                         </mark>
                       ) : (
                         <span key={`${article.id}-snippet-${index}`}>{part.text}</span>
                       ),
                     )}
                   </div>
                 )}
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
              {filteredArticles.length === 0 && (
                <div className="article-empty" data-testid="article-search-empty">
                  {t.ui.noArticlesMatch}
                </div>
              )}
            </div>
          </>
        )}
        {!sidebarCollapsed && (
          <div className="resizer" onMouseDown={startResizing} />
        )}
        
      </aside>

      <div className="main-content">
        <header className="hero">
          <div className="hero-text">
            <p className="eyebrow">FlowPaste</p>
            <h1>{t.ui.heroTitle}</h1>
            <p className="subline">{t.ui.heroSubtitle}</p>
          </div>
          <div className="hero-actions">
            <div className="btn-group lang-switcher" aria-label={t.ui.language}>
              <button
                className={`btn ghost small ${lang === 'en' ? 'active' : ''}`}
                onClick={() => changeLanguage('en')}
              >
                EN
              </button>
              <span className="sep" aria-hidden="true">|</span>
              <button
                className={`btn ghost small ${lang === 'zh' ? 'active' : ''}`}
                onClick={() => changeLanguage('zh')}
              >
                中
              </button>
            </div>
          </div>
        </header>

        <main className="editor-wrap">
          <div className="editor-head">
            <div className="editor-mode">
              <span className="editor-head-label">{t.ui.editorMode}</span>
              <div className="btn-group mode-switcher">
                <button
                  data-testid="markdown-view-button"
                  className={`btn ghost ${viewMode === 'markdown' ? 'active' : ''}`}
                  onClick={() => setViewMode('markdown')}
                >
                  {t.ui.markdownView}
                </button>
                <button
                  data-testid="rich-text-view-button"
                  className={`btn ghost ${viewMode === 'wysiwyg' ? 'active' : ''}`}
                  onClick={() => setViewMode('wysiwyg')}
                >
                  {t.ui.richTextView}
                </button>
              </div>
            </div>
            <button className="btn ghost small" onClick={() => setFocusMode((v) => !v)} data-testid="focus-button">
              {focusMode ? t.ui.exitFocus : t.ui.focusMode}
            </button>
          </div>
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
          <div className="toolbar-main">
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
          </div>

          <div className="toolbar-secondary">
            <button
              data-testid="undo-button"
              className={`btn ${undoSnapshot ? '' : 'disabled'}`}
              disabled={!undoSnapshot}
              onClick={handleUndo}
            >
              {t.ui.undo}
            </button>
            <div className={`toolbar-menu ${actionsMenuOpen ? 'open' : ''}`} ref={actionsMenuRef}>
              <button
                className={`btn ghost ${actionsMenuOpen ? 'active' : ''}`}
                onClick={() => setActionsMenuOpen((open) => !open)}
                data-testid="actions-menu-button"
                aria-expanded={actionsMenuOpen}
                aria-haspopup="menu"
              >
                {t.ui.actionsMenu}
              </button>
              {actionsMenuOpen && (
                <div className="toolbar-popover" role="menu">
                  <div className="menu-section">
                    <span className="menu-label">{t.ui.shareGroup}</span>
                    <button
                      data-testid="download-markdown-button"
                      className={`btn ghost small menu-button ${canCopy ? '' : 'disabled'}`}
                      onClick={() => {
                        setActionsMenuOpen(false);
                        handleDownloadMarkdown();
                      }}
                      disabled={!canCopy}
                      title={t.ui.downloadMD}
                    >
                      {t.ui.downloadMD}
                    </button>
                    <button
                      data-testid="copy-markdown-button"
                      className={`btn ghost small menu-button ${canCopy ? '' : 'disabled'}`}
                      onClick={() => {
                        setActionsMenuOpen(false);
                        void handleCopyMarkdown();
                      }}
                      disabled={!canCopy}
                      title={t.ui.copyMD}
                    >
                      {t.ui.copyMD}
                    </button>
                    <button
                      data-testid="copy-rich-text-button"
                      className={`btn ghost small menu-button ${canCopy ? '' : 'disabled'}`}
                      onClick={() => {
                        setActionsMenuOpen(false);
                        void handleCopyRichText();
                      }}
                      disabled={!canCopy}
                      title={t.ui.copyRT}
                    >
                      {t.ui.copyRT}
                    </button>
                  </div>
                  <div className="menu-section">
                    <span className="menu-label">{t.ui.documentGroup}</span>
                    <button
                      data-testid="duplicate-article-button"
                      className="btn ghost small menu-button"
                      onClick={() => {
                        setActionsMenuOpen(false);
                        handleDuplicateArticle();
                      }}
                      title={t.ui.duplicate}
                    >
                      {t.ui.duplicate}
                    </button>
                  </div>
                </div>
              )}
            </div>
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
            {selectionSize > 0 && (
              <span className="selection-chip" data-testid="selection-chip">
                {t.ui.selectionStatus(selectionSize)}
              </span>
            )}
            {text.length > 0 && (
              <span className="stats-chip" data-testid="document-stats">
                {t.ui.documentStats(text.length, lineCount)}
              </span>
            )}
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
