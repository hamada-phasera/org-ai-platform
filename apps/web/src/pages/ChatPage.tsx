import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send, Plus, Bot, User as UserIcon, X, PanelLeftClose, PanelLeftOpen,
  Mic, MicOff, Loader2, Sparkles, Paperclip, File as FileIcon, ClipboardList,
} from 'lucide-react';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { createTaskFromChat } from '../taskmanager/utils/createTaskFromChat';
import { humanizeTaskManagerError } from '../utils/humanizeLlmError';
import { AgentSuggestions } from '../components/Chat/AgentSuggestions';
import { InlineChatResult } from '../components/Chat/InlineChatResult';
import { TaskProgressSidebar } from '../components/Chat/TaskProgressSidebar';
import type { ChatSession, Message } from '@org-ai/shared-types';
import { DEPT_LABEL, DEPT_ACCENT, DEPARTMENTS } from '../constants/departments';

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

export default function ChatPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const {
    sessions, setSessions, currentSessionId, setCurrentSession,
    messages, setMessages, addMessage,
    pendingDepartment, setPendingDepartment,
    selectedAgentId, setSelectedAgent,
    streamingContent, setStreamingContent, appendStreamingContent,
    streamingDepartment, setStreamingDepartment,
    autoCreateSession, setAutoCreateSession,
  } = useChatStore();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [inlineTasks, setInlineTasks] = useState<InlineTask[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showTaskSidebar, setShowTaskSidebar] = useState(false);
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
      api.get<{ success: boolean; data: Message[] }>(`/chat/sessions/${id}/messages`)
        .then((res) => setMessages(res.data.data))
        .catch(() => null);
    }
  }, [id, currentSessionId, setCurrentSession, setMessages]);

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
    // 添付ファイルがあればテキストに追記
    let text = input.trim();
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
      const apiBase = import.meta.env.VITE_API_URL || '/api';
      const res = await fetch(`${apiBase}/chat/sessions/${id}/messages/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ content: text, department: selectedDept ?? undefined }),
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

        // Create backend task (auto-triggers n8n via QUEUED status)
        const dept = (finalAssistantMessage as Message).department ?? selectedDept ?? 'GENERAL';
        try {
          const backendTask = await createTaskFromChat({
            department: dept,
            userMessage: lastInputRef.current,
            aiResponse: (finalAssistantMessage as Message).content,
          });
          setInlineTasks((prev) => [...prev, {
            id: backendTask.id,
            title: backendTask.title,
            status: 'executing',
            afterMessageId: (finalAssistantMessage as Message).id,
            department: dept,
            logs: [],
          }]);
        } catch {
          // task creation is optional
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

  return (
    <div className="flex h-full relative">
      {/* Sidebar overlay (mobile) */}
      <AnimatePresence>
        {showSidebar && (
          <motion.div
            className="absolute inset-0 bg-black/20 z-20 lg:hidden"
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
            className="absolute lg:relative z-30 lg:z-0 w-64 h-full flex-shrink-0 flex flex-col border-r border-[#eae8e3]"
            style={{ background: 'linear-gradient(180deg, #fffcf7 0%, #faf5ef 100%)' }}
            initial={{ x: -256 }}
            animate={{ x: 0 }}
            exit={{ x: -256 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            <div className="p-4 flex items-center gap-2">
              <motion.button
                onClick={createSession}
                className="flex-1 flex items-center gap-2 bg-[#8b85ff] hover:bg-[#7c76f2] text-white text-xs font-semibold px-4 py-3 rounded-2xl transition-all shadow-md shadow-glow-primary"
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
              >
                <Plus size={14} /> 新しいチャット
              </motion.button>
              <button
                onClick={() => setShowSidebar(false)}
                className="w-9 h-9 rounded-xl bg-white/60 flex items-center justify-center text-[#8A8A8A] hover:text-[#2D2D2D] transition-colors"
              >
                <PanelLeftClose size={15} />
              </button>
            </div>

            {/* Department filter */}
            <div className="px-4 pb-3">
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => { setSelectedDept(null); setSelectedAgent(null); }}
                  className={`text-[10px] px-2.5 py-1 rounded-full transition-all ${
                    !selectedDept ? 'bg-[#8b85ff] text-white font-semibold' : 'bg-white/60 text-[#8A8A8A] hover:bg-white'
                  }`}
                >
                  全部署
                </button>
                {DEPARTMENTS.map((d) => (
                  <button
                    key={d.key}
                    onClick={() => { setSelectedDept(d.key); setSelectedAgent(null); }}
                    className={`text-[10px] px-2.5 py-1 rounded-full transition-all ${
                      selectedDept === d.key ? 'bg-[#8b85ff] text-white font-semibold' : 'bg-white/60 text-[#8A8A8A] hover:bg-white'
                    }`}
                  >
                    {d.icon} {d.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Session list */}
            <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5 scrollbar-hide">
              {sessions.length === 0 && (
                <p className="text-xs text-[#BCBCBC] text-center py-6">チャット履歴なし</p>
              )}
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { navigate(`/chat/${s.id}`); setShowSidebar(false); }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-xs truncate transition-all ${
                    s.id === id
                      ? 'bg-white text-[#2D2D2D] font-semibold shadow-sm'
                      : 'text-[#8A8A8A] hover:bg-white/60'
                  }`}
                >
                  {s.title ?? '新しいチャット'}
                </button>
              ))}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0" style={{ background: 'linear-gradient(180deg, #fffcf7 0%, #faf5ef 100%)' }}>
        {!id ? (
          /* Empty state - welcome screen */
          <div className="flex-1 flex items-center justify-center p-6">
            <motion.div
              className="text-center max-w-md"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <div className="w-16 h-16 bg-[#8b85ff]/10 rounded-3xl flex items-center justify-center mx-auto mb-5">
                <Sparkles size={28} className="text-[#8b85ff]" />
              </div>
              <p className="text-xl font-bold text-[#2D2D2D] mb-2">AIエージェントに相談する</p>
              <p className="text-sm text-[#8A8A8A] mb-3 leading-relaxed">
                各部署のAIエージェントが業務をサポートします。<br />
                メール作成、リサーチ、データ分析、SNS投稿まで。
              </p>
              <p className="text-xs text-[#BCBCBC] mb-8 max-w-sm mx-auto">
                ここは会話・相談向けです。長い成果物パイプラインはメニューの「タスク」からどうぞ。
              </p>
              <div className="flex gap-3 justify-center flex-wrap">
                <motion.button
                  onClick={createSession}
                  className="bg-[#8b85ff] hover:bg-[#7c76f2] text-white text-sm font-semibold px-6 py-3 rounded-2xl transition-all shadow-md shadow-glow-primary flex items-center gap-2"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Plus size={16} /> 新しいチャット
                </motion.button>
              </div>

              {/* Quick action cards */}
              <div className="grid grid-cols-2 gap-3 mt-8">
                {DEPARTMENTS.map((d) => (
                  <motion.button
                    key={d.key}
                    onClick={async () => {
                      setSelectedDept(d.key);
                      await createSession();
                    }}
                    className="bg-white rounded-2xl p-4 text-left border border-[#eae8e3] hover:border-[#8b85ff]/30 transition-all"
                    whileHover={{ scale: 1.02, y: -2 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <span className="text-xl">{d.icon}</span>
                    <p className="text-xs font-semibold text-[#2D2D2D] mt-2">{d.label}</p>
                    <p className="text-[10px] text-[#8A8A8A] mt-0.5">AIに相談</p>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </div>
        ) : (
          <>
            {/* Top bar */}
            <div className="flex items-center gap-2 px-4 py-2.5 bg-white/60 backdrop-blur-sm border-b border-[#eae8e3] flex-shrink-0">
              {!showSidebar && (
                <button
                  onClick={() => setShowSidebar(true)}
                  className="w-8 h-8 rounded-xl bg-[#f5f5f0] flex items-center justify-center text-[#8A8A8A] hover:text-[#2D2D2D] transition-colors"
                >
                  <PanelLeftOpen size={15} />
                </button>
              )}
              <div className="flex-1 flex items-center gap-2 min-w-0">
                {selectedDept && (
                  <>
                    <span
                      className="text-xs font-semibold px-3 py-1 rounded-full"
                      style={{ backgroundColor: `${DEPT_ACCENT[selectedDept]}15`, color: DEPT_ACCENT[selectedDept] }}
                    >
                      {DEPT_LABEL[selectedDept]}
                    </span>
                    <button
                      onClick={() => { setSelectedDept(null); setSelectedAgent(null); }}
                      className="text-[#BCBCBC] hover:text-[#8A8A8A] transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowTaskSidebar(!showTaskSidebar)}
                  className="w-8 h-8 rounded-xl bg-[#f5f5f0] flex items-center justify-center text-[#8A8A8A] hover:text-[#8b85ff] transition-colors relative"
                >
                  <ClipboardList size={15} />
                  {inlineTasks.filter((t) => t.status === 'executing').length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-[#8b85ff] rounded-full text-[8px] text-white flex items-center justify-center font-bold">
                      {inlineTasks.filter((t) => t.status === 'executing').length}
                    </span>
                  )}
                </button>
                <Link
                  to="/tasks"
                  className="text-xs text-[#8A8A8A] hover:text-[#8b85ff] transition-colors font-medium"
                >
                  全タスク →
                </Link>
              </div>
            </div>

            <div className="px-4 py-1.5 bg-[#fffcf7] border-b border-[#eae8e3] text-[10px] text-[#8A8A8A] text-center flex flex-wrap items-center justify-center gap-1">
              <span>チャットは相談・下書き用です。</span>
              <Link to="/tasks" className="text-[#8b85ff] font-medium hover:underline">
                タスク管理
              </Link>
              <span>でメールや資料などの成果物パイプラインを回せます</span>
            </div>

            {/* Messages area - Claude style vertical stack */}
            <div className="flex-1 overflow-y-auto scrollbar-hide">
              <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
                {messages.length === 0 && !sending && (
                  <div className="flex flex-col items-center justify-center py-12 text-center px-2">
                    <div className="w-12 h-12 bg-[#8b85ff]/10 rounded-2xl flex items-center justify-center mb-3">
                      <Bot size={20} className="text-[#8b85ff]" />
                    </div>
                    <p className="text-sm text-[#8A8A8A] mb-1">
                      {selectedDept
                        ? `${DEPT_LABEL[selectedDept]}AIに質問してください`
                        : '何でも聞いてください'}
                    </p>
                    <p className="text-xs text-[#BCBCBC] mb-4">担当部署が自動で応答します</p>
                    <p className="text-[10px] text-[#8A8A8A] mb-2 w-full max-w-md">例（タップで入力欄に挿入）</p>
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
                          className="text-left text-xs px-3 py-2.5 rounded-xl bg-white border border-[#eae8e3] text-[#5C5C5C] hover:border-[#8b85ff]/35 transition-colors"
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
                          ? 'bg-[#f5f5f0]'
                          : 'bg-[#8b85ff]/10'
                      }`}>
                        {msg.role === 'user'
                          ? <UserIcon size={15} className="text-[#8A8A8A]" />
                          : <Bot size={15} className="text-[#8b85ff]" />
                        }
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-[#2D2D2D]">
                            {msg.role === 'user' ? 'あなた' : 'AI'}
                          </span>
                          {msg.role === 'assistant' && msg.department && (
                            <span
                              className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                              style={{
                                backgroundColor: `${DEPT_ACCENT[msg.department] ?? '#8A8A8A'}15`,
                                color: DEPT_ACCENT[msg.department] ?? '#8A8A8A',
                              }}
                            >
                              {DEPT_LABEL[msg.department] ?? msg.department}
                            </span>
                          )}
                        </div>
                        <div className={`text-sm leading-relaxed ${
                          msg.role === 'user' ? 'text-[#2D2D2D]' : 'text-[#2D2D2D]'
                        }`}>
                          <p className="whitespace-pre-wrap">{msg.role === 'assistant' ? stripJsonBlocks(msg.content) : msg.content}</p>
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
                  </div>
                ))}

                {/* Streaming message or typing indicator */}
                {sending && (
                  <motion.div
                    className="flex gap-3"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    <div className="w-8 h-8 bg-[#8b85ff]/10 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot size={15} className="text-[#8b85ff]" />
                    </div>
                    {streamingContent ? (
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-[#2D2D2D]">AI</span>
                          {streamingDepartment && (
                            <span
                              className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                              style={{
                                backgroundColor: `${DEPT_ACCENT[streamingDepartment] ?? '#8A8A8A'}15`,
                                color: DEPT_ACCENT[streamingDepartment] ?? '#8A8A8A',
                              }}
                            >
                              {DEPT_LABEL[streamingDepartment] ?? streamingDepartment}
                            </span>
                          )}
                        </div>
                        <div className="text-sm leading-relaxed text-[#2D2D2D]">
                          <p className="whitespace-pre-wrap">
                            {stripJsonBlocks(streamingContent ?? '')}
                            <span className="inline-block w-0.5 h-4 bg-[#8b85ff] ml-0.5 animate-pulse align-middle" />
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 pt-2">
                        <div className="w-2 h-2 bg-[#8b85ff] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-2 h-2 bg-[#8b85ff] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-2 h-2 bg-[#8b85ff] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
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
                {/* Agent suggestions */}
                <AgentSuggestions
                  agentId={selectedAgentId}
                  onSelect={handleSuggestionSelect}
                />

                {/* Input container */}
                <div className="bg-white rounded-3xl border border-[#eae8e3] shadow-sm px-4 py-3 focus-within:ring-2 focus-within:ring-[#8b85ff]/20 focus-within:border-[#8b85ff]/30 transition-all">
                  {/* Attached files chips */}
                  {attachedFiles.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {attachedFiles.map((f) => (
                        <span key={f.id} className="flex items-center gap-1 text-[10px] bg-[#f5f5f0] text-[#2D2D2D] px-2.5 py-1 rounded-full">
                          <FileIcon size={10} className="text-[#8A8A8A]" />
                          {f.name}
                          <button onClick={() => removeAttachedFile(f.id)} className="text-[#BCBCBC] hover:text-red-400 ml-0.5">
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
                    className="w-full bg-transparent border-0 text-sm text-[#2D2D2D] placeholder-[#BCBCBC] resize-none focus:outline-none"
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
                          className="text-[10px] px-2 py-0.5 rounded-full font-medium"
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
                        className="w-8 h-8 rounded-xl bg-[#f5f5f0] text-[#8A8A8A] hover:text-[#2D2D2D] flex items-center justify-center transition-all disabled:opacity-50"
                        whileTap={{ scale: 0.9 }}
                      >
                        {uploading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
                      </motion.button>
                      {/* Voice input button */}
                      <motion.button
                        onClick={toggleVoice}
                        className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
                          isListening
                            ? 'bg-red-500 text-white'
                            : 'bg-[#f5f5f0] text-[#8A8A8A] hover:text-[#2D2D2D]'
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
                        className="w-8 h-8 rounded-xl bg-[#8b85ff] hover:bg-[#7c76f2] disabled:opacity-30 text-white flex items-center justify-center transition-all"
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

                <p className="text-[10px] text-[#BCBCBC] mt-2 text-center">
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
    </div>
  );
}
