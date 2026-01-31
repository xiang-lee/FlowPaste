export const en = {
  prompts: {
    fixSystem: `You are a strict text correction interface.
Your output will directly replace the user's original text, so you must:
1. Output ONLY the corrected text content.
2. strictly FORBID any explanations, analysis, notes, correction remarks, or preambles.
3. strictly FORBID outputs like "Here is the corrected text:".
4. Maintain the original Markdown format.
5. If there are no typos, return the text exactly as is without any comments.`,
    polishSystem: `You are a professional text polishing interface.
Your output will directly replace the user's original text, so you must:
1. Output ONLY the polished text content.
2. strictly FORBID any explanations, evaluations, suggestions, polishing remarks, or preambles.
3. strictly FORBID outputs like "Here is the polished result:".
4. Maintain the original Markdown format.
5. Maintain a natural tone; do not over-embellish.`,
    selectionUser: (text: string) => `Please strictly process the following text (keep original meaning, do not add new info), maintaining Markdown tags and format. Your output will directly replace this text, so output ONLY the replaced text body:
${text}`,
    fullUser: (text: string) => `Please process the full text below (keep original meaning, do not add new info), maintaining Markdown tags and format. Output ONLY the processed body:
${text}`
  },
  ui: {
    new: "+ New",
    expand: "Expand",
    collapse: "Collapse",
    delete: "Delete",
    untitled: "Untitled",
    deleteConfirm: "Delete this article?",
    minArticleWarning: "Keep at least one article",
    heroTitle: "Voice to Text, Instant Polish, Uninterrupted Flow",
    heroSubtitle: "Record, transcribe, fix, and polish in one screen. No copy-pasting, easy switching, local storage, private and secure.",
    editorPlaceholder: "Start dictating or paste your Markdown draft; recording will auto-insert transcription. Select text and click Fix/Polish to replace.",
    richTextHeader: "Rich Text (Editable, syncs to Markdown)",
    startRecording: "Record",
    stopRecording: "Stop Record",
    stop: "Stop",
    transcribingCancel: "Transcribing... (Click to Cancel)",
    retryTranscribing: "Retry Transcribe",
    cancelTranscribing: "Cancel Transcribe",
    fixProcessing: "Fixing... (Click to Cancel)",
    polishProcessing: "Polishing... (Click to Cancel)",
    copyMD: "Copy MD",
    copyRT: "Copy RT",
    undo: "Undo",
    focusMode: "Focus Mode",
    exitFocus: "Exit Focus",
    recordingStatus: "Recording",
    transcribingStatus: "Transcribing",
    errorStatus: "Record Failed, Retry",
    idleStatus: "Idle",
    liveTranscribing: "Transcribing audio...",
    liveFixing: "Fixing, please wait...",
    livePolishing: "Polishing, please wait...",
    liveRecording: "Recording, click Stop to transcribe",
    toast: {
      undo: "Undid last change",
      noContent: "No content to copy",
      copySuccessMD: "Copied Markdown",
      copySuccessRT: "Copied Rich Text",
      copyFail: "Copy failed, check permissions",
      browserNotSupport: "Browser does not support recording",
      recordFail: "Recording failed, please retry",
      recording: "Recording, click Stop when done",
      micPermission: "Cannot start recording, check mic permissions",
      cancelTranscribing: "Cancelled transcription",
      noTranscript: "No transcript received",
      insertTranscript: "Inserted transcript",
      transcribeTimeout: "Transcription timed out, please retry",
      transcribeFail: "Transcription failed",
      cancelProcessing: "Cancelled processing",
      inputFirst: "Please enter content first",
      longTextWarning: (action: string) => `${action === 'polish' ? 'Polish is better for segments. ' : ''}Text is long, selecting a segment is cheaper and safer. Continue anyway?`,
      processing: "Processing...",
      applied: (action: string) => `Applied ${action === 'fix' ? 'Fix' : 'Polish'}`,
      timeout: "Request timed out, please retry",
      fail: "Processing failed",
      authFail: "Auth failed, check token in .env",
      paramFail: "Validation failed, check content",
      reqFail: (status: number) => `Request failed (${status})`,
      retry: "Retry",
      undoAction: "Undo"
    },
    language: "Language"
  }
};
