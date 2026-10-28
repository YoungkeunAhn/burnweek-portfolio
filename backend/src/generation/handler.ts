/**
 * Plan-generation orchestration (feature 001). Pure, runtime-agnostic: takes the
 * request + injected deps, returns a GenerateResponse. No Firebase/global reads
 * here (ADR-0008 portability) — the Firebase entrypoint (index.ts) adapts I/O.
 *
 * Flow (contract generation-api.md + architecture/03 §신뢰성):
 *   1. red-flag gate (BEFORE any LLM call). hard → blocked_red_flag, 0 LLM calls.
 *   2. LLM generateDraft → validate DraftPlan
 *   3. code expansion → WeeklyPlan v1 → schema + value rules (INV-1)
 *
 * S-GEN-8 allows ≤2 repair retries **per stage**, so the two stages keep separate
 * counters. Both failure kinds are fed back to the model as text — a value-rule
 * violation is still the draft's fault (too few sessions, wrong exercises), it
 * just surfaces later than a schema error.
 */
import type { AppConfig } from "../config";
import { createProvider, type LLMProvider } from "../llm";
import draftPlanSchema from "../schemas/draft-plan.schema.json";
import slotDraftSchema from "../schemas/slot-draft.schema.json";
import { chooseSplit } from "../data/splits";
import { checkDraftPlan, checkSlotDraft } from "../schemas/validate";
import { evaluateGate } from "./red-flags";
import { buildSlotSystemPrefix, buildSlotUserContext, buildSystemPrefix, buildUserContext, compactDraftSchema, stripNumbers } from "./prompt";
import { resolveSlotDraft } from "./slots";
import { assignTrainingDays, expandDraftToWeeklyPlan } from "./expand";
import { generatedPlanExerciseProblems } from "./exercise-policy";
import { prepareGeneration } from "./prepare";
import { MEDICAL_DISCLAIMER } from "./safety";
import type { GenerateRequest, GenerateResponse } from "./types";

// Validate against the full compatibility schema, but ask for the smaller
// projection whose removed fields never affect expansion. Build the stable
// prefix once per process so every request reuses exactly the same cache key.
const PROMPT_DRAFT_SCHEMA = compactDraftSchema(draftPlanSchema as Record<string, unknown>);
const SYSTEM_PREFIX = buildSystemPrefix(PROMPT_DRAFT_SCHEMA);
const SLOT_SCHEMA = slotDraftSchema as Record<string, unknown>;
const SLOT_SYSTEM_PREFIX = buildSlotSystemPrefix(SLOT_SCHEMA);

export interface HandlerDeps {
  config: AppConfig;
  /** Injectable for tests; defaults to the configured provider. */
  provider?: LLMProvider;
  /** 「오늘」(epoch ms) — 테스트 주입용. 기본은 서버 시각([D80]). */
  now?: number;
}

