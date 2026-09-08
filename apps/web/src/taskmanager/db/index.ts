// dexie 3.x に EntityTable は無い（v4 の型）。3.x では Table<T, キー型> を使う
import Dexie, { type Table } from 'dexie';
import type { Task, ProjectMemory } from '../types/index';

class AppDatabase extends Dexie {
  tasks!: Table<Task, string>;
  projectMemories!: Table<ProjectMemory, string>;

  constructor() {
    super('ai-executive-db');
    this.version(1).stores({
      tasks: 'id, status, type, priority, projectId, createdAt',
      projectMemories: 'projectId, projectName, lastUpdated',
    });
  }
}

export const db = new AppDatabase();

// --- Task CRUD ---

export async function getAllTasks(): Promise<Task[]> {
  return db.tasks.orderBy('createdAt').reverse().toArray();
}

export async function addTask(task: Task): Promise<void> {
  await db.tasks.add(task);
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  await db.tasks.update(id, patch);
}

export async function deleteTask(id: string): Promise<void> {
  await db.tasks.delete(id);
}

// --- ProjectMemory CRUD ---

export async function getAllProjects(): Promise<ProjectMemory[]> {
  return db.projectMemories.toArray();
}

export async function upsertProjectMemory(memory: ProjectMemory): Promise<void> {
  await db.projectMemories.put(memory);
}

export async function getProjectMemory(projectId: string): Promise<ProjectMemory | undefined> {
  return db.projectMemories.get(projectId);
}
