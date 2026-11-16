import { create } from 'zustand';
import type { Task, ProjectMemory, AgentStep, AgentRole, ExecutionResult } from '../types/index';
import {
  getAllTasks,
  addTask as dbAddTask,
  updateTask as dbUpdateTask,
  deleteTask as dbDeleteTask,
  getAllProjects,
  upsertProjectMemory,
} from '../db/index';
import { syncCreateTask, syncDeleteTask } from '../db/sync';

interface ExecutionState {
  activeTaskId: string | null;
  steps: AgentStep[];
  result: ExecutionResult | null;
  error: string | null;
}

export interface ExecutionQueue {
  taskIds: string[];
  currentIndex: number;
  isRunning: boolean;
}

interface AppStore {
  // Data
  tasks: Task[];
  projects: ProjectMemory[];
  executionState: ExecutionState;

  // UI state
  showTaskInput: boolean;
  sidebarPage: 'dashboard' | 'projects' | 'done';
  executionQueue: ExecutionQueue | null;

  // Actions: data
  loadAll: () => Promise<void>;
  addTask: (task: Task) => Promise<void>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  upsertProject: (memory: ProjectMemory) => Promise<void>;

  // Actions: execution
  startExecution: (taskId: string) => void;
  setStep: (role: AgentRole, status: AgentStep['status']) => void;
  setResult: (result: ExecutionResult) => void;
  setExecutionError: (msg: string) => void;
  clearExecution: () => void;

  // Actions: queue
  startQueue: (taskIds: string[]) => void;
  advanceQueue: () => void;
  clearQueue: () => void;

  // Actions: UI
  setShowTaskInput: (v: boolean) => void;
  setSidebarPage: (p: AppStore['sidebarPage']) => void;
}

const DEFAULT_STEPS: AgentStep[] = [
  { role: 'orchestrator', label: '部長AI：タスクを解析中...', status: 'pending' },
  { role: 'manager', label: '課長AI：実行計画を策定中...', status: 'pending' },
  { role: 'executor', label: '社員AI：成果物を生成中...', status: 'pending' },
  { role: 'risk', label: 'リスクマネジメント社員AI：リスクを分析中...', status: 'pending' },
];

export const useStore = create<AppStore>((set) => ({
  tasks: [],
  projects: [],
  executionState: {
    activeTaskId: null,
    steps: DEFAULT_STEPS,
    result: null,
    error: null,
  },
  showTaskInput: false,
  sidebarPage: 'dashboard',
  executionQueue: null,

  loadAll: async () => {
    const [tasks, projects] = await Promise.all([getAllTasks(), getAllProjects()]);
    set({ tasks, projects });
  },

  addTask: async (task) => {
    await dbAddTask(task);
    set((s) => ({ tasks: [task, ...s.tasks] }));
    syncCreateTask(task).catch(() => null); // バックエンドへ非同期同期
  },

  updateTask: async (id, patch) => {
    await dbUpdateTask(id, patch);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  },

  deleteTask: async (id) => {
    const title = useStore.getState().tasks.find((t) => t.id === id)?.title;
    await dbDeleteTask(id);
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    if (title) syncDeleteTask(title).catch(() => null);
  },

  upsertProject: async (memory) => {
    await upsertProjectMemory(memory);
    set((s) => {
      const exists = s.projects.find((p) => p.projectId === memory.projectId);
      return {
        projects: exists
          ? s.projects.map((p) => (p.projectId === memory.projectId ? memory : p))
          : [...s.projects, memory],
      };
    });
  },

  startExecution: (taskId) => {
    set({
      executionState: {
        activeTaskId: taskId,
        steps: DEFAULT_STEPS.map((s) => ({ ...s, status: 'pending' })),
        result: null,
        error: null,
      },
    });
  },

  setStep: (role, status) => {
    set((s) => ({
      executionState: {
        ...s.executionState,
        steps: s.executionState.steps.map((step) =>
          step.role === role ? { ...step, status } : step
        ),
      },
    }));
  },

  setResult: (result) => {
    set((s) => ({
      executionState: { ...s.executionState, result, error: null },
    }));
  },

  setExecutionError: (msg) => {
    set((s) => ({
      executionState: {
        ...s.executionState,
        error: msg,
        steps: s.executionState.steps.map((step) =>
          step.status === 'running' ? { ...step, status: 'error' } : step
        ),
      },
    }));
  },

  clearExecution: () => {
    set({
      executionState: {
        activeTaskId: null,
        steps: DEFAULT_STEPS.map((s) => ({ ...s, status: 'pending' })),
        result: null,
        error: null,
      },
    });
  },

  startQueue: (taskIds) => {
    set({ executionQueue: { taskIds, currentIndex: 0, isRunning: true } });
  },

  advanceQueue: () => {
    set((s) => {
      if (!s.executionQueue) return s;
      const nextIndex = s.executionQueue.currentIndex + 1;
      return {
        executionQueue: {
          ...s.executionQueue,
          currentIndex: nextIndex,
          isRunning: nextIndex < s.executionQueue.taskIds.length,
        },
      };
    });
  },

  clearQueue: () => {
    set({ executionQueue: null });
  },

  setShowTaskInput: (v) => set({ showTaskInput: v }),
  setSidebarPage: (p) => set({ sidebarPage: p }),
}));
