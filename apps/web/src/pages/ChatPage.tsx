import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send, Plus, Bot, User as UserIcon, X, PanelLeftClose, PanelLeftOpen,
  Mic, MicOff, Loader2, Sparkles, Paperclip, File as FileIcon, ClipboardList,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { useDeptFilterStore } from '../store/deptFilterStore';
import { humanizeTaskManagerError } from '../utils/humanizeLlmError';
import { AgentSuggestions } from '../components/Chat/AgentSuggestions';
import { InlineChatResult } from '../components/Chat/InlineChatResult';
import { TaskProgressSidebar } from '../components/Chat/TaskProgressSidebar';
import { AgentCtaCard, type AgentDraft } from '../components/Chat/AgentCtaCard';
import { NodeCtaCard, type NodeDraft } from '../components/Chat/NodeCtaCard';
import { looksLikeApiSpec } from '../utils/apiSpecDetect';
import { DeliverableBar, type DeliverableKind } from '../components/Chat/DeliverableBar';
import { RunPreviewRow } from '../components/exec-kernel/RunPreviewRow';
import { MarkdownLite } from '../components/Chat/MarkdownLite';
import { CreateAgentModal } from '../components/Agents/CreateAgentModal';
import type { AgentStepDef, ChatSession, Message } from '@org-ai/shared-types';
import { DEPT_LABEL, DEPT_ACCENT, DEPARTMENTS, DEPT_CHARACTER } from '../constants/departments';

interface InlineTask {
  id: string;           // バックエンドのタスクID
  title: string;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed';
  afterMessageId: string;
  department: string;
  logs: Array<{ message: string; level: string; createdAt: string }>;
  output?: string;      // タスク完了時の出力
}

/** JSONコードブロック(```json ... ```)をメッセージ本文から除去する */
function stripJsonBlocks(text: string): string {
  return text.replace(/```json\s*[\s\S]*?```/g, '').trim();
}

/** capability-resolver の ResolveOutcome（gateway と同形・成果物作成の応答判定用） */
type ResolveOutcome =
  | { outcome: 'EXECUTED'; capability: string; envelope: { status: string; error_type: string | null; message: string; data: unknown }; executionLogId: string }
  | { outcome: 'NEEDS_AUTH'; capability: string; missing: string[] }
  | { outcome: 'UNSUPPORTED'; inferredName: string | null; reasoning: string; gapId: string }
  | { outcome: 'VALIDATION_ERROR'; capability: string; errors: string[] }
  | {
      outcome: 'NEEDS_CONFIRMATION';
      capability: string;
      displayName: string;
      args: Record<string, unknown>;
      confidence: number;
      reasoning: string;
    };

/** 実行前に人が確認する内容（NEEDS_CONFIRMATION を受けて RunPreviewRow に出す） */
interface PendingDeliverable {
  kind: DeliverableKind;
  capability: string;
  displayName: string;
  args: Record<string, unknown>;
}

