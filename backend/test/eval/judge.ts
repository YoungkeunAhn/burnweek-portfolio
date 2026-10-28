/**
 * 판단 품질 심판(백로그 09 §5 2 · 기준표 10 §2 · G0 Q5).
 * - 두 안을 나란히 놓고 고르게 한다. **순서를 바꿔 두 번** 묻는다 — 두 번이 엇갈리면 그 심판은 무승부(위치 편향).
 * - 심판은 **서로 다른 계열 2개 이상**이고, **모두 같을 때만** 승패를 인정한다. 아니면 무승부.
 * 심판 호출은 주입한다(`Judge.ask`) — 오프라인 테스트는 가짜, 실측은 claude·codex·agy CLI.
 */
import { byId } from "../../src/data/exercises";

export type Verdict = "A" | "B" | "tie";

export interface Judge {
  /** 계열 이름(예: claude·codex·agy) — 같은 이름 둘은 「다른 계열」이 아니다. */
  name: string;
  ask(prompt: string): Promise<string>;
}

export interface JudgeVote {
  judge: string;
  /** A 를 먼저 보여 준 판정 · B 를 먼저 보여 준 판정(각각 A/B 로 환산). */
  forward: Verdict | null;
  reversed: Verdict | null;
  verdict: Verdict;
}

export interface PairResult {
  verdict: Verdict;
  votes: JudgeVote[];
}

interface PlanShape {
  week?: Array<{
    day_index?: number;
    focus?: string;
    exercises?: Array<{
      exercise_id?: string;
      name?: string;
      modality?: string;
      sets?: Array<{ set_kind?: string; target_reps_low?: number; target_reps_high?: number }>;
      cardio_detail?: { duration_min?: number };
    }>;
  }>;
}

/** 심판이 읽을 플랜 요약 — 요일별 운동 이름·장비·주근육·세트×렙. */
export function summarizePlan(plan: unknown): string {
  const lines: string[] = [];
  for (const day of (plan as PlanShape)?.week ?? []) {
    lines.push(`[day ${day.day_index ?? "?"}] ${day.focus ?? ""}`);
    for (const row of day.exercises ?? []) {
      const exercise = typeof row.exercise_id === "string" ? byId(row.exercise_id) : undefined;
      const name = exercise ? `${exercise.name_ko} (${exercise.name})` : (row.name ?? row.exercise_id ?? "?");
      if (row.modality === "cardio") {
        lines.push(`  - ${name} · cardio ${row.cardio_detail?.duration_min ?? "?"} min`);
        continue;
      }
      const working = (row.sets ?? []).filter((s) => s.set_kind === "working");
      const reps = working[0] ? `${working[0].target_reps_low}-${working[0].target_reps_high}` : "?";
      const meta = exercise ? ` · ${exercise.equipment} · ${exercise.primary_muscles.join("/")}` : "";
      lines.push(`  - ${name}${meta} · ${working.length}x${reps}`);
    }
  }
  return lines.join("\n");
}

export function judgePrompt(rubric: string, context: string, first: string, second: string): string {
  return [
    "You are a certified personal trainer judging two weekly workout plans for the same user.",
    "Judge only by the rubric. Do not run tools. Do not favour a plan for being shown first or for being longer.",
    "",
    "<rubric>",
    rubric,
    "</rubric>",
    "",
    "<user>",
    context,
    "</user>",
    "",
    "<plan_1>",
    first,
    "</plan_1>",
    "",
    "<plan_2>",
    second,
    "</plan_2>",
    "",
    'Answer with one JSON object only: {"winner":"plan_1"|"plan_2"|"tie","reason":"<one sentence>"}',
  ].join("\n");
}

/** 응답 속 마지막 `{"winner": …}` 를 읽는다. 못 읽으면 null(그 심판은 무승부 처리). */
export function parseWinner(text: string): "plan_1" | "plan_2" | "tie" | null {
  const matches = [...text.matchAll(/"winner"\s*:\s*"(plan_1|plan_2|tie)"/g)];
  const last = matches[matches.length - 1];
  return last ? (last[1] as "plan_1" | "plan_2" | "tie") : null;
}

export async function judgePair(
  a: unknown,
  b: unknown,
  rubric: string,
  judges: Judge[],
  context: string,
): Promise<PairResult> {
  if (new Set(judges.map((j) => j.name)).size < 2) throw new Error("서로 다른 계열 심판 2개 이상이 필요합니다(G0 Q5)");
  const sa = summarizePlan(a);
  const sb = summarizePlan(b);
  const votes: JudgeVote[] = [];
  for (const judge of judges) {
    const w1 = parseWinner(await judge.ask(judgePrompt(rubric, context, sa, sb)));
    const w2 = parseWinner(await judge.ask(judgePrompt(rubric, context, sb, sa)));
    const forward: Verdict | null = w1 === null ? null : w1 === "plan_1" ? "A" : w1 === "plan_2" ? "B" : "tie";
    const reversed: Verdict | null = w2 === null ? null : w2 === "plan_1" ? "B" : w2 === "plan_2" ? "A" : "tie";
    const verdict: Verdict = forward !== null && forward === reversed ? forward : "tie";
    votes.push({ judge: judge.name, forward, reversed, verdict });
  }
  const first = votes[0]!.verdict;
  return { verdict: votes.every((v) => v.verdict === first) ? first : "tie", votes };
}