export async function generatePlan(
  asked: GenerateRequest,
  deps: HandlerDeps,
): Promise<GenerateResponse> {
  const { config } = deps;
  // 1) Safety gate — hard red flags block with ZERO LLM calls (FR-SAFE-3).
  const gate = evaluateGate(asked.profile);
  if (gate.blocked) {
    return {
      status: "blocked_red_flag",
      warnings: gate.warnings,
      message: `안전상 자동 생성을 차단했습니다: ${gate.hardHits.join(", ")}. 의료 전문가와 상담하세요.`,
    };
  }

  // 이번 주는 접수한 날부터([D80]). 저장 검사도 같은 준비 함수를 사용한다.
  // 설정 회수는 확장에서 원본 asked.profile의 값으로 보존한다.
  const { request: req, skeleton, allowedExerciseIds: generatedExerciseIds } =
    prepareGeneration(asked, config.pipeline, deps.now ?? Date.now());
  const provider = deps.provider ?? createProvider(config.llm);
  const userContext = skeleton ? buildSlotUserContext(req, skeleton) : buildUserContext(req, generatedExerciseIds);
  const weekNumber = normaliseWeekNumber(req.week_number);

  // 관측용 누적(009). 재시도를 포함한 이 요청 전체의 LLM 비용·지연이다.
  let llmCalls = 0;
  let totalTokens = 0;
  let llmLatencyMs = 0;
  let lastModel: string | undefined;

  let repairFeedback: string | undefined;
  let lastFailure = "";
  let schemaRetries = 0;
  let ruleRetries = 0;
  const budget = config.maxRepairRetries;

  // Bounded by the sum of both budgets: each stage may spend at most `budget`
  // retries, and the loop stops as soon as either one is exhausted.
  for (let attempt = 0; attempt <= budget * 2; attempt++) {
    // 2) Draft.
    let raw;
    const llmStartedAt = Date.now();
    try {
      raw = await provider.generateDraft({
        systemPrefix: skeleton ? SLOT_SYSTEM_PREFIX : SYSTEM_PREFIX,
        userContext,
        draftSchema: skeleton ? SLOT_SCHEMA : PROMPT_DRAFT_SCHEMA,
        repairFeedback,
      });
    } catch (err) {
      llmCalls += 1;
      llmLatencyMs += Date.now() - llmStartedAt;
      return {
        status: "error",
        warnings: gate.warnings,
        message: `LLM provider 오류: ${(err as Error).message}`,
        telemetry: { model: lastModel, llmCalls, totalTokens, llmLatencyMs },
      };
    }
    llmCalls += 1;
    llmLatencyMs += Date.now() - llmStartedAt;
    lastModel = raw.model ?? lastModel;
    totalTokens += raw.usage?.totalTokens ?? 0;

    const draftCheck = skeleton ? checkSlotDraft(raw.draft) : checkDraftPlan(raw.draft);
    if (!draftCheck.ok) {
      lastFailure = `DraftPlan 스키마: ${draftCheck.errors.join("; ")}`;
      if (schemaRetries >= budget) break;
      schemaRetries += 1;
      repairFeedback = draftCheck.errors.join("\n");
      continue;
    }
    if (process.env.DEBUG_DRAFT === "1") {
      console.log("[DEBUG_DRAFT] valid DraftPlan from", raw.model, "\n" + JSON.stringify(raw.draft, null, 2));
    }

    // P1: 슬롯 드래프트 → DraftPlan(후보 밖 id·중복은 다음 후보 · 이유의 숫자 제거). 이후는 P0 와 같은 길이다.
    if (skeleton) {
      const split = chooseSplit(req.profile.days_per_week, req.profile.split_pref);
      raw = { ...raw, draft: resolveSlotDraft(raw.draft, skeleton, split, stripNumbers).draft };
    }

    // 근력 요일은 코드가 정한다(D46). **여기서 한 번만** — 확장은 편집 재확장도 타므로 거기서 하면
    // 사용자가 옮긴 요일이 되돌아간다. 반환·저장되는 드래프트도 배치된 것이어야 한다(D56 ②).
    raw = { ...raw, draft: assignTrainingDays(raw.draft, req.profile) };

    // 3) Code-owned expansion + final value rules (INV-1).
    let expanded;
    try {
      expanded = expandDraftToWeeklyPlan({
        draft: raw.draft,
        profile: req.profile,
        userId: req.user_id,
        weekStartDate: req.week_start_date,
        weekNumber,
        priorLogs: req.prior_logs ?? [],
        completedThisWeek: req.completed_this_week ?? [], // D60 ② — 재생성이면 완료한 날 뒤로 분할 순서를 잇는다
        allowedGeneratedExerciseIds: generatedExerciseIds,
        planDaysPerWeek: asked.profile.days_per_week,
        disclaimer: MEDICAL_DISCLAIMER,
        source: "ai", // D54 ① — LLM 이 드래프트를 만든 주
        // D101 ④ — 맨몸 감량의 유산소 자리에 서킷(플래그). 서킷 화면이 있는 클라이언트만(N10d).
        circuits: config.circuits && req.supports_circuits === true,
      });
    } catch (err) {
      // A throw here is an engine bug, not a bad draft — retrying would just
      // burn LLM calls on the same crash.
      return {
        status: "error",
        warnings: gate.warnings,
        message: `플랜 확장 오류: ${(err as Error).message}`,
        telemetry: { model: lastModel, llmCalls, totalTokens, llmLatencyMs },
      };
    }

    const finalProblems = [
      ...expanded.problems,
      ...generatedPlanExerciseProblems(expanded.plan, req.profile, generatedExerciseIds),
    ];
    if (finalProblems.length > 0) {
      lastFailure = `최종 검증: ${finalProblems.join("; ")}`;
      if (ruleRetries >= budget) break;
      ruleRetries += 1;
      repairFeedback = [
        "이전 응답으로 만든 주간 플랜이 검증을 통과하지 못했습니다. 아래를 고쳐 다시 구성하세요:",
        ...finalProblems,
      ].join("\n");
      continue;
    }

    return {
      status: "ok",
      plan: expanded.plan,
      // 편집 경로가 재확장의 입력으로 쓴다(백로그 016). 플랜과 함께 저장된다.
      // 확장이 쓴 드래프트(맨몸 사다리 반영)여야 플랜의 운동을 편집에서 찾는다.
      draft: expanded.draft,
      warnings: [...gate.warnings, ...expanded.warnings],
      telemetry: { model: lastModel, llmCalls, totalTokens, llmLatencyMs },
    };
  }

  return {
    status: "error",
    warnings: gate.warnings,
    message: `생성 검증이 재시도(단계별 최대 ${budget}회) 후에도 실패했습니다 — ${lastFailure}`,
    telemetry: { model: lastModel, llmCalls, totalTokens, llmLatencyMs },
  };
}

/** Week numbers are 1-based; anything else is treated as week 1. */
function normaliseWeekNumber(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}
