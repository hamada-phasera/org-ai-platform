import { create } from 'zustand';
import type { ChatSession, Message } from '@org-ai/shared-types';

interface ChatState {
  sessions: ChatSession[];
  currentSessionId: string | null;
  messages: Message[];
  pendingDepartment: string | null;
  selectedAgentId: string | null;
  streamingContent: string | null;
  streamingDepartment: string | null;
  autoCreateSession: boolean;
  /**
   * チャットで修正中のエージェント。
   * ⚠️ location.state には置けない。/chat でセッションを作ると /chat/:id へ遷移し、
   *    その時点で state が落ちて編集コンテキストが消える（＝修正フローが成立しない）。
   */
  editingAgent: { id: string; name: string } | null;
  setSessions: (sessions: ChatSession[]) => void;
  setCurrentSession: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  setPendingDepartment: (dept: string | null) => void;
  setSelectedAgent: (agentId: string | null) => void;
  setStreamingContent: (content: string | null) => void;
  appendStreamingContent: (token: string) => void;
  setStreamingDepartment: (dept: string | null) => void;
  setAutoCreateSession: (val: boolean) => void;
  setEditingAgent: (agent: { id: string; name: string } | null) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  pendingDepartment: null,
  selectedAgentId: null,
  streamingContent: null,
  streamingDepartment: null,
  autoCreateSession: false,
  editingAgent: null,
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (id) => set({ currentSessionId: id, messages: [] }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  setPendingDepartment: (dept) => set({ pendingDepartment: dept }),
  setSelectedAgent: (agentId) => set({ selectedAgentId: agentId }),
  setStreamingContent: (content) => set({ streamingContent: content }),
  appendStreamingContent: (token) => set((state) => ({
    streamingContent: (state.streamingContent ?? '') + token,
  })),
  setStreamingDepartment: (dept) => set({ streamingDepartment: dept }),
  setAutoCreateSession: (val) => set({ autoCreateSession: val }),
  setEditingAgent: (agent) => set({ editingAgent: agent }),
}));
