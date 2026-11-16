import type { Task, ProjectMemory, ExecutionResult, AgentRole, CodingResult, ResearchResult, DocumentResult, ScheduleResult } from '../types/index';
import { callClaudeJSON } from './client';
import {
  ORCHESTRATOR_SYSTEM,
  buildOrchestratorMessage,
  EMAIL_MANAGER_SYSTEM,
  buildEmailManagerMessage,
  EMAIL_EXECUTOR_SYSTEM,
  buildEmailExecutorMessage,
  ENGINEERING_MANAGER_SYSTEM,
  buildEngineeringManagerMessage,
  CODING_EXECUTOR_SYSTEM,
  buildCodingExecutorMessage,
  PLANNING_MANAGER_SYSTEM,
  buildPlanningManagerMessage,
  RESEARCH_EXECUTOR_SYSTEM,
  buildResearchExecutorMessage,
  DOCUMENT_EXECUTOR_SYSTEM,
  buildDocumentExecutorMessage,
  SCHEDULE_EXECUTOR_SYSTEM,
  buildScheduleExecutorMessage,
  RISK_MANAGER_SYSTEM,
  buildRiskManagerMessage,
} from './prompts';

type StepCallback = (role: AgentRole, status: 'pending' | 'running' | 'done' | 'error') => void;

export interface DecomposedTaskSpec {
  title: string;
  type: Task['type'];
  priority: Task['priority'];
  order: number;
  deadline?: string;
  rawInput: string;
  domainInstructions: string;
}

interface OrchestratorResultSimple {
  isComplex: false;
  taskType: Task['type'];
  priority: Task['priority'];
  deadline: string | null;
  projectName: string;
  contextSummary: string;
  domainInstructions: string;
  estimatedTime: string;
  subTasks: string[];
}

interface OrchestratorResultComplex {
  isComplex: true;
  projectName: string;
  contextSummary: string;
  decomposedTasks: DecomposedTaskSpec[];
}

type OrchestratorResult = OrchestratorResultSimple | OrchestratorResultComplex;

interface EmailSpec {
  to: string;
  cc?: string;
  subject: string;
  tone: string;
  keyPoints: string[];
  context: string;
}

interface EmailDraft {
  to: string;
  cc?: string;
  subject: string;
  body: string;
}

interface EngineeringSpec {
  language: string;
  framework?: string;
  files: Array<{ filename: string; purpose: string; keyFunctions: string[] }>;
  externalLibraries: string[];
  setupCommand: string;
  codeStyle: string;
}

interface PlanningSpec {
  planType: string;
  title: string;
  purpose: string;
  targetAudience: string;
  requiredSections: string[];
  keyPoints: string[];
  tone: string;
  additionalContext: string;
}

interface RiskResult {
  risks: string[];
}

// ─── リスク分析（共通） ────────────────────────────────────────────────────────

async function runRiskAssessment(
  task: Task,
  resultSummary: string,
  onStep: StepCallback
): Promise<string[]> {
  onStep('risk', 'running');
  try {
    const result = await callClaudeJSON<RiskResult>(
      RISK_MANAGER_SYSTEM,
      buildRiskManagerMessage(task.title, task.type, resultSummary)
    );
    onStep('risk', 'done');
    return result.risks ?? [];
  } catch {
    onStep('risk', 'error');
    return [];
  }
}

// ─── タスク分析（TaskInput で使用） ───────────────────────────────────────────

export async function analyzeTask(
  rawInput: string,
  memory?: ProjectMemory
): Promise<OrchestratorResult> {
  return callClaudeJSON<OrchestratorResult>(
    ORCHESTRATOR_SYSTEM,
    buildOrchestratorMessage(rawInput, memory)
  );
}

export function isComplexResult(result: OrchestratorResult): result is OrchestratorResultComplex {
  return result.isComplex === true;
}

// ─── メイン実行エンジン ────────────────────────────────────────────────────────