export default function ChatPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  /* エージェント詳細の「チャットで修正」から来たときの編集対象 */
  const location = useLocation();
  const editingFromNav = (location.state ?? null) as
    | { editingAgentId?: string; agentName?: string }
    | null;
  const {
    sessions, setSessions, currentSessionId, setCurrentSession,
    messages, setMessages, addMessage,
    pendingDepartment, setPendingDepartment,
    selectedAgentId, setSelectedAgent,
    streamingContent, setStreamingContent, appendStreamingContent,
    streamingDepartment, setStreamingDepartment,
    autoCreateSession, setAutoCreateSession,
    editingAgent, setEditingAgent,
  } = useChatStore();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // 部署選択はトップバー常設のグローバルトグル（v3）。旧サイドバーのチップ列は撤去済み
  const selectedDept = useDeptFilterStore((st) => st.dept);
  const setSelectedDept = useDeptFilterStore((st) => st.setDept);
  const [showSidebar, setShowSidebar] = useState(true);
  const [inlineTasks, setInlineTasks] = useState<InlineTask[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showTaskSidebar, setShowTaskSidebar] = useState(false);
  // 会話が定型業務に育ったときのエージェント化提案
  const [agentSuggestion, setAgentSuggestion] = useState<{ afterMessageId: string; draft: AgentDraft } | null>(null);
  const [suggestModalOpen, setSuggestModalOpen] = useState(false);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  // チャット内容からの成果物生成（Google Doc/Sheet/Slides/Slack）
  const [creatingDeliverable, setCreatingDeliverable] = useState<DeliverableKind | null>(null);
  /* 実行前の確認待ち（RunPreviewRow で承認するまで作成しない） */
  const [pendingDeliverable, setPendingDeliverable] = useState<PendingDeliverable | null>(null);
  const [confirmingDeliverable, setConfirmingDeliverable] = useState(false);
  /* エージェント修正モードの対象はストアが持つ（useChatStore）。
     ⚠️ location.state に置くと、セッション作成で /chat → /chat/:id に遷移した時点で
     消えて編集フローが成立しない。古い遷移経路との互換のため state も拾う。 */
  const [applyingSuggestion, setApplyingSuggestion] = useState(false);
  /* 外部API接続（カスタムノード）の提案。実キーはこのカードの入力欄からのみ渡す */
  const [nodeSuggestion, setNodeSuggestion] = useState<{ afterMessageId: string; draft: NodeDraft } | null>(null);
  const [creatingNode, setCreatingNode] = useState(false);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const isOwner = useAuthStore((s) => s.user?.role) === 'OWNER';
  /* ノードの表示名を引くためのレジストリ（設定>連携 と同じキャッシュを共有） */
  const capabilitiesQ = useQuery({
    queryKey: ['capabilities'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: { name: string; displayName: string; kind?: string | null; httpMethod?: string | null }[] }>(
        '/capabilities',
      );
      return res.data.data;
    },
  });
  /* 旧経路（location.state）から来た場合はストアへ移してから使う */
  useEffect(() => {
    if (editingFromNav?.editingAgentId && editingAgent?.id !== editingFromNav.editingAgentId) {
      setEditingAgent({
        id: editingFromNav.editingAgentId,
        name: editingFromNav.agentName ?? 'エージェント',
      });
    }
  }, [editingFromNav?.editingAgentId, editingFromNav?.agentName, editingAgent?.id, setEditingAgent]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const lastInputRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  // Load sessions
  useEffect(() => {
    api.get<{ success: boolean; data: ChatSession[] }>('/chat/sessions')
      .then((res) => {
        setSessions(res.data.data);
      })
      .catch(() => null);
  }, [setSessions]);

  // Load messages when session changes
  useEffect(() => {
    if (id && id !== currentSessionId) {
      setCurrentSession(id);
      setAgentSuggestion(null);
      setSuggestModalOpen(false);
      setSuggestDismissed(false);
      // 外部API接続の提案もセッションに属する。残すと別の会話にカードが出続ける
      setNodeSuggestion(null);
      setNodeError(null);
      api.get<{ success: boolean; data: Message[] }>(`/chat/sessions/${id}/messages`)
        .then((res) => setMessages(res.data.data))
        .catch(() => null);
    }
  }, [id, currentSessionId, setCurrentSession, setMessages]);

  // 実行確認カードはセッションに属する。id が変わったら必ず捨てる。
  // 残したまま別セッションで承認すると、前のセッションの内容で成果物が作られる。
  useEffect(() => {
    setPendingDeliverable(null);
    setConfirmingDeliverable(false);
  }, [id]);

  // Handle selected agent from dashboard
  useEffect(() => {
    if (selectedAgentId) {
      // Map agent id to department
      const agentToDept: Record<string, string> = {
        sales: 'SALES',
        marketing: 'MARKETING',
        accounting: 'ACCOUNTING',
        analytics: 'ANALYTICS',
        general: 'GENERAL',
        assistant: 'GENERAL',
      };
      setSelectedDept(agentToDept[selectedAgentId] ?? 'GENERAL');
    }
  }, [selectedAgentId]);

  // Auto-close left sidebar on narrow screens when right sidebar opens
  useEffect(() => {
    if (showTaskSidebar && window.innerWidth < 1280) setShowSidebar(false);
  }, [showTaskSidebar]);

  // Auto scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, inlineTasks, streamingContent]);

  // Auto resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    }
  };

  const createSession = useCallback(async () => {
    const res = await api.post<{ success: boolean; data: ChatSession }>('/chat/sessions', {});
    const session = res.data.data;
    setSessions([session, ...sessions]);
    navigate(`/chat/${session.id}`);
  }, [sessions, setSessions, navigate]);

  // Auto-create session when navigating from dashboard/BottomNav with autoCreateSession flag
  useEffect(() => {
    if (!id && autoCreateSession) {
      setAutoCreateSession(false);
      void createSession();
    }
  }, [id, autoCreateSession, setAutoCreateSession, createSession]);

  // Once on a session, also apply pendingDepartment (fires after createSession navigation)
  useEffect(() => {
    if (pendingDepartment && id) {
      setSelectedDept(pendingDepartment);
      setPendingDepartment(null);
    }
  }, [pendingDepartment, id, setPendingDepartment]);

  const sendMessage = async () => {
    if (!input.trim() || sending || !id) return;
    setSending(true);
    // 添付ファイルがあればテキストに追記（RAG 用に fileIds も別途送る）
    let text = input.trim();
    const fileIds = attachedFiles.map((f) => f.id);
    if (attachedFiles.length > 0) {
      const fileInfo = attachedFiles.map((f) => `[添付: ${f.name} (ID:${f.id})]`).join('\n');
      text = `${text}\n\n${fileInfo}`;
    }
    lastInputRef.current = text;
    setInput('');
    setAttachedFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const tmpMsg: Message = {
      id: `tmp-${Date.now()}`, sessionId: id, role: 'user',
      content: text, department: null, createdAt: new Date().toISOString(),
    };
    addMessage(tmpMsg);
    setStreamingContent('');
    setStreamingDepartment(null);

    try {
      const token = useAuthStore.getState().token;
      // ベース URL は services/api.ts の単一ソースを使う（VITE_API_URL の重複定義を解消）
      const apiBase = api.defaults.baseURL ?? '/api';
      const res = await fetch(`${apiBase}/chat/sessions/${id}/messages/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          content: text,
          department: selectedDept ?? undefined,
          fileIds: fileIds.length > 0 ? fileIds : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalAssistantMessage: Message | null = null;
      let realUserMessage: Message | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'userMessage') {
              realUserMessage = event.data;
            } else if (event.type === 'token') {
              appendStreamingContent(event.content);
            } else if (event.type === 'department') {
              setStreamingDepartment(event.department);
            } else if (event.type === 'done') {
              finalAssistantMessage = event.data;
            }
          } catch { /* skip */ }
        }
      }

      // Replace temp messages with real ones
      if (realUserMessage && finalAssistantMessage) {
        setMessages([
          ...messages.filter((m) => !m.id.startsWith('tmp-')),
          realUserMessage,
          finalAssistantMessage,
        ]);

        // ※ 以前はここでチャット送信ごとに自動でタスクを作成・実行していたが、
        //   会話の返答とは別に「タスク」が同じ質問を再度返す二重応答＝リピートの原因になっていたため廃止。
        //   成果物は下の「成果物を作成」バー（明示操作）から生成する。

        // 外部APIの繋ぎ方が貼られたら、接続ノードの提案を取りにいく（保存はしない）。
        // ⚠️ 送るのは lastInputRef の本文だが、gateway 側で scrubSecrets を通してから
        //    ai-engine に渡るので、実キーは AI にも AILog にも届かない。
        if (isOwner && looksLikeApiSpec(lastInputRef.current)) {
          const finalId = (finalAssistantMessage as Message).id;
          api.post<{ success: boolean; data: NodeDraft }>('/capabilities/suggest', {
            source: lastInputRef.current,
          })
            .then((r) => {
              const d = r.data.data;
              if (d?.http?.url && d?.name) {
                setNodeError(null);
                setNodeSuggestion({ afterMessageId: finalId, draft: d });
              }
            })
            .catch(() => null);
        }

        // 修正モード: 対象エージェントの手順を作り直す提案を取りにいく（保存はしない）
        if (editingAgent) {
          const finalId = (finalAssistantMessage as Message).id;
          api.post<{ success: boolean; data: AgentDraft & { steps?: AgentStepDef[] } }>(
            '/agents/suggest',
            { description: lastInputRef.current, agentId: editingAgent.id },
          )
            .then((r) => {
              const d = r.data.data;
              if (d?.steps?.length || d?.instructions) {
                setAgentSuggestion({ afterMessageId: finalId, draft: d });
              }
            })
            .catch(() => null);
        }
        // 会話が定型業務に育ったらエージェント化を提案（既に提案中/却下済みならスキップ）
        else if (!agentSuggestion && !suggestDismissed) {
          const finalId = (finalAssistantMessage as Message).id;
          api.post<{ success: boolean; data: { suggest: boolean; draft?: AgentDraft } }>(
            `/chat/sessions/${id}/suggest`,
            {},
          )
            .then((r) => {
              if (r.data.data.suggest && r.data.data.draft) {
                setAgentSuggestion({ afterMessageId: finalId, draft: r.data.data.draft });
              }
            })
            .catch(() => null);
        }
      }

      api.get<{ success: boolean; data: ChatSession[] }>('/chat/sessions')
        .then((r) => setSessions(r.data.data)).catch(() => null);
    } catch (e) {
      addMessage({
        id: `err-${Date.now()}`, sessionId: id, role: 'assistant',
        content: humanizeTaskManagerError(e),
        department: null,
        createdAt: new Date().toISOString(),
      });
    } finally {
      setSending(false);
      setStreamingContent(null);
      setStreamingDepartment(null);
    }
  };

  // WebSocket接続でタスクログをリアルタイム受信
  const connectTaskStream = useCallback((taskId: string) => {
    const token = useAuthStore.getState().token;
    const wsBase = import.meta.env.VITE_WS_URL || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    const ws = new WebSocket(`${wsBase}/api/tasks/${taskId}/stream?token=${token}`);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'logs') {
          setInlineTasks((prev) => prev.map((t) =>
            t.id === taskId ? { ...t, logs: [...t.logs, ...data.data] } : t
          ));
        } else if (data.type === 'done') {
          const newStatus = data.status === 'DONE' ? 'done' as const : 'failed' as const;
          // タスク完了時に出力データを取得
          api.get<{ success: boolean; data: { output?: string } }>(`/tasks/${taskId}`)
            .then((res) => {
              setInlineTasks((prev) => prev.map((t) =>
                t.id === taskId ? { ...t, status: newStatus, output: res.data.data.output ?? undefined } : t
              ));
            })
            .catch(() => {
              setInlineTasks((prev) => prev.map((t) =>
                t.id === taskId ? { ...t, status: newStatus } : t
              ));
            });
        }
      } catch { /* skip */ }
    };

    ws.onerror = () => ws.close();
    return ws;
  }, []);

  // タスク作成後に自動でWebSocket接続
  const executingTaskIds = inlineTasks.filter((t) => t.status === 'executing').map((t) => t.id).join(',');
  useEffect(() => {
    if (!executingTaskIds) return;
    const ids = executingTaskIds.split(',');
    const wsRefs: WebSocket[] = [];
    for (const taskId of ids) {
      const ws = connectTaskStream(taskId);
      wsRefs.push(ws);
    }
    return () => { wsRefs.forEach((ws) => ws.close()); };
  }, [executingTaskIds, connectTaskStream]);

  const handleApproveTask = useCallback((_taskId: string) => {
    // タスクは作成時にQUEUED状態で自動実行されるため、承認は表示用
    setInlineTasks((prev) => prev.map((t) =>
      t.id === _taskId ? { ...t, status: 'executing' as const } : t
    ));
  }, []);

  const handleRejectTask = useCallback((taskId: string) => {
    // バックエンドでもキャンセル
    api.patch(`/tasks/${taskId}`, { status: 'FAILED' }).catch(() => null);
    setInlineTasks((prev) => prev.map((t) =>
      t.id === taskId ? { ...t, status: 'rejected' as const } : t
    ));
  }, []);

  // タスク結果パネルからのアクション（Gmail送信、SNS投稿、カレンダー登録等）
  const handleTaskAction = useCallback((taskId: string, action: string) => {
    // 承認APIを呼び出し、n8nの実行フェーズをトリガー
    setInlineTasks((prev) => prev.map((t) =>
      t.id === taskId ? { ...t, status: 'executing' as const } : t
    ));
    api.post(`/tasks/${taskId}/approve`, { action })
      .then(() => {
        // WebSocket で結果を受信するので、ここでは executing 状態に更新するだけ
        const ws = connectTaskStream(taskId);
        // cleanup は不要（done で自動 close）
        ws.onerror = () => ws.close();
      })
      .catch(() => {
        setInlineTasks((prev) => prev.map((t) =>
          t.id === taskId ? { ...t, status: 'failed' as const } : t
        ));
      });
  }, [connectTaskStream]);

  // Voice input
  const toggleVoice = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'ja-JP';
    recognition.continuous = true;
    recognition.interimResults = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(transcript);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognition.start();
    recognitionRef.current = recognition;
    setIsListening(true);
  };

  // File attachment
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await api.post<{ success: boolean; data: { id: string; originalName: string; mimeType: string } }>('/files/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        if (res.data.success) {
          setAttachedFiles((prev) => [...prev, { id: res.data.data.id, name: res.data.data.originalName, mimeType: res.data.data.mimeType }]);
        }
      }
    } catch { /* skip */ }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachedFile = (fileId: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const handleSuggestionSelect = (prompt: string) => {
    setInput(prompt);
    textareaRef.current?.focus();
  };

  // 直近のAI回答を成果物（Google Doc/Sheet/Slides/Slack）に変換する。
  // resolver が会話内容から capability と引数を推論し、実行（未接続なら NEEDS_AUTH 案内）。
  const KIND_PROMPT: Record<DeliverableKind, string> = {
    doc: '次の内容を Google ドキュメントとして作成してください。',
    sheet: '次の内容を Google スプレッドシート（表）として作成してください。',
    slides: '次の内容を Google スライドとして作成してください。',
    slack: '次の内容を Slack に投稿してください。',
  };
  /** resolver の結果をチャット欄のメッセージ文言にする（実行済み・失敗系のみ）。 */
  const describeOutcome = (o: ResolveOutcome, kind: DeliverableKind): string => {
    if (o.outcome === 'EXECUTED') {
      const url = (o.envelope?.data as { url?: string } | undefined)?.url;
      return o.envelope?.status === 'success'
        ? `✅ ${o.envelope.message}${url ? `\n${url}` : ''}`
        : `⚠️ 作成に失敗しました：${o.envelope?.message ?? '不明なエラー'}`;
    }
    if (o.outcome === 'NEEDS_AUTH') {
      const label = kind === 'slack' ? 'Slack' : 'Google';
      return `🔌 「${label}」が未接続です（${o.missing.join(', ')}）。設定 > 連携 から接続すると使えるようになります。`;
    }
    if (o.outcome === 'VALIDATION_ERROR') {
      return `⚠️ 成果物に必要な情報が不足しています：${o.errors.join(', ')}。もう少し具体的に内容を決めてから再度お試しください。`;
    }
    if (o.outcome === 'UNSUPPORTED') {
      return `この内容はまだ自動作成に対応していません。${o.reasoning ? `（${o.reasoning}）` : ''}`;
    }
    return '確認が必要です。';
  };

  /**
   * 提案された外部API接続を登録する。
   *
   * ⚠️ 実キーは**このリクエストだけ**に載せる。チャット本文にも、他の API にも渡さない。
   *    gateway 側で sealSecret して暗号文で保存され、以降は復号して送信時にだけ使われる。
   */
  const createNodeFromSuggestion = async (secrets: Record<string, string>) => {
    if (!nodeSuggestion || creatingNode) return;
    const startedInSession = id;
    setCreatingNode(true);
    setNodeError(null);
    try {
      const d = nodeSuggestion.draft;
      const headers = (d.http?.headers ?? []).map((h) =>
        h.secret
          ? { name: h.name, value: secrets[h.name] ?? '', secret: true }
          : { name: h.name, value: h.value ?? '', secret: false },
      );
      await api.post('/capabilities', {
        name: d.name,
        displayName: d.displayName ?? d.name,
        description: d.description ?? '',
        department: d.department ?? 'GENERAL',
        params: d.params ?? [],
        http: { ...d.http, headers },
      });
      setNodeSuggestion(null);
      // ⚠️ 通信中にセッションを切り替えられていたら、完了メッセージを今のセッションに
      //    差し込まない（DB には無いので再読込で消える「幽霊メッセージ」になる）
      if (startedInSession === id) {
        pushAssistantMessage(
          `✅ 「${d.displayName ?? d.name}」を登録しました。エージェントの手順に組み込めます（ガバナンス > 外部API接続 で確認・停止できます）。`,
        );
      }
    } catch (e) {
      const data = (e as { response?: { data?: { error?: { message?: string } } } }).response?.data;
      setNodeError(data?.error?.message ?? '登録できませんでした');
    } finally {
      setCreatingNode(false);
    }
  };

  /** 修正提案をエージェントへ反映する（チャットが唯一の編集入口なので確定もここ）。 */
  const applySuggestionToAgent = async () => {
    if (!editingAgent || !agentSuggestion || applyingSuggestion) return;
    setApplyingSuggestion(true);
    try {
      const d = agentSuggestion.draft;
      await api.patch(`/agents/${editingAgent.id}`, {
        ...(d.steps ? { steps: d.steps } : {}),
        ...(d.instructions ? { instructions: d.instructions } : {}),
      });
      setAgentSuggestion(null);
      pushAssistantMessage(
        `✅ 「${editingAgent.name}」の手順を更新しました。エージェント詳細で確認できます。`,
      );
    } catch (e) {
      pushAssistantMessage(humanizeTaskManagerError(e));
    } finally {
      setApplyingSuggestion(false);
    }
  };

  const pushAssistantMessage = (content: string) => {
    if (!id) return;
    addMessage({
      id: `deliverable-${Date.now()}`,
      sessionId: id,
      role: 'assistant',
      content,
      department: null,
      createdAt: new Date().toISOString(),
    });
  };

  // 成果物の作成は 2 段階。まず preview で「何を・どんな内容で作るか」を出し、
  // 人が確認してから name + args 指定で確定実行する（確定実行は確認ゲートを通らない）。
  const createDeliverable = async (kind: DeliverableKind) => {
    if (creatingDeliverable || !id) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const source = lastAssistant?.content ?? lastInputRef.current;
    if (!source.trim()) return;
    setCreatingDeliverable(kind);
    const rawInput = `${KIND_PROMPT[kind]}\n\n${source.slice(0, 6000)}`;
    try {
      const res = await api.post<{ success: boolean; data: ResolveOutcome }>('/capabilities/resolve', {
        rawInput,
        mode: 'preview',
      });
      const o = res.data.data;
      if (o.outcome === 'NEEDS_CONFIRMATION') {
        setPendingDeliverable({
          kind,
          capability: o.capability,
          displayName: o.displayName,
          args: o.args,
        });
      } else {
        pushAssistantMessage(describeOutcome(o, kind));
      }
    } catch (e) {
      pushAssistantMessage(humanizeTaskManagerError(e));
    } finally {
      setCreatingDeliverable(null);
    }
  };

  /** 確認済みの内容で確定実行する。 */
  const confirmDeliverable = async () => {
    if (!pendingDeliverable || confirmingDeliverable) return;
    setConfirmingDeliverable(true);
    const { kind, capability, args } = pendingDeliverable;
    try {
      const res = await api.post<{ success: boolean; data: ResolveOutcome }>('/capabilities/resolve', {
        name: capability,
        args,
      });
      pushAssistantMessage(describeOutcome(res.data.data, kind));
      setPendingDeliverable(null);
    } catch (e) {
      pushAssistantMessage(humanizeTaskManagerError(e));
      setPendingDeliverable(null);
    } finally {
      setConfirmingDeliverable(false);
    }
  };

  return (
    <div className="flex h-full relative">
      {/* Sidebar overlay (mobile) */}
      <AnimatePresence>
        {showSidebar && (
          <motion.div
            className="absolute inset-0 bg-overlay z-20 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowSidebar(false)}
          />
        )}
      </AnimatePresence>

      {/* Session sidebar - Claude style */}
      <AnimatePresence>
        {showSidebar && (
          <motion.aside
            className="absolute lg:relative z-30 lg:z-0 w-64 h-full flex-shrink-0 flex flex-col border-r border-border bg-elevated"
            aria-label="チャット履歴"
            initial={{ x: -256 }}
            animate={{ x: 0 }}
            exit={{ x: -256 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            <div className="p-4 flex items-center gap-2">
              <motion.button
                onClick={createSession}
                className="flex-1 flex items-center justify-center gap-2 bg-action hover:bg-action-hover text-white text-xs font-bold px-4 py-3 rounded-md shadow-[0_1px_2px_rgba(10,37,64,0.24),inset_0_1px_0_rgba(255,255,255,0.16)] transition-colors"
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
              >
                <Plus size={14} /> 新しいチャット
              </motion.button>
              <button
                onClick={() => setShowSidebar(false)}
                aria-label="履歴サイドバーを閉じる"
                className="w-9 h-9 rounded-xl bg-sunken flex items-center justify-center text-secondary hover:text-primary transition-colors"
              >
                <PanelLeftClose size={15} />
              </button>
            </div>

            {/* Session list */}
            <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5 scrollbar-hide">
              {sessions.length === 0 && (
                <p className="text-xs text-text-muted text-center py-6">チャット履歴なし</p>
              )}
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { navigate(`/chat/${s.id}`); setShowSidebar(false); }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-xs truncate transition-all ${
                    s.id === id
                      ? 'bg-sunken text-primary font-semibold'
                      : 'text-secondary hover:bg-sunken/60'
                  }`}
                  aria-current={s.id === id ? 'page' : undefined}
                >
                  {s.title ?? '新しいチャット'}
                </button>
              ))}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 bg-canvas">
        {!id ? (
          /* Empty state - welcome screen */
          <div className="flex-1 flex items-center justify-center p-6">
            <motion.div
              className="text-center max-w-md"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <div className="w-16 h-16 bg-accent-soft rounded-2xl flex items-center justify-center mx-auto mb-5">
                <Sparkles size={28} className="text-accent" />
              </div>
              <p className="text-xl font-bold text-primary mb-2">AIエージェントに相談する</p>
              <p className="text-sm text-secondary mb-3 leading-relaxed">
                各部署のAIエージェントが業務をサポートします。<br />
                メール作成、リサーチ、データ分析、SNS投稿まで。
              </p>
              <p className="text-xs text-text-muted mb-8 max-w-sm mx-auto">
                ここは会話・相談向けです。長い成果物パイプラインはメニューの「タスク」からどうぞ。
              </p>
              <div className="flex gap-3 justify-center flex-wrap">
                <motion.button
                  onClick={createSession}
                  className="bg-action hover:bg-action-hover text-white text-sm font-bold px-6 py-3 rounded-md shadow-[0_1px_2px_rgba(10,37,64,0.24),inset_0_1px_0_rgba(255,255,255,0.16)] transition-colors flex items-center gap-2"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Plus size={16} /> 新しいチャット
                </motion.button>
              </div>

              {/* Quick action cards — 各部署のキャラクター */}
              <div className="grid grid-cols-2 gap-3 mt-8">
                {DEPARTMENTS.map((d) => {
                  const char = DEPT_CHARACTER[d.key];
                  return (
                    <motion.button
                      key={d.key}
                      onClick={async () => {
                        setSelectedDept(d.key);
                        await createSession();
                      }}
                      className="bg-elevated border border-border shadow-elev-1 rounded-lg p-3 text-left flex items-center gap-3 hover:border-accent transition-all"
                      whileHover={{ scale: 1.02, y: -2 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      {char ? (
                        <img
                          src={char.image}
                          alt={char.name}
                          className="w-12 h-12 rounded-full object-cover bg-sunken flex-shrink-0"
                          style={{ boxShadow: `0 0 0 2px ${DEPT_ACCENT[d.key]}33` }}
                        />
                      ) : (
                        <span className="text-2xl">{d.icon}</span>
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-primary truncate">{d.label}</p>
                        <p className="text-[10px] text-secondary truncate">{char?.name ?? 'AIに相談'}</p>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          </div>
        ) : (
          <>
            {/* Top bar */}
            <div className="flex items-center gap-2 px-4 py-2.5 bg-elevated border-b border-border flex-shrink-0">
              {!showSidebar && (
                <button
                  onClick={() => setShowSidebar(true)}
                  aria-label="履歴サイドバーを開く"
                  className="w-8 h-8 rounded-md bg-sunken flex items-center justify-center text-secondary hover:text-primary transition-colors"
                >
                  <PanelLeftOpen size={15} />
                </button>
              )}
              <div className="flex-1 flex items-center gap-2 min-w-0">
                {selectedDept && (
                  <>
                    {DEPT_CHARACTER[selectedDept] && (
                      <img
                        src={DEPT_CHARACTER[selectedDept].image}
                        alt={DEPT_CHARACTER[selectedDept].name}
                        className="w-7 h-7 rounded-full object-cover bg-sunken flex-shrink-0"
                        style={{ boxShadow: `0 0 0 2px ${DEPT_ACCENT[selectedDept]}33` }}
                      />
                    )}
                    <span
                      className="text-xs font-semibold px-2.5 py-1 rounded-full"
                      style={{ backgroundColor: `${DEPT_ACCENT[selectedDept]}1A`, color: DEPT_ACCENT[selectedDept] }}
                    >
                      {DEPT_CHARACTER[selectedDept]?.name ?? DEPT_LABEL[selectedDept]}
                    </span>
                    <button
                      onClick={() => { setSelectedDept(null); setSelectedAgent(null); }}
                      aria-label="部署の指定を解除"
                      className="text-text-muted hover:text-secondary transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowTaskSidebar(!showTaskSidebar)}
                  aria-label="タスク進行パネルを開閉"
                  aria-expanded={showTaskSidebar}
                  className="w-8 h-8 rounded-md bg-sunken flex items-center justify-center text-secondary hover:text-accent transition-colors relative"
                >
                  <ClipboardList size={15} />
                  {inlineTasks.filter((t) => t.status === 'executing').length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-accent rounded-full text-[8px] text-white flex items-center justify-center font-bold">
                      {inlineTasks.filter((t) => t.status === 'executing').length}
                    </span>
                  )}
                </button>
                <Link
                  to="/tasks"
                  className="text-xs text-secondary hover:text-accent transition-colors font-medium"
                >
                  全タスク →
                </Link>
              </div>
            </div>

            <div className="px-4 py-1.5 bg-sunken border-b border-border text-micro text-secondary text-center flex flex-wrap items-center justify-center gap-1">
              <span>チャットは相談・下書き用です。</span>
              <Link to="/tasks" className="text-accent font-medium hover:underline">
                タスク管理
              </Link>
              <span>でメールや資料などの成果物パイプラインを回せます</span>
            </div>

            {/* Messages area - Claude style vertical stack */}
            <div className="flex-1 overflow-y-auto scrollbar-hide">
              <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
                {messages.length === 0 && !sending && (
                  <div className="flex flex-col items-center justify-center py-12 text-center px-2">
                    <div className="w-12 h-12 bg-accent-soft rounded-2xl flex items-center justify-center mb-3">
                      <Bot size={20} className="text-accent" />
                    </div>
                    <p className="text-sm text-secondary mb-1">
                      {selectedDept
                        ? `${DEPT_LABEL[selectedDept]}AIに質問してください`
                        : '何でも聞いてください'}
                    </p>
                    <p className="text-xs text-text-muted mb-4">担当部署が自動で応答します</p>
                    <p className="text-micro text-text-muted mb-2 w-full max-w-md">例（タップで入力欄に挿入）</p>
                    <div className="flex flex-col gap-2 w-full max-w-md">
                      {[
                        '今週の営業フォロー用に短いメールの下書きを作って',
                        '競合A社と自社の強みを比較した箇条書きで',
                        '経費精算の注意点を初心者向けに3行で',
                      ].map((hint) => (
                        <button
                          key={hint}
                          type="button"
                          onClick={() => {
                            setInput(hint);
                            textareaRef.current?.focus();
                          }}
                          className="text-left text-xs px-3 py-2.5 rounded-xl bg-elevated border border-border text-secondary hover:border-accent transition-colors"
                        >
                          {hint}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((msg) => (
                  <div key={msg.id}>
                    {/* Claude-style: all left-aligned, vertical stack */}
                    <motion.div
                      className="flex gap-3"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      {/* Avatar */}
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5 ${
                        msg.role === 'user'
                          ? 'bg-sunken'
                          : 'bg-accent-soft'
                      }`}>
                        {msg.role === 'user'
                          ? <UserIcon size={15} className="text-secondary" />
                          : <Bot size={15} className="text-accent" />
                        }
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-primary">
                            {msg.role === 'user' ? 'あなた' : 'AI'}
                          </span>
                          {msg.role === 'assistant' && msg.department && (
                            <span
                              className={`text-micro px-2 py-0.5 rounded-full font-medium ${DEPT_ACCENT[msg.department] ? '' : 'bg-sunken text-secondary'}`}
                              style={DEPT_ACCENT[msg.department] ? {
                                backgroundColor: `${DEPT_ACCENT[msg.department]}15`,
                                color: DEPT_ACCENT[msg.department],
                              } : undefined}
                            >
                              {DEPT_LABEL[msg.department] ?? msg.department}
                            </span>
                          )}
                        </div>
                        <div className="text-sm leading-relaxed text-primary">
                          {msg.role === 'assistant' ? (
                            <MarkdownLite text={stripJsonBlocks(msg.content)} />
                          ) : (
                            <p className="whitespace-pre-wrap">{msg.content}</p>
                          )}
                        </div>
                      </div>
                    </motion.div>

                    {/* Inline task card after assistant messages */}
                    {msg.role === 'assistant' && inlineTasks
                      .filter((t) => t.afterMessageId === msg.id)
                      .map((task) => (
                        <div key={task.id} className="ml-11 mt-3">
                          <InlineChatResult
                            taskId={task.id}
                            taskTitle={task.title}
                            department={task.department}
                            logs={task.logs}
                            status={task.status}
                            output={task.output}
                            onApprove={() => handleApproveTask(task.id)}
                            onReject={() => handleRejectTask(task.id)}
                            onAction={(action) => handleTaskAction(task.id, action)}
                          />
                        </div>
                      ))
                    }

                    {/* エージェント化の訴求カード（会話が定型業務に育ったとき） */}
                    {msg.role === 'assistant' && agentSuggestion?.afterMessageId === msg.id && (
                      <div className="ml-11 mt-3">
                        <AgentCtaCard
                          draft={agentSuggestion.draft}
                          capabilities={(capabilitiesQ.data ?? []).map((c) => ({
                            name: c.name,
                            displayName: c.displayName,
                            kind: c.kind,
                            httpMethod: c.httpMethod ?? null,
                          }))}
                          editing={!!editingAgent}
                          busy={applyingSuggestion}
                          onCreate={() => {
                            if (editingAgent) void applySuggestionToAgent();
                            else setSuggestModalOpen(true);
                          }}
                          onDismiss={() => { setAgentSuggestion(null); setSuggestDismissed(true); }}
                        />
                      </div>
                    )}

                    {/* 外部API接続の確認カード（curl / API ドキュメントを貼ったとき）。
                        実キーの入口はここだけ — 会話にも AI にも渡らない */}
                    {msg.role === 'assistant' && nodeSuggestion?.afterMessageId === msg.id && (
                      <div className="ml-11 mt-3">
                        <NodeCtaCard
                          draft={nodeSuggestion.draft}
                          busy={creatingNode}
                          error={nodeError}
                          onCreate={(secrets) => void createNodeFromSuggestion(secrets)}
                          onDismiss={() => { setNodeSuggestion(null); setNodeError(null); }}
                        />
                      </div>
                    )}
                  </div>
                ))}

                {/* Streaming message or typing indicator */}
                {sending && (
                  <motion.div
                    className="flex gap-3"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    <div className="w-8 h-8 bg-accent-soft rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot size={15} className="text-accent" />
                    </div>
                    {streamingContent ? (
                      <div className="flex-1 min-w-0" aria-live="polite">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-primary">AI</span>
                          {streamingDepartment && (
                            <span
                              className={`text-micro px-2 py-0.5 rounded-full font-medium ${DEPT_ACCENT[streamingDepartment] ? '' : 'bg-sunken text-secondary'}`}
                              style={DEPT_ACCENT[streamingDepartment] ? {
                                backgroundColor: `${DEPT_ACCENT[streamingDepartment]}15`,
                                color: DEPT_ACCENT[streamingDepartment],
                              } : undefined}
                            >
                              {DEPT_LABEL[streamingDepartment] ?? streamingDepartment}
                            </span>
                          )}
                        </div>
                        <div className="text-sm leading-relaxed text-primary">
                          <MarkdownLite text={stripJsonBlocks(streamingContent ?? '')} />
                          <span className="inline-block w-0.5 h-4 bg-accent ml-0.5 animate-pulse align-middle" />
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 pt-2">
                        <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    )}
                  </motion.div>
                )}

                <div ref={bottomRef} />
              </div>
            </div>

            {/* Input area - Claude style pill */}
            <div className="p-4 bg-transparent">
              <div className="max-w-3xl mx-auto">
                {/* エージェント修正モードの表示。新しい画面は作らず1行のチップだけ出す */}
                {editingAgent && (
                  <div className="mb-2 flex items-center gap-2 rounded-md border border-accent-soft-border bg-accent-soft px-3 py-1.5">
                    <Bot size={13} className="shrink-0 text-accent" aria-hidden="true" />
                    <p className="min-w-0 flex-1 truncate text-xs text-primary">
                      <span className="font-bold">{editingAgent.name}</span> を編集中 — 変えたいことを書いてください
                    </p>
                    <Link
                      to={`/agents/${editingAgent.id}`}
                      className="shrink-0 text-micro font-bold text-action hover:underline"
                    >
                      詳細
                    </Link>
                    <button
                      type="button"
                      onClick={() => { setEditingAgent(null); setAgentSuggestion(null); }}
                      aria-label="編集モードを終了"
                      className="shrink-0 text-text-muted transition-colors hover:text-secondary"
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}

                {/* 実行前の確認。ここで承認するまで成果物は作られない */}
                {pendingDeliverable && (
                  <div className="mb-3">
                    <RunPreviewRow
                      preview={{
                        capabilityLabel: pendingDeliverable.displayName,
                        args: Object.entries(pendingDeliverable.args).map(([key, value]) => ({
                          key,
                          value: typeof value === 'string' ? value : JSON.stringify(value),
                        })),
                      }}
                      busy={confirmingDeliverable}
                      onApprove={confirmDeliverable}
                      onCancel={() => setPendingDeliverable(null)}
                    />
                  </div>
                )}

                {/* 成果物バー（AIが何か出力した後に表示） */}
                {messages.some((m) => m.role === 'assistant') && !pendingDeliverable && (
                  <DeliverableBar onCreate={createDeliverable} busy={creatingDeliverable} disabled={sending} />
                )}

                {/* Agent suggestions */}
                <AgentSuggestions
                  agentId={selectedAgentId}
                  onSelect={handleSuggestionSelect}
                />

                {/* Input container */}
                <div className="rounded-xl border border-border bg-elevated px-4 py-3 shadow-elev-2 transition-all">
                  {/* Attached files chips */}
                  {attachedFiles.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {attachedFiles.map((f) => (
                        <span key={f.id} className="flex items-center gap-1 text-micro bg-sunken text-primary px-2.5 py-1 rounded-full">
                          <FileIcon size={10} className="text-text-muted" />
                          {f.name}
                          <button onClick={() => removeAttachedFile(f.id)} aria-label={`添付 ${f.name} を外す`} className="text-text-muted hover:text-danger ml-0.5">
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void sendMessage();
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void sendMessage();
                      }
                    }}
                    placeholder={selectedDept ? `${DEPT_LABEL[selectedDept]}AIに指示を入力...` : 'AIに何でも聞いてください...'}
                    aria-label="AIへのメッセージ"
                    className="w-full bg-transparent border-0 text-sm text-primary placeholder:text-muted resize-none focus:outline-none"
                    rows={1}
                    style={{ maxHeight: '160px' }}
                  />
                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx,.xlsx,.csv,.txt,.png,.jpg,.jpeg"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center gap-1">
                      {selectedDept && (
                        <span
                          className="text-micro px-2 py-0.5 rounded-full font-medium"
                          style={{
                            backgroundColor: `${DEPT_ACCENT[selectedDept]}15`,
                            color: DEPT_ACCENT[selectedDept],
                          }}
                        >
                          {DEPT_LABEL[selectedDept]}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {/* File attachment button */}
                      <motion.button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        aria-label="ファイルを添付"
                        className="w-8 h-8 rounded-xl bg-sunken text-secondary hover:text-primary flex items-center justify-center transition-all disabled:opacity-50"
                        whileTap={{ scale: 0.9 }}
                      >
                        {uploading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
                      </motion.button>
                      {/* Voice input button */}
                      <motion.button
                        onClick={toggleVoice}
                        aria-label={isListening ? '音声入力を停止' : '音声入力を開始'}
                        aria-pressed={isListening}
                        className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
                          isListening
                            ? 'bg-danger text-white'
                            : 'bg-sunken text-secondary hover:text-primary'
                        }`}
                        whileTap={{ scale: 0.9 }}
                      >
                        {isListening ? (
                          <motion.div
                            animate={{ scale: [1, 1.2, 1] }}
                            transition={{ repeat: Infinity, duration: 1 }}
                          >
                            <MicOff size={14} />
                          </motion.div>
                        ) : (
                          <Mic size={14} />
                        )}
                      </motion.button>

                      {/* Send button */}
                      <motion.button
                        onClick={sendMessage}
                        disabled={sending || !input.trim()}
                        aria-label="送信"
                        className="w-8 h-8 rounded-xl bg-action hover:bg-action-hover disabled:opacity-30 text-inverse flex items-center justify-center transition-all"
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                      >
                        {sending ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Send size={14} />
                        )}
                      </motion.button>
                    </div>
                  </div>
                </div>

                <p className="text-micro text-text-muted mt-2 text-center">
                  Enter または ⌘/Ctrl+Enter で送信 ・ Shift+Enter で改行 ・ タスク実行は承認後に進みます
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Right task progress sidebar */}
      <TaskProgressSidebar
        open={showTaskSidebar}
        onClose={() => setShowTaskSidebar(false)}
        inlineTasks={inlineTasks}
      />

      {/* チャット発のエージェント化提案モーダル（ドラフトをプリフィル・毎回フレッシュにマウント） */}
      <AnimatePresence>
        {suggestModalOpen && agentSuggestion && (
          <CreateAgentModal
            initialName={agentSuggestion.draft.name}
            initialInstructions={agentSuggestion.draft.instructions}
            initialDepartment={agentSuggestion.draft.department}
            initialSteps={agentSuggestion.draft.steps}
            onClose={() => setSuggestModalOpen(false)}
            onCreated={() => {
              setSuggestModalOpen(false);
              setAgentSuggestion(null);
              setSuggestDismissed(true);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
