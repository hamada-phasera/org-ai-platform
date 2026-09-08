/**
 * タスクのバックエンド同期ユーティリティ
 * Dexie（ローカルキャッシュ）とバックエンドAPIの両方に書き込む
 */
import { api } from '../../services/api';
import type { Task } from '../types/index';

// 部署キー (TaskManagerのprojectId) → バックエンドdepartmentへのマッピング
const PROJECT_TO_DEPT: Record<string, string> = {
  SALES: 'SALES',
  MARKETING: 'MARKETING',
  ACCOUNTING: 'ACCOUNTING',
  GENERAL: 'GENERAL',
};

function toBackendDept(projectId?: string): string {
  if (!projectId) return 'GENERAL';
  return PROJECT_TO_DEPT[projectId] ?? 'GENERAL';
}

function toBackendStatus(status: Task['status']): string {
  const map: Record<Task['status'], string> = {
    pending: 'PENDING',
    ready: 'READY',
    in_progress: 'IN_PROGRESS',
    done: 'DONE',
    blocked: 'BLOCKED',
  };
  return map[status] ?? 'PENDING';
}

/** バックエンドにタスクを作成（失敗は無視してローカルのみ保持） */
export async function syncCreateTask(task: Task): Promise<void> {
  try {
    await api.post('/tasks', {
      title: task.title,
      department: toBackendDept(task.projectId),
      input: task.rawInput,
      status: toBackendStatus(task.status),
    });
  } catch {
    // バックエンド未起動・ネットワーク障害でもローカルは動作継続
  }
}

/** バックエンドのタスクステータスを更新（失敗は無視） */
export async function syncUpdateTaskStatus(localId: string, patch: Partial<Task>): Promise<void> {
  if (!patch.status && !patch.title) return;
  // ローカルIDとバックエンドIDは異なるため、タイトルで照合してIDを取得
  try {
    const res = await api.get<{ success: boolean; data: { id: string; title: string }[] }>('/tasks');
    const tasks = res.data.data;
    // rawInputや作成タイミングで厳密には一致しないため、
    // 直近タスクのID照合はスキップし、タイトルベースで最初にマッチしたものを更新
    const match = tasks.find((t) => t.title === patch.title);
    if (!match) return;

    const updateBody: Record<string, string> = {};
    if (patch.status) updateBody.status = toBackendStatus(patch.status);
    if (patch.title) updateBody.title = patch.title;
    await api.patch(`/tasks/${match.id}`, updateBody);
  } catch {
    // 無視
  }
}

/** バックエンドのタスクを削除（失敗は無視） */
export async function syncDeleteTask(title: string): Promise<void> {
  try {
    const res = await api.get<{ success: boolean; data: { id: string; title: string }[] }>('/tasks');
    const match = res.data.data.find((t) => t.title === title);
    if (match) await api.delete(`/tasks/${match.id}`);
  } catch {
    // 無視
  }
}