export async function executeTask(
  task: Task,
  memory: ProjectMemory | undefined,
  onStep: StepCallback
): Promise<ExecutionResult> {

  // ── Step 1: 部長AI（Orchestrator） ──────────────────────────────────────────
  onStep('orchestrator', 'running');
  let orchestratorResult: OrchestratorResult;
  try {
    orchestratorResult = await callClaudeJSON<OrchestratorResult>(
      ORCHESTRATOR_SYSTEM,
      buildOrchestratorMessage(task.rawInput, memory)
    );
    onStep('orchestrator', 'done');
  } catch (e) {
    onStep('orchestrator', 'error');
    throw e;
  }

  const type = (!orchestratorResult.isComplex && orchestratorResult.taskType) ? orchestratorResult.taskType : task.type;
  const domainInstructions = orchestratorResult.isComplex
    ? `タスク: ${task.title}`
    : orchestratorResult.domainInstructions;

  // ── Step 2-3: メール課長AI → メール社員AI ────────────────────────────────────
  if (type === 'email') {
    onStep('manager', 'running');
    let emailSpec: EmailSpec;
    try {
      emailSpec = await callClaudeJSON<EmailSpec>(
        EMAIL_MANAGER_SYSTEM,
        buildEmailManagerMessage(task, domainInstructions)
      );
      onStep('manager', 'done');
    } catch (e) {
      onStep('manager', 'error');
      throw e;
    }

    onStep('executor', 'running');
    let draft: EmailDraft;
    try {
      draft = await callClaudeJSON<EmailDraft>(
        EMAIL_EXECUTOR_SYSTEM,
        buildEmailExecutorMessage(emailSpec)
      );
      onStep('executor', 'done');
    } catch (e) {
      onStep('executor', 'error');
      throw e;
    }

    // メール型には risks フィールドが無いので、評価は進捗表示のために走らせるだけ（結果は返さない）
    await runRiskAssessment(
      task,
      `${draft.subject} 宛先:${draft.to}`,
      onStep
    );

    return {
      type: 'email',
      email: { to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Step 2-3: エンジニアリング課長AI → コーディング社員AI ───────────────────
  if (type === 'coding') {
    onStep('manager', 'running');
    let engSpec: EngineeringSpec;
    try {
      engSpec = await callClaudeJSON<EngineeringSpec>(
        ENGINEERING_MANAGER_SYSTEM,
        buildEngineeringManagerMessage(task, domainInstructions)
      );
      onStep('manager', 'done');
    } catch (e) {
      onStep('manager', 'error');
      throw e;
    }

    onStep('executor', 'running');
    let codingDraft: CodingResult;
    try {
      codingDraft = await callClaudeJSON<CodingResult>(
        CODING_EXECUTOR_SYSTEM,
        buildCodingExecutorMessage(engSpec)
      );
      onStep('executor', 'done');
    } catch (e) {
      onStep('executor', 'error');
      throw e;
    }

    const risks = await runRiskAssessment(
      task,
      `${codingDraft.description} ファイル: ${codingDraft.files.map((f) => f.filename).join(', ')}`,
      onStep
    );

    return {
      type: 'coding',
      coding: { ...codingDraft, risks },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Step 2: 企画課長AI（research/document/schedule 共通） ────────────────────
  onStep('manager', 'running');
  let planSpec: PlanningSpec;
  try {
    planSpec = await callClaudeJSON<PlanningSpec>(
      PLANNING_MANAGER_SYSTEM,
      buildPlanningManagerMessage(task, domainInstructions)
    );
    onStep('manager', 'done');
  } catch (e) {
    onStep('manager', 'error');
    throw e;
  }

  // ── Step 3: リサーチ社員AI ────────────────────────────────────────────────────
  if (type === 'research') {
    onStep('executor', 'running');
    let researchDraft: ResearchResult;
    try {
      researchDraft = await callClaudeJSON<ResearchResult>(
        RESEARCH_EXECUTOR_SYSTEM,
        buildResearchExecutorMessage(planSpec, task.rawInput)
      );
      onStep('executor', 'done');
    } catch (e) {
      onStep('executor', 'error');
      throw e;
    }

    const risks = await runRiskAssessment(
      task,
      `${researchDraft.title}: ${researchDraft.summary.slice(0, 100)}`,
      onStep
    );

    return {
      type: 'research',
      research: { ...researchDraft, risks },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Step 3: ドキュメント社員AI ────────────────────────────────────────────────
  if (type === 'document') {
    onStep('executor', 'running');
    let docDraft: DocumentResult;
    try {
      docDraft = await callClaudeJSON<DocumentResult>(
        DOCUMENT_EXECUTOR_SYSTEM,
        buildDocumentExecutorMessage(planSpec, task.rawInput)
      );
      onStep('executor', 'done');
    } catch (e) {
      onStep('executor', 'error');
      throw e;
    }

    const risks = await runRiskAssessment(
      task,
      `${docDraft.title}: ${docDraft.summary}`,
      onStep
    );

    return {
      type: 'document',
      document: { ...docDraft, risks },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Step 3: スケジュール社員AI ────────────────────────────────────────────────
  if (type === 'schedule') {
    onStep('executor', 'running');
    let scheduleDraft: ScheduleResult;
    try {
      scheduleDraft = await callClaudeJSON<ScheduleResult>(
        SCHEDULE_EXECUTOR_SYSTEM,
        buildScheduleExecutorMessage(planSpec, task.rawInput)
      );
      onStep('executor', 'done');
    } catch (e) {
      onStep('executor', 'error');
      throw e;
    }

    const risks = await runRiskAssessment(
      task,
      `${scheduleDraft.title} (${scheduleDraft.items.length}件のスケジュール)`,
      onStep
    );

    return {
      type: 'schedule',
      schedule: { ...scheduleDraft, risks },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── フォールバック（未対応タイプ）→ ドキュメント扱い ────────────────────────
  onStep('executor', 'running');
  const fallbackDraft = await callClaudeJSON<DocumentResult>(
    DOCUMENT_EXECUTOR_SYSTEM,
    buildDocumentExecutorMessage(planSpec, task.rawInput)
  );
  onStep('executor', 'done');

  const risks = await runRiskAssessment(
    task,
    `${fallbackDraft.title}: ${fallbackDraft.summary}`,
    onStep
  );

  return {
    type: 'document',
    document: { ...fallbackDraft, risks },
    generatedAt: new Date().toISOString(),
  };
}

// ─── 修正エンジン ──────────────────────────────────────────────────────────────

export async function refineResult(
  task: Task,
  currentResult: ExecutionResult,
  refinementRequest: string
): Promise<ExecutionResult> {
  if (currentResult.type === 'email' && currentResult.email) {
    const refined = await callClaudeJSON<EmailDraft>(
      EMAIL_EXECUTOR_SYSTEM,
      `現在のメールドラフト:
To: ${currentResult.email.to}
件名: ${currentResult.email.subject}
本文: ${currentResult.email.body}

修正依頼: ${refinementRequest}

修正後のメールをJSONで出力してください。`
    );
    return { ...currentResult, email: refined, generatedAt: new Date().toISOString() };
  }

  if (currentResult.type === 'document' && currentResult.document) {
    const refined = await callClaudeJSON<DocumentResult>(
      DOCUMENT_EXECUTOR_SYSTEM,
      `現在の文書:
タイトル: ${currentResult.document.title}
内容: ${currentResult.document.content.slice(0, 500)}...

修正依頼: ${refinementRequest}

修正後の文書をJSONで出力してください。`
    );
    return { ...currentResult, document: refined, generatedAt: new Date().toISOString() };
  }

  if (currentResult.type === 'research' && currentResult.research) {
    const refined = await callClaudeJSON<ResearchResult>(
      RESEARCH_EXECUTOR_SYSTEM,
      `現在のレポート:
タイトル: ${currentResult.research.title}
サマリー: ${currentResult.research.summary}

修正依頼: ${refinementRequest}

修正後のレポートをJSONで出力してください。`
    );
    return { ...currentResult, research: refined, generatedAt: new Date().toISOString() };
  }

  return currentResult;
}
