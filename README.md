# FlowPaste MVP Plan & Setup

## Minimum Viable User Flow
- **Opening the app**: Users immediately see a large text editing area and a fixed bottom toolbar (Record/Fix/Polish/Undo/Focus).
- **Recording**: Click "Record" to start; click again to stop. UI switches to "Transcribing". Upon completion, the transcribed text is appended to the editor (or at cursor position) predictably.
- **Fix/Polish**: Select a text segment -> Click Fix/Polish -> Snapshot taken -> API call -> Selection replaced with result (or full text if no selection). A toast appears with an "Undo" button; clicking Undo restores the snapshot.
- **Error Handling**: Displays reasons (network, auth, timeout) with a "Retry" entry. Editor content remains unchanged on failure. Processing states can be cancelled to restore interactivity.
- **Focus Mode**: Full-screen editor, hiding extraneous elements, keeping only the toolbar and undo functionality.

## Key Interface Structure (Wireframe)
- **Layout**: Single page, clean background. Central area is a high-line-height, large-font `textarea`.
- **Bottom Toolbar**: `Record` (Idle/Recording/Transcribing/Error), `Fix`, `Polish`, `Undo` (highlighted when available), `Focus`.
- **Status Feedback**: Bottom-right toast/status bar showing "Transcribing...", "Fix Applied", "Timeout, Retry?", etc.
- **Interaction Rules**: Priority on selection; if no selection, processes full text. For long text, Fix allows full processing with a warning; Polish strongly suggests segmentation.

## API Integration Design
- **Base URL**: `https://space.ai-builders.com/backend`
- **Auth**: Header `Authorization: Bearer ${VITE_AI_BUILDER_TOKEN}` (set in `.env`).
- **Timeout**: Fetch 30s (Transcription 60s); Network error/timeout auto-retries once (0.8s -> 1.6s backoff); manual retry for other cases. Use `AbortController` for cancellation.

### Speech to Text
- `POST /v1/audio/transcriptions` (multipart/form-data)
- **Params**: `audio_file` (binary) or `audio_url`; optional `language` (e.g., `en`, `zh-CN`).
- **Success**: `text` contains the transcript.
- **Failures**: 401/403 (Token error), 422 (Params), Timeout/Network (Toast + Retry).
- **Insertion**: At cursor position to ensure predictability.

### Fix / Polish (Chat Completions)
- `POST /v1/chat/completions`
- **Model**: `deepseek` (or configured model).
- **Params**: `tool_choice: "none"`, `stream: true` (recommended for perceived speed).
- **Messages**: System prompt defines behavior; User prompt contains selection or full text.
- **Process**: Snapshot -> Call API -> Replace -> Toast "Applied" + Undo.

## Prompt Engineering (System Prompts)
The app now supports bilingual prompts (English/Chinese) based on UI language selection.

### Fix System Prompt (English)
```
You are a strict text correction interface.
Your output will directly replace the user's original text, so you must:
1. Output ONLY the corrected text content.
2. strictly FORBID any explanations, analysis, notes, correction remarks, or preambles.
3. strictly FORBID outputs like "Here is the corrected text:".
4. Maintain the original Markdown format.
5. If there are no typos, return the text exactly as is without any comments.
```

### Polish System Prompt (English)
```
You are a professional text polishing interface.
Your output will directly replace the user's original text, so you must:
1. Output ONLY the polished text content.
2. strictly FORBID any explanations, evaluations, suggestions, polishing remarks, or preambles.
3. strictly FORBID outputs like "Here is the polished result:".
4. Maintain the original Markdown format.
5. Maintain a natural tone; do not over-embellish.
```

## Long Text & Cost Strategy
- **Selection First**: Always prioritize selected text.
- **Threshold**: If no selection and text > ~8k chars, warn user: "Selecting a segment is recommended for speed and accuracy," but allow continuation.

## Implementation Roadmap
1. **Basic Shell**: Editor + Toolbar UI, Focus Mode, Toasts, Undo Stack.
2. **Recording State Machine**: Record -> Transcribe -> Insert -> Retry logic.
3. **Fix/Polish Flow**: Snapshot, Selection/Full text handling, Stream parsing, Undo.
4. **I18n**: English/Chinese support with language toggle.
5. **Stability**: Error boundaries, Auto-retry, Abort signals.

## Local Development
```bash
npm install
npm run dev
```
Default: `http://localhost:5173/`

## Testing
- **E2E**: `npm run test:e2e` (Playwright)
- Tests cover recording states, transcription insertion, Fix/Polish replacement, and undo functionality.
