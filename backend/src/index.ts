/**
 * Firebase Cloud Functions Gen2 entrypoints (ADR-0008 + ADR-0011: async).
 * Generation is asynchronous:
 *
 *   plansGenerate (onRequest)  — intake. Hard red-flag gate runs SYNCHRONOUSLY
 *                                (0 LLM calls). Blocked → 200 blocked_red_flag.
 *                                Else → create GenerationJob (Firestore, TTL) +
 *                                enqueue Cloud Task → 202 { job_id, queued }.
 *   plansWorker (onTaskDispatched, 540s) — runs the pipeline (draft→expand→
 *                                validate), writes ok(plan)|error to the job,
 *                                and sends the completion FCM push.
 *   plansGet (onRequest)       — GET /v1/plans/{job_id}: status/plan fetch +
 *                                push-miss fallback. `{job_id}=current` 는 잡이
 *                                아니라 저장된 최신 플랜을 준다(D19).
 *
 * Secret LLM_API_KEY (Secret Manager) is bound to the WORKER only — intake needs
 * no LLM key (gate is code-only). `.value()` is read inside the worker handler.
 */
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldPath, FieldValue, getFirestore, type Transaction } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { getMessaging } from "firebase-admin/messaging";
import { randomUUID } from "node:crypto";
import { buildConfig } from "./config";
import { countGeneration, RATE_LIMITS } from "./rate-limit";
import { AccessError, accessRef, generationAccess, startReward, claimReward, reserveGeneration, settleGeneration } from "./generation/access";
import { generatePlan } from "./generation/handler";
import { completedThisWeek, recentExerciseIds } from "./generation/prompt";
import { generatedPlanExerciseProblems } from "./generation/exercise-policy";
import { prepareGeneration } from "./generation/prepare";
import { evaluateGate } from "./generation/red-flags";
import { validateProfile } from "./generation/validate-profile";
import { candidatesFor, editSavedWeek, type SavedWeek } from "./generation/edit";
import {
  EXERCISE_HISTORY_DEFAULT_WEEKS,
  EXERCISE_HISTORY_MAX_WEEKS,
  clampWeeks,
  exerciseHistory,
  growthTrend,
  isCalendarDate,
  previousWeekOf,
} from "./generation/history";
import { preserveCompletedDays, saveSessionOn } from "./generation/session";
import { recentPriorLogs } from "./generation/prior-history";
import { parseProgressDraft, readProgressDraft, retireProgressDrafts, reconcileProgressDrafts, swapDayRecords, type StoredProgressDraft } from "./generation/progress-draft";
import { basicAuthOk, loginWithToss, mintSession, verifySessionClaims, withdrawUid, sendPlanReadyPush, sendTossPush, userKeyOf, WORKOUT_DAY_TEMPLATE } from "./auth/toss";
import { mondayOf, seoulToday, workoutDayFocus } from "./generation/workout-day";
import { AccountReset, LoginInterrupted, accountRef, assertAccount, invalidatePendingLogins, loginAccount, readLoginRevision, type Account } from "./auth/account";
import type { GenerateRequest, GenerateResponse, GenerationJob } from "./generation/types";

initializeApp();

const LLM_API_KEY = defineSecret("LLM_API_KEY");
// 토스 파트너 API 클라이언트 인증서와 세션 서명키. 없으면 토스 로그인만 비활성이고
// 나머지 경로(Flutter 앱의 Firebase 토큰)는 그대로 돈다.
const SESSION_SECRET = defineSecret("SESSION_SECRET");
const TOSS_CLIENT_CERT = defineSecret("TOSS_CLIENT_CERT");
const TOSS_CLIENT_KEY = defineSecret("TOSS_CLIENT_KEY");
const TOSS_SECRETS = [SESSION_SECRET, TOSS_CLIENT_CERT, TOSS_CLIENT_KEY];
/** 탈퇴 콜백 Basic 인증. 콘솔에 넣은 것과 **같은 `id:pw` 원문**을 담는다. */
const TOSS_WITHDRAW_BASIC = defineSecret("TOSS_WITHDRAW_BASIC");
const REGION = "asia-northeast3"; // Seoul
const JOBS = "generation_jobs";
/** 운동일 아침 알림 동의(계약 §2.8 · D90). `{ workout_day: boolean, updated_at }` — 탈퇴·초기화가 지운다. */
const PUSH_SUBS = "push_subscriptions";
const JOB_TTL_HOURS = 24; // ADR-0011: ephemeral, TTL policy on `expires_at`
/**
 * 미니앱 플랜 정본(D19). 잡(TTL 24h)은 **잡 기록**이라 여기에 플랜을 눌러 담으면
 * ADR-0011 의 ephemeral 설계를 거스른다 — 별도 컬렉션을 둔다. TTL 없음.
 *
 *   weekly_plans/{uid}/weeks/{week_start_date}
 *
 * **주차별 1건**이라 지난 주 플랜이 남는다(내보내기·진행 비교가 원본을 요구한다).
 * 하위 컬렉션인 이유: 문서 id 를 `${uid}_${week}` 로 붙이면 uid 접두사가 겹치는
 * 다른 사용자와 범위 질의가 섞일 수 있다. 경로로 가르면 그 걱정 자체가 없고
 * 소유권이 구조로 보장된다.
 */
const PLANS = "weekly_plans";
const WEEKS = "weeks";
/** `YYYY-MM-DD`. 문서 id 가 되므로 모양을 반드시 확인한다(경로 조작·빈 값). */
const WEEK_START_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
/** What we declare to the platform; the self-deadline is derived from it. */
const DECLARED_WORKER_TIMEOUT_SEC = 540; // ADR-0016
/**
 * Throughput ceilings (D8 비용 통제). Expected load is ~400 generations a MONTH,
 * so these are ~100x headroom for us and a hard bound on anyone hammering the
 * endpoints: a runaway caller can waste at most this many concurrent instances
 * (and, for the worker, this many concurrent LLM calls).
 */
const MAX_INSTANCES = { intake: 10, worker: 5, fetch: 10 } as const;
// 첫 접속의 로그인 → 플랜 조회 콜드스타트 완화안. 비용 승인 전에는 0을 유지하고,
// 승인 후 두 경로만 1로 올린다. 유휴 비용과 되돌리기는 deploy-runbook §2.1.
const READ_MIN_INSTANCES = 0;
/**
 * 미니앱은 토스가 발급한 호스트에서 실행되므로 우리 API 호출이 **교차 출처**다.
 * 서버 API 문서 §CORS 허용하기. appName 은 등록 후 바꿀 수 없으므로(`burnweek`) 와일드카드 대신 정확히 나열한다.
 * **2026-08-25 이후 업로드한 SDK 3.x 번들은 `apps` 계열 Origin 으로 서비스된다**(같은 문서) — 빠뜨리면
 * 로그인 응답을 못 읽어 기기에 `Failed to fetch` 가 뜬다(2026-09-15 테스트 번들 20260914-22). `web` 계열은 그 전 번들용으로 남긴다.
 *   - apps.tossmini.com / web.tossmini.com                 : 실서비스
 *   - private-apps.tossmini.com / private-web.tossmini.com : 콘솔 QR 테스트
 */
const TOSS_APP_NAME = "burnweek";
const CORS_ORIGINS = [
  `https://${TOSS_APP_NAME}.apps.tossmini.com`,
  `https://${TOSS_APP_NAME}.private-apps.tossmini.com`,
  `https://${TOSS_APP_NAME}.web.tossmini.com`,
  `https://${TOSS_APP_NAME}.private-web.tossmini.com`,
];
/** Headroom to write the job + send the push before the platform kills us. */
const DEADLINE_MARGIN_SEC = 15;
/** Never cut the deadline shorter than this, however small the config says. */
const DEADLINE_FLOOR_SEC = 5;

/**
 * When to give up, in ms. Clamped to the declared timeout: a `WORKER_TIMEOUT_SEC`
 * larger than what we deploy would push the deadline past the platform's own kill
 * and the guard would never fire — the exact failure it exists to prevent.
 */
export function workerDeadlineMs(configuredSec: number): number {
  const effective = Math.min(configuredSec, DECLARED_WORKER_TIMEOUT_SEC);
  return Math.max(DEADLINE_FLOOR_SEC, effective - DEADLINE_MARGIN_SEC) * 1000;
}

const DEADLINE = Symbol("deadline");

/** Resolves to `DEADLINE` if `work` has not settled in time. `work` is left running. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function db() {
  return getFirestore();
}

/** 그 사용자의 주차 플랜 하위 컬렉션(`weekly_plans/{uid}/weeks`). */
function weeksOf(uid: string) {
  return db().collection(PLANS).doc(uid).collection(WEEKS);
}

/**
 * 최신 n 주차 문서(최신이 앞). **오름차순으로 읽고 뒤에서 자른다** — `orderBy(__name__, "desc")` 는
 * 프로덕션 Firestore 가 복합 색인을 요구해 `FAILED_PRECONDITION` 으로 죽었다(2026-09-08 로그 · 실기기 「변경」 후보 없음).
 * 오름차순 `__name__` 은 기본 색인이라 색인 없이 돈다. 사용자당 주차는 수십 건이라 다 읽어도 싸다.
 * ponytail: 주차가 수백 건이 되면 `where(__name__, ">=", cutoff)` 로 좁힌다.
 */
async function latestWeeks(uid: string, n?: number, through?: string) {
  const snap = await weeksOf(uid).orderBy(FieldPath.documentId()).get();
  const docs = snap.docs.filter((doc) => through === undefined || doc.id <= through);
  return (n === undefined ? docs : docs.slice(-n)).reverse();
}

/**
 * 주차 플랜 문서 하나. `current` 는 **가장 최신 주차**다 — 문서 id 가 `YYYY-MM-DD`
 * 라 id 역순 1건이면 끝난다(`__name__` 은 항상 색인돼 복합 색인이 필요 없다).
 * 조회·편집·후보 세 경로가 같은 규칙을 쓰도록 여기 한 곳에 둔다.
 */
async function loadWeek(uid: string, key: string) {
  if (key === "current") {
    const latest = await latestWeeks(uid, 1);
    return latest[0] ?? null;
  }
  const doc = await weeksOf(uid).doc(key).get();
  return doc.exists ? doc : null;
}


/**
 * Who is calling (001 T5.5). The Flutter app signs in with Google and sends the
 * resulting Firebase ID token (D15 — anonymous auth is explicitly not used); the
 * miniapp sends a server-signed Toss session (`auth/toss.ts`). Either way the
 * identity comes from a verified token and never from the body. Two things
 * depend on it:
 *
 *  - **Cost.** An open `plansGenerate` lets anyone spend our LLM budget — that is
 *    a bigger bill than anything Firebase charges (research/07).
 *  - **Privacy.** A job holds a generated plan; without an owner check, knowing a
 *    `job_id` would be enough to read someone else's plan.
 *
 * Google sign-in cannot serve here: `drive.file` consent is requested at the
 * first SAVE (003), long after the first plan is generated.
 */
async function callerAccount(request: { headers: Record<string, unknown> }): Promise<Account | null> {
  const header = String(request.headers.authorization ?? "");
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  const token = match[1]!;

  // 1) 토스 세션(미니앱). 서명을 확인한 뒤 authorize가 연결 버전을 조회한다.
  const secret = SESSION_SECRET.value() || process.env.SESSION_SECRET;
  if (secret) {
    const account = verifySessionClaims(token, secret, Date.now());
    if (account) return account;
  }

  // 2) Firebase ID 토큰(Flutter 앱 — D16 동결이지만 폐기가 아니다).
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return { uid: decoded.uid, version: decoded.uid.startsWith("toss:") ? "0" : null };
  } catch {
    return null; // expired, forged, or from another project
  }
}

function resetResponse(response: Response) {
  response.status(401).json({ status: "error", code: "ACCOUNT_RESET", message: "연결이 해제되었어요. 다시 시작해 주세요." });
}

async function authorize(request: Request, response: Response): Promise<Account | null> {
  const account = await callerAccount(request);
  if (!account) {
    response.status(401).json({ status: "error", message: "Unauthenticated: verified token required." });
    return null;
  }
  // 이전 형식 세션에는 계정 버전이 없다. 재로그인으로 교체하되 로컬 삭제로 오인하지 않는다.
  if (account.version === "0") {
    response.status(401).json({ status: "error", code: "SESSION_REFRESH", message: "다시 로그인해 주세요." });
    return null;
  }
  try { await assertAccount(db(), account); return account; }
  catch (err) { if (!(err instanceof AccountReset)) throw err; resetResponse(response); return null; }
}

async function accountResponse(account: Account, response: Response, code: number, body: unknown) {
  try { await assertAccount(db(), account); }
  catch (err) { if (!(err instanceof AccountReset)) throw err; resetResponse(response); return; }
  response.status(code).json(body);
}

async function accountWrite(account: Account, response: Response, write: (tx: Transaction) => unknown | Promise<unknown>): Promise<boolean> {
  try {
    await db().runTransaction(async (tx) => { await assertAccount(db(), account, tx); await write(tx); });
    return true;
  } catch (err) { if (!(err instanceof AccountReset)) throw err; resetResponse(response); return false; }
}

/**
 * Parse + validate the intake body (numbers are code-owned — no hints).
 * 프로필은 사용자 입력이라 enum·범위를 여기서 검증한다 — 클라이언트 검증은
 * 우회된다(`validate-profile.ts`). 실패 이유를 돌려줘 400 메시지에 싣는다.
 */
function parseRequest(body: unknown, userId: string): GenerateRequest | { error: string } {
  const b = body as Partial<GenerateRequest> | undefined;
  if (!b || typeof b !== "object") return { error: "요청 본문이 올바르지 않습니다." };
  const checked = validateProfile(b.profile);
  if ("error" in checked) return checked;
  // 문서 id 로 쓰이므로 여기서 막는다 — 빈 값·`a/b` 같은 값은 저장 경로를 망친다.
  if (typeof b.week_start_date !== "string" || !WEEK_START_RE.test(b.week_start_date)) {
    return { error: "week_start_date 는 YYYY-MM-DD 형식이어야 합니다." };
  }
  return {
    // Authenticated identity wins: a body-supplied `user_id` would let a caller
    // write plans under someone else's id.
    user_id: userId,
    week_start_date: b.week_start_date,
    // 토큰이 없으면 필드를 아예 넣지 않는다 — Firestore 는 undefined 를 거부한다.
    ...(typeof b.fcm_token === "string" && b.fcm_token ? { fcm_token: b.fcm_token } : {}),
    ...(b.toss_push === true ? { toss_push: true } : {}),
    ...(b.supports_circuits === true ? { supports_circuits: true } : {}),
    profile: checked.profile,
    // **본문 값을 읽지 않는다**(계약 §1 · D22-6). 접수 뒤 직전 주 문서의 `sessions`
    // 에서 서버가 채운다 — 클라이언트가 낡아도 피드백 루프가 돌고, 저장된 것과 보낸
    // 것이 어긋나는 상태가 존재할 수 없다. `recent_exercise_ids` 와 같은 자리다.
    prior_logs: [],
    ...(typeof b.week_number === "number" ? { week_number: b.week_number } : {}),
  };
}

// ── 1) Intake ────────────────────────────────────────────────────────────────
// ── 0) 토스 로그인 — 코드 교환 후 세션 발급 ────────────────────────────────
// 미니앱이 `appLogin()` 으로 받은 1회용 코드를 여기로 보내면, 서버가 mTLS 로
// 토스에 교환해 `userKey` 를 받아 **서명된 세션**을 돌려준다. 이후 요청은 그
// 세션을 Bearer 로 쓴다. 익명 키를 그대로 믿던 구멍이 여기서 닫힌다.
export const authToss = onRequest(
  { region: REGION, memory: "256MiB", minInstances: READ_MIN_INSTANCES, cors: CORS_ORIGINS, maxInstances: MAX_INSTANCES.intake, secrets: TOSS_SECRETS },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).json({ status: "error", message: "POST only" });
      return;
    }
    const body = request.body as { authorizationCode?: unknown; referrer?: unknown } | undefined;
    const code = typeof body?.authorizationCode === "string" ? body.authorizationCode : "";
    const referrer = typeof body?.referrer === "string" ? body.referrer : "";
    if (!code || !referrer) {
      response.status(400).json({ status: "error", message: "authorizationCode 와 referrer 가 필요합니다." });
      return;
    }

    const toss = {
      clientCert: TOSS_CLIENT_CERT.value() || process.env.TOSS_CLIENT_CERT || undefined,
      clientKey: TOSS_CLIENT_KEY.value() || process.env.TOSS_CLIENT_KEY || undefined,
      sessionSecret: SESSION_SECRET.value() || process.env.SESSION_SECRET || undefined,
    };
    if (!toss.sessionSecret || !toss.clientCert || !toss.clientKey) {
      // 설정이 없으면 조용히 실패하지 않는다 — 배포 누락은 시끄럽게 드러나야 한다.
      logger.error("authToss: 토스 인증서/서명키 미설정");
      response.status(503).json({ status: "error", message: "토스 로그인이 아직 설정되지 않았습니다." });
      return;
    }

    let exchangingCode = false;
    try {
      const startedAt = Date.now();
      const loginRevision = await readLoginRevision(db());
      exchangingCode = true;
      const { uid, expiresInSec } = await loginWithToss(toss, code, referrer, startedAt);
      exchangingCode = false;
      const account = await loginAccount(db(), uid, loginRevision);
      const sessionToken = mintSession(uid, toss.sessionSecret, Date.now(), account.version);
      response.status(200).json({ status: "ok", session_token: sessionToken, expires_in: expiresInSec,
        local_data_key: account.localDataKey });
    } catch (err) {
      if (err instanceof LoginInterrupted) {
        response.status(401).json({ status: "error", code: "SESSION_REFRESH", message: "토스 로그인을 다시 시도해 주세요." });
        return;
      }
      if (!exchangingCode) {
        logger.error("authToss: 계정 저장소 조회 실패", { error: (err as Error).message });
        response.status(503).json({ status: "error", message: "잠시 후 다시 로그인해 주세요." });
        return;
      }
      // 코드 만료(10분)·재사용·인증서 문제 전부 여기로 온다. 사유는 로그에만 남긴다.
      logger.warn("authToss: 코드 교환 실패", { error: (err as Error).message });
      response.status(401).json({ status: "error", message: "토스 로그인에 실패했습니다. 다시 시도해 주세요." });
    }
  },
);

// ── 0.5) 탈퇴 콜백 — 받은 userKey 의 데이터를 지운다 ────────────────────────
/**
 * 토스 탈퇴 이벤트를 받는 자리다(콘솔: 유저정보 불러오기 → 콜백 설정하기).
 *
 * **받은 `userKey` 의 데이터를 전부 지운다**(계약 §2.5.1 · NFR-PRIV-2). 본문 규격은
 * 플랫폼이 공개하지 않아 콘솔 `테스트하기` 로 캡처했다(2026-08-24):
 * `{"userKey": 0, "referrer": "UNLINK"}`. 판정은 `withdrawUid` 가 갖는다.
 *
 * **본문은 로그에 남기지 않는다** — 규격이 잡힌 지금부터 그것은 실제 사용자
 * 식별자다(NFR-PRIV-2). 남기는 것은 지운 주차 수뿐이다.
 *
 * 모르는 모양이면 **아무것도 지우지 않고 200** 이다. 삭제는 되돌릴 수 없고,
 * 4xx 를 뱉어 봐야 플랫폼 재시도 규격이 공개돼 있지 않아 얻는 게 없다.
 *
 * **CORS 는 전면 허용이다**(`cors: true`). 실제 탈퇴 이벤트는 토스 서버가 부르니
 * CORS 와 무관하지만, 콘솔 `테스트하기` 는 **콘솔 페이지의 브라우저가 직접** 부른다 —
 * 닫아 두면 preflight 에서 막혀 `Failed to fetch` 가 되고 규격 캡처를 못 한다.
 * 오리진을 좁히지 않는 이유: 문지기는 Basic 인증이지 오리진이 아니고, 콘솔 오리진이
 * 바뀌면 조용히 다시 막힌다. 오리진을 알아도 자격증명 없이는 아무것도 못 한다.
 */
export const tossWithdraw = onRequest(
  { region: REGION, cors: true, maxInstances: MAX_INSTANCES.intake, secrets: [TOSS_WITHDRAW_BASIC] },
  async (request, response) => {
    const expected = TOSS_WITHDRAW_BASIC.value() || process.env.TOSS_WITHDRAW_BASIC || "";
    if (!expected) {
      // 설정 누락은 조용히 넘기지 않는다 — authToss 와 같은 이유.
      logger.error("tossWithdraw: TOSS_WITHDRAW_BASIC 미설정");
      response.status(503).json({ status: "error", message: "탈퇴 콜백이 아직 설정되지 않았습니다." });
      return;
    }
    if (!basicAuthOk(String(request.headers.authorization ?? ""), expected)) {
      logger.warn("tossWithdraw: 인증 실패");
      response.status(401).json({ status: "error", message: "Unauthorized" });
      return;
    }

    const uid = withdrawUid(request.body);
    if (!uid) {
      // 값은 남기지 않는다 — 모르는 모양이라도 식별자가 들어 있을 수 있다.
      logger.warn("tossWithdraw: 모르는 본문 — 아무것도 지우지 않는다");
      response.status(200).json({ status: "ok" });
      return;
    }
    const removed = await deleteUserData(uid);
    logger.info("tossWithdraw: 탈퇴 처리", { weeks: removed });
    response.status(200).json({ status: "ok" });
  },
);

export const plansGenerate = onRequest(
  { region: REGION, timeoutSeconds: 30, memory: "256MiB", cors: CORS_ORIGINS, maxInstances: MAX_INSTANCES.intake, secrets: [SESSION_SECRET] },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).json({ status: "error", message: "Method Not Allowed" });
      return;
    }

    const account = await authorize(request, response);
    if (!account) return;
    const { uid } = account;

    const parsed = parseRequest(request.body, uid);
    if ("error" in parsed) {
      response.status(400).json({ status: "error", message: parsed.error });
      return;
    }
    const req = parsed;

    // Synchronous hard red-flag gate — non-bypassable, ZERO LLM calls (FR-SAFE-3).
    // No job is created; nothing is enqueued (ADR-0011).
    const gate = evaluateGate(req.profile);
    if (gate.blocked) {
      response.status(200).json({
        status: "blocked_red_flag",
        message: `안전상 자동 생성을 차단했습니다: ${gate.hardHits.join(", ")}. 의료 전문가와 상담하세요.`,
      });
      return;
    }

    // 연속성(직전 주 플랜 프록시). 게이트 뒤·한도 앞이다: 차단된 요청에 읽기
    // 비용을 쓰지 않고, 한도 초과로 어차피 버릴 요청에도 쓰지 않는다.
    //
    // 실패해도 생성은 계속한다 — 연속성은 품질 개선이지 정확성 요건이 아니다.
    // 같은 주를 다시 만드는 경우(재생성) 주차 번호는 올리지 않는다.
    try {
      // Filter by calendar dates, not document count (missing/non-Monday weeks are possible).
      const recentWeeks = await latestWeeks(uid, undefined, req.week_start_date);
      const prev = recentWeeks[0] ?? null;
      const prevPlan = prev?.get("plan");
      if (prev && prevPlan) {
        // 종목 연속성은 최신 문서에서 가져온다 — 재생성이면 이번 주 자신이고,
        // 그게 맞다(같은 주를 다시 짜면서 코어 종목은 이어 간다).
        const ids = recentExerciseIds(prevPlan);
        if (ids.length > 0) req.recent_exercise_ids = ids;
        const prevWeek = (prevPlan as { plan_meta?: { week_number?: unknown } }).plan_meta?.week_number;
        if (req.week_number === undefined && typeof prevWeek === "number") {
          req.week_number = prev.id === req.week_start_date ? prevWeek : prevWeek + 1;
        }
      }
      // 실측 기록(§2.4)은 **이번 주보다 앞선 주**에서만 읽는다. `decideProgression`
      // 의 유일한 입력이라 이 줄이 없으면 증량·감량이 영원히 안 돈다(미니앱이 매주
      // 1주차 플랜을 받던 이유다) — 그렇다고 이번 주 기록을 먹이면 재생성할 때마다
      // 오늘 든 무게를 근거로 오늘의 처방이 올라가는 되먹임이 생긴다.
      req.prior_logs = recentPriorLogs(recentWeeks.map((d) => ({ week_start_date: d.id, sessions: d.get("sessions") })), req.week_start_date);
      // 이번 주 완료 세션(D60 ②) — **같은 주 문서만**(D60 Q6 · 직전 주는 안 본다). 요일·근력 종목 id 뿐이라
      // 위 되먹임과 무관하다(수치 0 · INV-1). 본문 값은 `parseRequest` 가 이미 버렸다.
      const thisWeek = recentWeeks.find((d) => d.id === req.week_start_date) ?? null;
      req.completed_this_week = thisWeek ? completedThisWeek(thisWeek.get("sessions")) : [];
    } catch (err) {
      logger.warn("plansGenerate: 직전 주 조회 실패 — 연속성 없이 생성합니다", { uid, err: (err as Error).message });
    }

    // Quota AFTER the gate: a blocked request costs nothing, so it must not
    // consume the week's allowance.
    // 주 3회 카운터는 동결된 Flutter 경로만 유지한다. 토스는 아래 예약 트랜잭션을 쓴다.
    if (account.version === null) {
      let quota;
      try {
        quota = await countGeneration(db(), uid, new Date(), undefined, (tx) => assertAccount(db(), account, tx));
      } catch (err) {
        if (err instanceof AccountReset) { resetResponse(response); return; }
        response.status(503).json({ status: "error", message: `접수 실패: ${(err as Error).message}` });
        return;
      }
      if (!quota.allowed) {
        // 남용·버그 신호. uid 와 수치만 남긴다 — 프로필·로그·플랜은 절대 넣지 않는다(NFR-PRIV-1).
        logger.warn("plansGenerate: weekly quota exceeded", { uid, limit: quota.limit });
        response.status(429).json({
          status: "error",
          message: `이번 주 생성 한도(${quota.limit}회)를 모두 사용했습니다. ${quota.resetsOn}부터 다시 생성할 수 있습니다.`,
        });
        return;
      }
    }

    const jobId = randomUUID();
    const now = Date.now();
    const job: GenerationJob = {
      job_id: jobId,
      user_id: req.user_id,
      status: "queued",
      created_at: new Date(now).toISOString(),
      // **`Date` 로 쓴다 — 문자열이면 TTL 정책이 읽지 못해 영원히 남는다.**
      // Firestore TTL 은 Timestamp 필드만 본다(admin SDK 가 Date 를 Timestamp 로 바꾼다).
      expires_at: new Date(now + JOB_TTL_HOURS * 3600_000),
      // Firestore 는 undefined 값을 거부하므로 토큰이 없으면 필드를 생략한다.
      ...(req.fcm_token ? { fcm_token: req.fcm_token } : {}),
      ...(req.toss_push ? { toss_push: true } : {}),
      warnings: gate.warnings,
    };

    try {
      if (account.version !== null) {
        const reserved = await reserveGeneration(db(), account, job);
        if (!reserved.created) {
          response.status(202).json({ status: "queued", job_id: reserved.jobId, poll_url: `/v1/plans/${reserved.jobId}` });
          return;
        }
      } else if (!await accountWrite(account, response, (tx) => tx.set(db().collection(JOBS).doc(jobId), {
        ...job, ...(account.version !== null ? { account_version: account.version } : {}),
      }))) return;
      await getFunctions()
        .taskQueue(`locations/${REGION}/functions/plansWorker`)
        .enqueue({ jobId, req });
    } catch (err) {
      // 503: intake/enqueue infra failure (contract §오류 코드).
      if (err instanceof AccountReset) { resetResponse(response); return; }
      if (err instanceof AccessError) { response.status(err.status).json({ status: "error", code: err.code, message: err.message }); return; }
      // enqueue 결과가 불확실해도 queued 잡만 취소한다. 이미 시작한 워커는 자기 결과로 정산한다.
      if (account.version !== null) {
        await db().runTransaction(async tx => {
          await assertAccount(db(), account, tx);
          const ref = db().collection(JOBS).doc(jobId);
          const snap = await tx.get(ref);
          if (snap.get("status") !== "queued") return;
          if (!await settleGeneration(db(), tx, uid, jobId, false)) return;
          tx.update(ref, { status: "error", message: "생성을 접수하지 못했어요. 다시 시도해 주세요." });
        }).catch(error => logger.warn("plansGenerate: 예약 복구 지연", { jobId, reason: (error as Error).message }));
      }
      response.status(503).json({ status: "error", message: `접수 실패: ${(err as Error).message}` });
      return;
    }

    response
      .status(202)
      .json({ status: "queued", job_id: jobId, poll_url: `/v1/plans/${jobId}` });
  },
);

// ── 2) Worker ────────────────────────────────────────────────────────────────
export const plansWorker = onTaskDispatched<{ jobId: string; req: GenerateRequest }>(
  {
    region: REGION,
    timeoutSeconds: DECLARED_WORKER_TIMEOUT_SEC, // ADR-0016: hard limit; speed SLO stays p90 ≤ 60s
    memory: "512MiB",
    maxInstances: MAX_INSTANCES.worker,
    secrets: [LLM_API_KEY, ...TOSS_SECRETS],
    retryConfig: { maxAttempts: 1 }, // pipeline owns its own repair retries; no re-enqueue
  },
  async (task) => {
    const { jobId, req } = task.data;
    const ref = db().collection(JOBS).doc(jobId);
    // 큐에 들어간 뒤·시작 전에 사용자가 데이터를 지웠을 수 있다(삭제가 잡도 지운다).
    // 그냥 `update` 하면 NOT_FOUND 로 터져 500 이 되는데, 이건 오류가 아니라 취소다.
    // **확인과 갱신 사이에도 지워질 수 있으므로** 던지는 쪽도 같이 받는다.
    // 「오늘」은 접수 시각이다([D80]) — 일요일 밤에 접수한 잡이 월요일에 돌면 대상 주가 지난 주가 돼 지난 요일에 운동을 놓는다(codex N2 R1).
    let acceptedAt = Date.now();
    try {
      const started = await db().runTransaction(async tx => {
        const job = await tx.get(ref);
        if (!job.exists || job.get("status") !== "queued" || job.get("user_id") !== req.user_id) return false;
        const created = Date.parse(String(job.get("created_at")));
        if (Number.isFinite(created)) acceptedAt = created;
        tx.update(ref, { status: "running" });
        return true;
      });
      if (!started) return;
    } catch {
      logger.info("plansWorker: 시작 전에 잡이 사라졌습니다(사용자 삭제)", { jobId });
      return;
    }

    const startedAt = Date.now();
    let patch: Partial<GenerationJob>;
    let telemetry: GenerateResponse["telemetry"];
    // 잡에는 넣지 않는다(잡은 TTL 로 사라지고 이건 정본과 수명이 같아야 한다).
    // 편집이 재확장의 입력으로 쓴다 — 백로그 016.
    let draft: unknown;
    try {
      const config = buildConfig({
        LLM_PROVIDER: process.env.LLM_PROVIDER,
        LLM_API_KEY: LLM_API_KEY.value() || process.env.LLM_API_KEY,
        LLM_BASE_URL: process.env.LLM_BASE_URL,
        LLM_MODEL: process.env.LLM_MODEL,
        LLM_REASONING_MODE: process.env.LLM_REASONING_MODE,
        LLM_MAX_COMPLETION_TOKENS: process.env.LLM_MAX_COMPLETION_TOKENS,
        // Keeps the self-imposed deadline in step with the deployed timeout.
        WORKER_TIMEOUT_SEC: process.env.WORKER_TIMEOUT_SEC,
        // 생성 파이프라인(ADR-0025) — 없으면 auto(헬스장 P1, 그 밖 P0).
        GENERATION_PIPELINE: process.env.GENERATION_PIPELINE,
        CIRCUIT_GENERATION: process.env.CIRCUIT_GENERATION,
      });
      // The platform kills the container at `timeoutSeconds` without running any
      // of our code, which would leave the job stuck at `running` and the app
      // waiting for a push that never comes. So we stop ourselves a little early
      // and record the failure while we still can (contract: >540s → `error`).
      const result = await withDeadline(
        // The losing promise keeps running until the container dies; swallow its
        // outcome so a late rejection cannot take the process down.
        generatePlan(req, { config, now: acceptedAt }).catch(
          (err): GenerateResponse => ({ status: "error", message: (err as Error).message }),
        ),
        workerDeadlineMs(config.workerTimeoutSec),
      );
      if (result !== DEADLINE) telemetry = result.telemetry;
      let saveGuardProblems: string[] = [];
      if (result !== DEADLINE && result.status === "ok") {
        const prepared = prepareGeneration(req, config.pipeline, acceptedAt);
        saveGuardProblems = generatedPlanExerciseProblems(
          result.plan, prepared.request.profile, prepared.allowedExerciseIds,
        );
      }
      if (saveGuardProblems.length > 0) {
        logger.error("plansWorker: generated exercise policy rejected the final plan", {
          jobId,
          problems: saveGuardProblems,
        });
      }
      // Gate already passed at intake; worker sees only ok|error.
      patch =
        result === DEADLINE
          ? {
              status: "error",
              message: `생성이 제한 시간(${config.workerTimeoutSec}초)을 넘겨 중단했습니다. 잠시 후 다시 시도하세요.`,
            }
          : result.status === "ok" && saveGuardProblems.length === 0
            ? { status: "ok", plan: result.plan, warnings: result.warnings }
            : result.status === "ok"
              ? {
                  status: "error",
                  message: "생성 결과가 선택한 운동 환경과 맞지 않아 저장하지 않았습니다. 다시 시도해 주세요.",
                  warnings: result.warnings,
                }
            : { status: "error", message: result.message, warnings: result.warnings };
      if (result !== DEADLINE && result.status === "ok" && saveGuardProblems.length === 0) draft = result.draft;
    } catch (err) {
      patch = { status: "error", message: `워커 오류: ${(err as Error).message}` };
    }

    // 잡 종료 계측. 실패율·지연·LLM 비용을 이걸로만 볼 수 있다(대시보드 없음 — 백로그 009).
    // 식별자와 수치만 넣는다 — 프로필·플랜·에러 메시지 본문은 사용자 입력이
    // 섞일 수 있어 제외한다(NFR-PRIV-1, constitution 프라이버시 조항).
    // telemetry 는 로그 전용이다: 위 patch 는 필드를 명시 지정하므로 Firestore 에 들어가지 않는다.
    logger.info("plansWorker: job finished", {
      jobId,
      status: patch.status,
      durationMs: Date.now() - startedAt,
      ...(telemetry ?? {}),
    });

    let stored: boolean;
    try {
      stored = await db().runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (!current.exists || current.get("status") !== "running") return false;
        // 완료한 요일은 새 플랜이 덮지 않는다(D60 ①) — 저장 직전에 옛 항목을 되살린다.
        // 읽기는 쓰기 앞이어야 하므로(Firestore 트랜잭션 규칙) 여기서 읽는다.
        const weekRef = weeksOf(req.user_id).doc(req.week_start_date);
        const savedWeek = patch.status === "ok" ? ((await tx.get(weekRef)).data() as SavedWeek | undefined) : undefined;
        let accountVersion = current.get("account_version") as string | undefined;
        if (req.user_id.startsWith("toss:")) {
          if (accountVersion) {
            try { await assertAccount(db(), { uid: req.user_id, version: accountVersion }, tx); }
            catch (err) { if (err instanceof AccountReset) return false; throw err; }
          } else {
            // 배포 전에 접수된 잡은 잡 존재 확인과 함께 현재 연결에 한 번만 귀속한다.
            const account = await tx.get(accountRef(db(), req.user_id));
            accountVersion = account.data()?.version ?? randomUUID();
            if (!account.exists) tx.set(accountRef(db(), req.user_id), { version: accountVersion });
          }
        }
        if (current.get("generation_reserved") && !await settleGeneration(db(), tx, req.user_id, jobId, patch.status === "ok")) return false;
        tx.update(ref, { ...patch, ...(accountVersion ? { account_version: accountVersion } : {}) });
        if (patch.status === "ok") {
          // 완료 기록은 보존하고, 잡 완료와 정본 저장을 함께 커밋한다.
          // 완료한 요일의 플랜·드래프트 항목도 옛 것으로(D60 ①) — `preserveCompletedDays`.
          const kept = preserveCompletedDays(savedWeek, { plan: patch.plan, draft });
          const retired = retireProgressDrafts(savedWeek?.progress_drafts);
          tx.set(weekRef, {
            user_id: req.user_id,
            week_start_date: req.week_start_date,
            // week_number 는 넣지 않는다 — 요청값은 정규화 전이라(handler 의
            // normaliseWeekNumber) 플랜 안 `plan_meta.week_number` 와 갈릴 수 있다.
            // 정본은 플랜 자신이 갖고 있다.
            plan: kept.plan,
            // 편집이 고치는 것은 플랜이 아니라 드래프트다(INV-1) — 프로필과 함께
            // 둬야 재확장이 같은 안전 규칙으로 돈다. 백로그 016.
            // `merge` 라 **없으면 지운다는 뜻으로 `null` 을 쓴다.** 키를 빼면 직전
            // 생성의 드래프트가 남아 편집이 이 플랜과 무관한 드래프트를 재확장한다.
            draft: kept.draft ?? null,
            // `draft_original` 은 쓰지 않는다 — 「편집 되돌리기」를 없앴다(D59). 옛 문서에 남은 값은 읽는 곳이 없다.
            profile: req.profile,
            // 이 플랜을 만들 때 실제로 쓴 실측 기록. 편집이 재확장할 때 **같은 입력**을
            // 다시 먹어야 진행 결정이 보존된다 — 이 주의 `sessions`(지금 하고 있는
            // 운동)를 대신 읽으면 다른 플랜이 나온다.
            prior_logs: req.prior_logs ?? [],
            saved_at: new Date().toISOString(),
            // `merge` 라 직전 편집의 흔적이 남는다 — 새 플랜은 편집된 적이 없으므로
            // 지운다. 남기면 "언제 편집했나"가 이 플랜과 무관한 시각을 가리킨다.
            edited_at: null,
            ...(retired ? { progress_drafts: retired } : {}),
          }, { merge: true });
        }
        return true;
      });
    } catch (err) {
      logger.error("plansWorker: 결과 저장 실패", { jobId, error: (err as Error).message });
      patch = { status: "error", message: "플랜을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." };
      // 주차 저장이 실패해도 잡이 running에 머물지 않게 최소 오류 결과를 기록한다.
      // 이 사이의 삭제/재연결도 존중한다. 없는 잡을 set으로 되살리지 않는다.
      stored = await db().runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (!current.exists || current.get("status") !== "running") return false;
        const version = current.get("account_version") as string | undefined;
        if (req.user_id.startsWith("toss:") && version) {
          try { await assertAccount(db(), { uid: req.user_id, version }, tx); }
          catch (error) { if (error instanceof AccountReset) return false; throw error; }
        }
        if (current.get("generation_reserved") && !await settleGeneration(db(), tx, req.user_id, jobId, false)) return false;
        tx.update(ref, patch);
        return true;
      });
    }
    if (!stored) {
      logger.info("plansWorker: 사용자 삭제로 결과를 버립니다", { jobId });
      return;
    }

    // 앱인토스 기능성 푸시(2026-09-08) — 동의한 토스 사용자에게 「플랜 완성」 한 통. 실패해도 플랜은 이미 저장됐다.
    // 성공했을 때만 보낸다: 실패 알림은 문구가 다른 템플릿이 필요하고(콘솔 검수), 앱을 열면 오류가 보인다.
    const userKey = req.toss_push ? userKeyOf(req.user_id) : null;
    if (userKey && patch.status === "ok") {
      const toss = {
        clientCert: TOSS_CLIENT_CERT.value() || process.env.TOSS_CLIENT_CERT || undefined,
        clientKey: TOSS_CLIENT_KEY.value() || process.env.TOSS_CLIENT_KEY || undefined,
      };
      if (!toss.clientCert || !toss.clientKey) logger.error("plansWorker: 토스 인증서 미설정 — 푸시 생략", { jobId });
      else {
        try {
          const sent = await sendPlanReadyPush(toss, userKey);
          logger.info("plansWorker: toss push", { jobId, sentPushCount: sent.sentPushCount });
        } catch (err) {
          // 미동의(FAIL)도 여기로 온다 — 정상이라 error 가 아니라 info 다. 사용자 키·본문은 남기지 않는다.
          logger.info("plansWorker: toss push not sent", { jobId, reason: (err as Error).message });
        }
      }
    }

    // Completion push — data-only; app fetches the plan via GET (ADR-0011).
    // 토큰이 없는 클라이언트(토스 미니앱)는 폴링만 쓴다 — 보낼 곳이 없으므로 건너뛴다.
    if (!req.fcm_token) return;
    try {
      await getMessaging().send({
        token: req.fcm_token,
        data: { type: "plan_generated", job_id: jobId, status: patch.status ?? "error" },
      });
    } catch (err) {
      logger.error("plansWorker: FCM push failed", { jobId, error: (err as Error).message });
    }
  },
);

// ── 3) Status / result fetch + 편집 ──────────────────────────────────
/**
 * `/v1/plans/**` 전체를 받는 함수다(호스팅 rewrite 하나). 이름은 GET 시절 것이지만
 * 지금은 편집(PUT)과 교체 후보도 같이 받는다 — 같은 글로브라 함수를 나누면
 * rewrite 순서에 의존하는 배포 설정이 하나 더 생긴다. 배포된 함수 이름을
 * 바꾸는 것도 rewrite 변경이라 그대로 둔다.
 */
export const plansGet = onRequest(
  { region: REGION, timeoutSeconds: 30, memory: "256MiB", minInstances: READ_MIN_INSTANCES, cors: CORS_ORIGINS, maxInstances: MAX_INSTANCES.fetch, secrets: [SESSION_SECRET] },
  async (request, response) => {
    // Firebase Hosting fronts these functions with a CDN (§v1 rewrites), and the
    // response depends on the Authorization header, not just the URL. Never cache.
    response.setHeader("Cache-Control", "private, no-store");
    if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE" && request.method !== "POST") {
      response.status(405).json({ status: "error", message: "Method Not Allowed" });
      return;
    }
    const account = await authorize(request, response);
    if (!account) return;
    const { uid } = account;

    const segments = request.path.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";

    // 운동일 아침 알림 동의(계약 §2.8 · D90). 토스 로그인 사용자만 — 보낼 곳(userKey)이 없으면 의미가 없다.
    if (segments.length === 3 && segments[0] === "v1" && segments[1] === "plans" && last === "workout-push") {
      if (request.method !== "GET" && request.method !== "PUT") {
        response.status(405).json({ status: "error", message: "Method Not Allowed" }); return;
      }
      if (account.version === null || !userKeyOf(uid)) {
        response.status(400).json({ status: "error", message: "토스 로그인이 필요해요." }); return;
      }
      const ref = db().collection(PUSH_SUBS).doc(uid);
      if (request.method === "GET") {
        const snap = await ref.get();
        await accountResponse(account, response, 200, { status: "ok", enabled: snap.exists && snap.get("workout_day") === true });
        return;
      }
      const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled;
      // boolean 만 — 문자열 "false" 가 참으로 읽히면 끈 사람에게 간다.
      if (typeof enabled !== "boolean") {
        response.status(400).json({ status: "error", message: "enabled 는 true/false 여야 합니다." }); return;
      }
      try {
        // 계정 확인과 같은 트랜잭션 — 탈퇴 직후 늦은 요청이 동의를 되살리지 않는다.
        await db().runTransaction(async (tx) => {
          await assertAccount(db(), account, tx);
          tx.set(ref, { workout_day: enabled, updated_at: FieldValue.serverTimestamp() });
        });
      } catch (err) {
        if (err instanceof AccountReset) { resetResponse(response); return; }
        throw err;
      }
      await accountResponse(account, response, 200, { status: "ok", enabled });
      return;
    }
    if (segments.length === 3 && segments[0] === "v1" && segments[1] === "plans"
      && ["generation-access", "reward-start", "reward-claim"].includes(last)) {
      if (request.method !== (last === "generation-access" ? "GET" : "POST")) {
        response.status(405).json({ status: "error", message: "Method Not Allowed" }); return;
      }
      if (account.version === null) {
        response.status(400).json({ status: "error", message: "토스 로그인이 필요해요." }); return;
      }
      try {
        const body = last === "generation-access" ? await generationAccess(db(), account)
          : last === "reward-start" ? await startReward(db(), account)
          : await claimReward(db(), account, request.body?.reward_id);
        await accountResponse(account, response, 200, body);
      } catch (err) {
        if (err instanceof AccountReset) { resetResponse(response); return; }
        if (err instanceof AccessError) { response.status(err.status).json({ status: "error", code: err.code, message: err.message }); return; }
        response.status(503).json({ status: "error", message: "생성 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." });
      }
      return;
    }
    if (request.method === "POST") {
      response.status(405).json({ status: "error", message: "Method Not Allowed" }); return;
    }

    // 진행 초안은 완료 세션과 별도다. 정확한 경로만 받으며, 계정 초기화 DELETE 와 섞지 않는다.
    if (segments.length === 5 && segments[0] === "v1" && segments[1] === "plans" && segments[3] === "progress") {
      const week = segments[2]!;
      const day = segments[4]!;
      if (request.method === "GET") await getProgressDraft(account, week, day, response);
      else if (request.method === "PUT") await putProgressDraft(account, week, day, request.body, response);
      else response.status(405).json({ status: "error", message: "Method Not Allowed" });
      return;
    }
    if (segments.length === 6 && segments[0] === "v1" && segments[1] === "plans" && segments[3] === "progress" && segments[5] === "close") {
      if (request.method === "PUT") await closeProgressDraft(account, segments[2]!, segments[4]!, response);
      else response.status(405).json({ status: "error", message: "Method Not Allowed" });
      return;
    }

    // `DELETE /v1/plans` — 내 데이터 전부 삭제(NFR-PRIV-2). **멱등이다**: 지울 것이
    // 없어도 200 이다. 없는 것을 404 로 알리면 탈퇴 처리가 실패로 보인다.
    if (request.method === "DELETE") {
      // **정확히 그 경로에서만 지운다.** 경로를 안 보면 `DELETE /v1/plans/current`
      // 처럼 한 주만 지우려는 요청이 계정 전체를 날린다.
      if (segments.length !== 2 || segments[0] !== "v1" || segments[1] !== "plans") {
        response.status(404).json({ status: "error", message: "삭제는 /v1/plans 에서만 할 수 있습니다." });
        return;
      }
      let removed: number;
      try { removed = await deleteUserData(uid, account, true); }
      catch (err) { if (!(err instanceof AccountReset)) throw err; resetResponse(response); return; }
      logger.info("plansGet: 사용자 데이터 삭제", { uid, weeks: removed });
      response.status(200).json({ status: "ok", deleted_weeks: removed });
      return;
    }

    if (request.method === "PUT") {
      // `PUT /v1/plans/{current|YYYY-MM-DD}/sessions/{day_index}` — 세션 기록(계약 §2.4).
      // 편집보다 먼저 본다 — 경로가 더 길어 `last` 만 보면 요일 번호를 주차 키로 읽는다.
      if (segments[segments.length - 2] === "sessions") {
        await putSession(account, segments[segments.length - 3] ?? "current", last, request.body, response,
          request.query.finalize === "1", typeof request.query.plan_generated_at === "string" ? request.query.plan_generated_at : undefined);
        return;
      }
      // `PUT /v1/plans/{current|YYYY-MM-DD}` — 증분 편집(백로그 016).
      await editWeek(account, last, request.body, response);
      return;
    }

    // `GET /v1/plans/{current|YYYY-MM-DD}/candidates` — 교체·추가 후보.
    if (last === "candidates") {
      await weekCandidates(account, segments[segments.length - 2] ?? "current", request, response);
      return;
    }

    // `GET /v1/plans/history?weeks=12` — 주차별 완료 요약(메인 화면 히트맵).
    // **아래 잡 id 분기보다 먼저 본다** — `history` 는 주차 키도 `current` 도 아니라
    // 그냥 두면 그 이름의 잡을 찾다가 404 로 떨어진다.
    if (last === "history") {
      await weekHistory(account, request, response);
      return;
    }

    const jobId = (request.query.job_id as string) || last;
    if (!jobId) {
      response.status(400).json({ status: "error", message: "job_id required." });
      return;
    }

    // `GET /v1/plans/current` — 잡 id 를 잃어도 마지막 플랜을 되찾는 경로(D19).
    // 잡 id 는 UUID 라 `current` 와 부딪히지 않는다.
    //
    // **가장 최신 주차 문서**를 준다. 문서 id 가 `YYYY-MM-DD` 라 id 역순 1건이면
    // 끝난다(`__name__` 은 항상 색인돼 있어 복합 색인이 필요 없다). "이번 주"를
    // id 로 직접 집지 않는 이유: 있으면 그게 곧 최신이고, 없을 때는 어차피 최신으로
    // 떨어져야 빈 화면을 면한다 — 질의 한 번이면 두 경우가 다 처리된다. 응답의
    // `week_start_date` 로 어느 주 것인지는 클라이언트가 안다.
    //
    // `GET /v1/plans/{YYYY-MM-DD}` — 특정 주차. 잡 id 는 UUID 라 부딪히지 않는다.
    // 이게 없으면 이력이 write-only 다(내보내기·주차 비교가 이 경로로 읽는다).
    if (jobId === "current" || WEEK_START_RE.test(jobId)) {
      const saved = await loadWeek(uid, jobId);
      if (!saved) {
        await accountResponse(account, response, 404, { status: "error", message: "저장된 플랜이 없습니다." });
        return;
      }
      const { plan, week_start_date, sessions } = saved.data() as SavedWeek;
      // `sessions` 도 같이 싣는다(계약 §2.4). 기기를 바꿔도 어느 날을 이미 했는지
      // 알 수 있다 — 확정 플래그(D22-1, 로컬)와 달리 이건 서버가 정본이다(D19).
      await accountResponse(account, response, 200, { status: "ok", plan, week_start_date, ...(sessions ? { sessions } : {}) });
      return;
    }

    const snap = await db().collection(JOBS).doc(jobId).get();
    if (!snap.exists) {
      // Expired (TTL) or unknown — client falls back to its cached plan (FR-GEN-7).
      await accountResponse(account, response, 404, { status: "error", message: "Job not found or expired." });
      return;
    }

    const job = snap.data() as GenerationJob;
    if (job.user_id !== uid) {
      // 404, not 403: whether a job id exists is itself information.
      await accountResponse(account, response, 404, { status: "error", message: "Job not found or expired." });
      return;
    }
    await accountResponse(account, response, 200, {
      status: job.status,
      ...(job.status === "ok" ? { plan: job.plan } : {}),
      warnings: job.warnings,
      message: job.message,
    });
  },
);

/**
 * `PUT /v1/plans/{current|YYYY-MM-DD}` — 종목 추가·교체·삭제(백로그 016).
 * 판단은 전부 `generation/edit.ts` 가 한다(dev-server 와 같은 규칙을 쓰기 위해서다).
 * 여기는 문서를 읽고, 결과를 되쓰고, 코드를 그대로 돌려주는 것만 한다.
 *
 * LLM 을 부르지 않으므로 **주간 생성 한도를 소모하지 않는다** — 한 줄 고치자고
 * 주 3회짜리 생성을 태우게 하면 편집을 만든 이유가 사라진다.
 */
async function editWeek(account: Account, key: string, body: unknown, response: Response) {
  const { uid } = account;
  if (key !== "current" && !WEEK_START_RE.test(key)) {
    response.status(400).json({ status: "error", message: "편집 대상은 current 또는 YYYY-MM-DD 입니다." });
    return;
  }
  const saved = await loadWeek(uid, key);
  // 문서 id 가 곧 주 시작일이다 — 필드가 없는 문서라도 재확장이 빈 날짜로 돌지 않게 한다.
  const doc = saved ? { ...(saved.data() as SavedWeek), week_start_date: (saved.data() as SavedWeek).week_start_date ?? saved.id } : null;
  let previousWeeks: SavedWeek[] = [];
  if (!doc && (body as { op?: unknown } | null)?.op === "blank" && key !== "current") {
    // Number continuity can use older plans; recentPriorLogs bounds prescription history to 28 days.
    previousWeeks = (await latestWeeks(uid, undefined, key)).filter((week) => week.id < key)
      .map((week) => ({ ...(week.data() as SavedWeek), week_start_date: week.id }));
  }
  const outcome = editSavedWeek(doc, uid, body, key, previousWeeks);
  if (outcome.code === 500) logger.error("editWeek: 확장 오류", { uid, message: outcome.body.message });
  // 저장은 했지만 코드 규칙과 어긋나는 편집 — 사용자에게는 안 보이고(D20-1)
  // 여기서만 관측된다. 이게 잦아지면 상한·기본값이 현실과 안 맞는다는 신호다.
  if (outcome.policyNotes) logger.info("editWeek: 규칙 밖 편집을 저장함", { uid, notes: outcome.policyNotes });
  if (outcome.save) {
    // **빈 주는 문서가 없을 수도 있다**(만드는 것이지 고치는 것이 아니다, D20-2) —
    // 그때만 그 주 자리에 새 문서를 세운다. 이미 있는 문서에는 소유자·주 시작일을
    // 다시 쓰지 않는다: `key` 가 `current` 일 수 있어 그 문자열이 주 시작일 자리에
    // 박히면 **다음 재확장이 날짜를 못 읽고 터진다.**
    const ref = saved?.ref ?? weeksOf(uid).doc(key);
    const created = saved ? {} : { user_id: uid, week_start_date: key };
    if (!await accountWrite(account, response, async (tx) => {
      const operation = (body as { op?: unknown } | null)?.op;
      const latest = await tx.get(ref);
      const generatedAt = (outcome.save!.plan as { plan_meta: { generated_at: string } }).plan_meta.generated_at;
      // 교환([D79])은 두 날 초안을 닫지 않고 기록과 함께 옮긴다 — 닫는 대상에서 빼고 아래에서 맞바꾼다.
      const affected = operation === "blank" ? null : outcome.carry ? [] : operation === "move"
        ? [(body as { day_index: number }).day_index, (body as { to_day_index: number }).to_day_index]
        : [(body as { day_index: number }).day_index];
      const updatedDrafts = latest.exists ? reconcileProgressDrafts(latest.get("progress_drafts"), generatedAt, affected) : null;
      const carried = outcome.carry && latest.exists
        ? swapDayRecords(latest.get("sessions"), latest.get("progress_drafts"), outcome.carry.from, outcome.carry.to,
          String(latest.get("week_start_date") ?? latest.id), generatedAt)
        : null;
      tx.set(ref, { ...created, ...outcome.save, edited_at: new Date().toISOString(),
        ...(updatedDrafts ? { progress_drafts: updatedDrafts } : {}),
      }, { merge: true });
      // 두 요일 값은 **통째로 바꾼다** — `set(merge)` 는 중첩 맵을 깊게 합쳐 옮겨 온 세션에 없는 옛 키가 남는다.
      // 빈 자리(`null`)는 지운다. 같은 트랜잭션의 뒤 쓰기라 위 `set` 다음에 적용된다.
      if (carried) {
        for (const [field, values] of [["sessions", carried.sessions], ["progress_drafts", carried.drafts]] as const)
          for (const [day, value] of Object.entries(values)) tx.update(ref, new FieldPath(field, day), value ?? FieldValue.delete());
      }
    })) return;
  }
  await accountResponse(account, response, outcome.code, outcome.body);
}

/**
 * `DELETE /v1/plans` — 그 사용자의 데이터를 전부 지운다([NFR-PRIV-2](../../docs/product/01-prd.md)).
 *
 * 미니앱은 서버가 원본이라(D19) 사용자가 지울 방법이 없으면 보관이 영구가 된다.
 * 플랫폼도 **탈퇴 시 지체 없이 파기**를 요구한다(NFR-PRIV-2 · 계약 §2.5).
 *
 * **하위 컬렉션은 부모를 지워도 남는다** — Firestore 에서 문서 삭제는 그 아래
 * 컬렉션을 건드리지 않는다. 주차 문서를 하나씩 지워야 실제로 사라진다.
 *
 * 지우는 것: 주차 플랜·실측, 생성 잡, 계정 확인값. 한도 카운터는 탈퇴만 지운다.
 * 삭제 이력은 남기지 않는다. 재연결은 새 계정 버전을 발급한다.
 *
 * **`keepQuota` — 앱 안 초기화(백로그 037)는 한도 카운터를 남긴다**(계약 §2.5). 지우면
 * 「생성 → 초기화 → 다시 생성」이 LLM 비용 한도를 우회한다. 진행 중 예약만 **환불 없이**
 * 비운다 — 잡이 사라졌으니 남겨 두면 생성이 막히고, 환불하면 같은 우회가 된다.
 */
async function deleteUserData(uid: string, account?: Account, keepQuota = false): Promise<number> {
  return db().runTransaction(async (tx) => {
    if (account) await assertAccount(db(), account, tx);
    // 계정 확인값과 데이터 삭제를 같은 트랜잭션으로 처리한다. 모든 저장도 계정 버전을 읽으므로
    // 삭제 전에 시작한 요청이 뒤늦게 데이터를 되살릴 수 없다.
    const jobs = await tx.get(db().collection(JOBS).where("user_id", "==", uid));
    const weeks = await tx.get(weeksOf(uid));
    const access = keepQuota ? await tx.get(accessRef(db(), uid)) : null;
    tx.delete(accountRef(db(), uid));
    if (uid.startsWith("toss:")) invalidatePendingLogins(db(), tx);
    for (const doc of [...jobs.docs, ...weeks.docs]) tx.delete(doc.ref);
    if (keepQuota) {
      if (access?.get("active")) tx.update(access.ref, { active: null });
    } else {
      tx.delete(db().collection(RATE_LIMITS).doc(uid));
      tx.delete(accessRef(db(), uid));
    }
    // 동의는 한도 카운터가 아니다 — 초기화(§2.5)도 지운다(계약 §2.8).
    tx.delete(db().collection(PUSH_SUBS).doc(uid));
    return weeks.docs.length;
  });
}

/** 완료 전의 세트 입력을 별도 필드에서 읽는다. 완료 기록(`sessions`)으로 오인하지 않는다. */
async function getProgressDraft(account: Account, key: string, dayRaw: string, response: Response) {
  if ((key !== "current" && !WEEK_START_RE.test(key)) || !/^[0-6]$/.test(dayRaw)) {
    response.status(400).json({ status: "error", message: "진행 기록의 주차 또는 요일이 올바르지 않습니다." }); return;
  }
  const saved = await loadWeek(account.uid, key);
  if (!saved) { await accountResponse(account, response, 404, { status: "error", message: "저장된 플랜이 없습니다." }); return; }
  const raw = (saved.get("progress_drafts") as Record<string, unknown> | undefined)?.[dayRaw];
  const draft = raw === undefined ? null : readProgressDraft(raw);
  if (raw !== undefined && !draft) {
    await accountResponse(account, response, 503, { status: "error", code: "DRAFT_CORRUPT", message: "서버 진행 기록을 확인할 수 없어요. 기록을 덮어쓰지 않았어요." }); return;
  }
  await accountResponse(account, response, 200, { status: "ok", draft });
}

/** revision 비교는 주차 문서 읽기와 같은 트랜잭션 안에서 한다. 다른 기기의 새 기록을 덮지 않는다. */
async function putProgressDraft(account: Account, key: string, dayRaw: string, body: unknown, response: Response) {
  if ((key !== "current" && !WEEK_START_RE.test(key)) || !/^[0-6]$/.test(dayRaw)) {
    response.status(400).json({ status: "error", message: "진행 기록의 주차 또는 요일이 올바르지 않습니다." }); return;
  }
  const input = parseProgressDraft(body);
  if (!input) { response.status(400).json({ status: "error", message: "진행 기록 형식 또는 크기가 올바르지 않습니다." }); return; }
  const saved = await loadWeek(account.uid, key);
  if (!saved) { await accountResponse(account, response, 404, { status: "error", message: "저장된 플랜이 없습니다." }); return; }
  let result: { code: number; body: Record<string, unknown> };
  try {
    result = await db().runTransaction(async (tx) => {
      await assertAccount(db(), account, tx);
      const latest = await tx.get(saved.ref);
      if (!latest.exists) return { code: 404, body: { status: "error", message: "저장된 플랜이 없습니다." } };
      const planMeta = (latest.get("plan") as { plan_meta?: { plan_id?: unknown; generated_at?: unknown } } | undefined)?.plan_meta;
      if (planMeta?.plan_id !== input.plan_id || (planMeta.generated_at ?? planMeta.plan_id) !== input.plan_generated_at) return {
        code: 409, body: { status: "error", code: "PLAN_CHANGED", message: "플랜이 바뀌었어요. 현재 기록을 보존하고 다시 확인해 주세요." },
      };
      const draftMap = latest.get("progress_drafts") as Record<string, unknown> | undefined;
      if (draftMap !== undefined && (typeof draftMap !== "object" || draftMap === null || Array.isArray(draftMap))) return {
        code: 503, body: { status: "error", code: "DRAFT_CORRUPT", message: "서버 진행 기록을 확인할 수 없어 덮어쓰지 않았어요." },
      };
      const raw = draftMap?.[dayRaw];
      const current = raw === undefined ? null : readProgressDraft(raw);
      if (raw !== undefined && !current) return { code: 503, body: { status: "error", code: "DRAFT_CORRUPT", message: "서버 진행 기록을 확인할 수 없어 덮어쓰지 않았어요." } };
      const revision = current?.revision ?? 0;
      if (revision !== input.base_revision) return { code: 409, body: { status: "error", code: "DRAFT_CONFLICT", message: "다른 기기에서 진행 기록이 바뀌었어요.", draft: current } };
      if (current?.closed_reason === "plan_replaced" && !input.start_after_retire) return {
        code: 409, body: { status: "error", code: "DRAFT_RETIRED", message: "플랜 구성이 바뀌었어요. 이전 기록은 보존했어요.", draft: current },
      };
      if (current?.closed_reason !== "plan_replaced" && input.start_after_retire) return {
        code: 409, body: { status: "error", code: "DRAFT_CONFLICT", message: "새 플랜 시작 상태를 다시 확인해 주세요.", draft: current },
      };
      const draft: StoredProgressDraft = {
        plan_id: input.plan_id, plan_generated_at: input.plan_generated_at,
        revision: revision + 1, updated_at: new Date().toISOString(), closed: false, progress: input.progress,
      };
      if (current?.closed_reason === "plan_replaced") {
        const archiveRaw = latest.get("progress_draft_archives") as Record<string, unknown> | undefined;
        if (archiveRaw !== undefined && (typeof archiveRaw !== "object" || archiveRaw === null || Array.isArray(archiveRaw))) return {
          code: 503, body: { status: "error", code: "DRAFT_CORRUPT", message: "이전 기록을 보관할 수 없어 새 기록을 저장하지 않았어요." },
        };
        const archiveKey = `${dayRaw}_${randomUUID()}`;
        tx.update(saved.ref, { progress_draft_archives: { ...archiveRaw, [archiveKey]: current },
          progress_drafts: { ...draftMap, [dayRaw]: draft } });
      } else tx.update(saved.ref, new FieldPath("progress_drafts", dayRaw), draft);
      return { code: 200, body: { status: "ok", draft } };
    });
  } catch (err) { if (!(err instanceof AccountReset)) throw err; resetResponse(response); return; }
  await accountResponse(account, response, result.code, result.body);
}

/** 이미 저장된 세션을 다시 PUT하지 않고 초안만 닫는다. 다른 기기의 새 세션을 덮지 않는다. */
async function closeProgressDraft(account: Account, key: string, dayRaw: string, response: Response) {
  if ((key !== "current" && !WEEK_START_RE.test(key)) || !/^[0-6]$/.test(dayRaw)) {
    response.status(400).json({ status: "error", message: "진행 기록의 주차 또는 요일이 올바르지 않습니다." }); return;
  }
  const saved = await loadWeek(account.uid, key);
  if (!saved) { await accountResponse(account, response, 404, { status: "error", message: "저장된 플랜이 없습니다." }); return; }
  let code = 200;
  try {
    await db().runTransaction(async (tx) => {
      await assertAccount(db(), account, tx);
      const latest = await tx.get(saved.ref);
      if (!latest.exists || !((latest.get("sessions") as Record<string, unknown> | undefined)?.[dayRaw])) { code = 404; return; }
      const raw = (latest.get("progress_drafts") as Record<string, unknown> | undefined)?.[dayRaw];
      const current = raw === undefined ? null : readProgressDraft(raw);
      if (raw !== undefined && !current) { code = 503; return; }
      if (current?.closed_reason === "plan_replaced") return;
      tx.update(saved.ref, new FieldPath("progress_drafts", dayRaw), {
        plan_id: (latest.get("plan") as { plan_meta?: { plan_id?: string } } | undefined)?.plan_meta?.plan_id ?? "",
        revision: (current?.revision ?? 0) + 1, updated_at: new Date().toISOString(),
        closed: true, closed_reason: "session_completed", ...(current?.progress ? { progress: current.progress } : {}),
      } satisfies StoredProgressDraft);
    });
  } catch (err) { if (!(err instanceof AccountReset)) throw err; resetResponse(response); return; }
  await accountResponse(account, response, code, code === 200 ? { status: "ok" } :
    { status: "error", message: code === 503 ? "서버 진행 기록을 확인할 수 없어 덮어쓰지 않았어요." : "저장된 운동 기록이 없습니다." });
}

/**
 * `PUT /v1/plans/{current|YYYY-MM-DD}/sessions/{day_index}` — 세션 기록(계약 §2.4).
 *
 * 저장 위치는 **그 주차 문서의 `sessions` 맵**이다. 하위 컬렉션으로 빼면 조회 경로가
 * 하나 더 생기는데, `GET /v1/plans/current` 가 이미 이 문서를 읽는다.
 *
 * LLM 을 부르지 않으므로 **주간 생성 한도를 소모하지 않는다**.
 */
async function putSession(account: Account, key: string, dayIndexRaw: string, body: unknown, response: Response,
  finalize = false, planGeneratedAt?: string) {
  const { uid } = account;
  if (key !== "current" && !WEEK_START_RE.test(key)) {
    response.status(400).json({ status: "error", message: "기록 대상은 current 또는 YYYY-MM-DD 입니다." });
    return;
  }
  const saved = await loadWeek(uid, key);
  const outcome = saveSessionOn(saved !== null, dayIndexRaw, body);
  if (outcome.save && saved) {
    // 점 표기 필드 하나만 건드린다 — 같은 시각의 편집(§2.2)이 쓰는 `plan`·`draft`
    // 와 겹치지 않는다. 같은 요일로 다시 보내면 그 요일만 덮어쓴다(멱등 upsert).
    const { dayIndex, session } = outcome.save;
    let planMismatch = false;
    // 최종 완료라면 초안을 tombstone 으로 닫는다. 늦게 도착한 쓰기는 revision 충돌로 막힌다.
    // 교체 직전의 부분 저장(stay)은 아직 운동 중이므로 닫지 않는다.
    if (!await accountWrite(account, response, async (tx) => {
      const latest = finalize || planGeneratedAt ? await tx.get(saved.ref) : null;
      const planMeta = (latest?.get("plan") as { plan_meta?: { plan_id?: string; generated_at?: string } } | undefined)?.plan_meta;
      if (planGeneratedAt && (planMeta?.generated_at ?? planMeta?.plan_id) !== planGeneratedAt) {
        planMismatch = true; return;
      }
      const raw = (latest?.get("progress_drafts") as Record<string, unknown> | undefined)?.[String(dayIndex)];
      const existing = raw === undefined ? null : readProgressDraft(raw);
      const generatedAt = (latest?.get("plan") as { plan_meta?: { generated_at?: unknown } } | undefined)?.plan_meta?.generated_at;
      const closed = finalize && existing?.closed_reason !== "plan_replaced" ? { progress_drafts: { [dayIndex]: {
        plan_id: (session as { plan_id: string }).plan_id,
        ...(typeof generatedAt === "string" ? { plan_generated_at: generatedAt } : {}),
        revision: FieldValue.increment(1), closed: true, closed_reason: "session_completed", updated_at: new Date().toISOString(),
      } } } : {};
      tx.set(saved.ref, { sessions: { [dayIndex]: session }, ...closed }, { merge: true });
    })) return;
    if (planMismatch) { await accountResponse(account, response, 409,
      { status: "error", code: "PLAN_CHANGED", message: "플랜이 바뀌었어요. 기기 기록은 그대로 보존했어요." }); return; }
  }
  await accountResponse(account, response, outcome.code, outcome.body);
}

/** 히트맵 한 줄의 기본 길이와 상한. 더 달라고 해도 상한에서 자른다. */
const HISTORY_DEFAULT_WEEKS = 12;
const HISTORY_MAX_WEEKS = 26;

/**
 * `GET /v1/plans/history?weeks=N` — 최근 N주 완료 요약(기본 12, 최대 26).
 * `exercise_id` 가 붙으면 **그 종목의 `이전`·`최고`** 를 대신 준다(백로그 025 §2 · D35).
 *
 * **플랜을 싣지 않는다.** 12주치 플랜은 수백 KB 인데 화면이 읽는 것은 주당 두
 * 숫자뿐이다. 요약을 여기서 만드는 값으로 그 무게를 산다.
 *
 * 세는 규칙은 미니앱 `weekProgress` 와 **같아야 한다** — 휴식일은 분자·분모
 * 양쪽에서 빼고, 부분 완료도 한 날로 센다(세션 문서의 존재가 근거다, D22-6).
 * 두 쪽이 어긋나면 오늘 카드의 `3/4일` 과 히트맵의 그 주 칸이 다른 말을 한다.
 *
 * **`exercise_id` 가 없을 때의 동작은 한 줄도 바뀌지 않았다** — 메인 히트맵이
 * 이 경로를 쓴다. 두 모드는 기본·상한도 다르다(요약 12·26 / 종목 26·52).
 */
async function weekHistory(account: Account, request: Request, response: Response) {
  const { uid } = account;
  // 새 함수도 새 rewrite 도 열지 않는다(D35) — 이 분기 하나가 종목 이력의 전부다.
  const exerciseId = typeof request.query.exercise_id === "string" ? request.query.exercise_id : "";
  if (exerciseId) {
    const limit = clampWeeks(request.query.weeks, EXERCISE_HISTORY_DEFAULT_WEEKS, EXERCISE_HISTORY_MAX_WEEKS);
    // **자른 값이 그대로 질의 상한이다** — 여기서 안 자르면 상한이 선언일 뿐이고
    // Firestore 문서 읽기는 그대로 는다(025 §2 가 상한을 둔 이유).
    const snapDocs = await latestWeeks(uid, limit);
    // 판단은 전부 순수함수가 한다(`edit.ts`·`session.ts` 와 같은 구조) — 여기는
    // 문서를 읽어 넘기는 것만. 문서 id 가 곧 주 시작일이라 필드가 없는 옛 문서도 채운다.
    const weeks = snapDocs.map((doc) => {
      const data = doc.data() as SavedWeek;
      return { ...data, week_start_date: data.week_start_date ?? doc.id };
    });
    // **이번 주는 `previous` 에서 뺀다**(025 §2 · G4 2026-08-31). 클라이언트가 준다 —
    // "이번 주"는 사용자의 로컬 달력 기준이라(D22-3) 서버가 스스로 정할 수 없다.
    // 형식이 어긋나면 안 준 것으로 친다: `"zzz"` 같은 값이 오면 문자열 비교가
    // **모든 주를 이번 주보다 앞선 것으로 만들지 않고 전부 빼 버린다.**
    const askedWeek = request.query.week_start_date;
    const currentWeek = typeof askedWeek === "string" && WEEK_START_RE.test(askedWeek) ? askedWeek : "";
    // **필드를 하나씩 꺼내지 않는다**(codex 041 N6) — `previous_cardio` 처럼 뒤에 붙는 칸이
    // 순수함수에만 생기고 응답에서 조용히 빠진다. 집계가 준 것을 그대로 싣는다.
    const history = exerciseHistory(weeks, exerciseId, limit, currentWeek);
    await accountResponse(account, response, 200, { status: "ok", ...history });
    return;
  }
  // 성장 비교(계약 §2.6.2 · D90) — `exercise_id` 가 이긴다(위에서 이미 돌아갔다). 두 주는 날짜로 고른다.
  if (request.query.trend === "1") {
    const asked = request.query.week_start_date;
    if (!isCalendarDate(asked)) {
      response.status(400).json({ status: "error", message: "week_start_date(YYYY-MM-DD)가 필요합니다." });
      return;
    }
    const [cur, prev] = await Promise.all([weeksOf(uid).doc(asked).get(), weeksOf(uid).doc(previousWeekOf(asked)).get()]);
    const asWeek = (doc: typeof cur) => (doc.exists ? { ...(doc.data() as SavedWeek), week_start_date: doc.id } : null);
    await accountResponse(account, response, 200, { status: "ok", ...growthTrend(asWeek(cur), asWeek(prev), asked) });
    return;
  }

  const weeks = clampWeeks(request.query.weeks, HISTORY_DEFAULT_WEEKS, HISTORY_MAX_WEEKS);
  // 문서 id 가 `YYYY-MM-DD` 라 id 역순이 곧 최신순이다(`loadWeek` 과 같은 이유 —
  // `__name__` 은 항상 색인돼 복합 색인이 필요 없다).
  const snapDocs = await latestWeeks(uid, weeks);
  const history = snapDocs.map((doc) => {
    const { plan, week_start_date, sessions } = doc.data() as SavedWeek;
    // **모양을 믿지 않는다.** 이 컬렉션에는 계약이 지금과 달랐던 시절의 문서가
    // 남아 있다(§2.3 이 "드래프트 없는 옛 플랜"에 `409` 를 주는 것이 그 증거다).
    // 한 문서가 `.filter is not a function` 으로 터지면 그 사용자의 메인 화면이
    // 통째로 500 이고, 되돌릴 경로가 없다(cursor 교차검증 2026-08-28).
    const raw = (plan as { week?: unknown } | undefined)?.week;
    const week = (Array.isArray(raw) ? raw : []) as Array<{ day_index?: number; session_type?: string }>;
    const training = week.filter((d) => d?.session_type !== "rest");
    return {
      week_start_date: week_start_date ?? doc.id,
      done: training.filter((d) => sessions?.[String(d.day_index)]).length,
      total: training.length,
    };
  });
  // **오래된 주가 먼저다** — 화면은 왼쪽에서 오른쪽으로 시간순으로 그린다.
  await accountResponse(account, response, 200, { status: "ok", history: history.reverse() });
}

/** `GET /v1/plans/{current|YYYY-MM-DD}/candidates?day_index=&exercise_id=` — 교체·추가 후보. */
async function weekCandidates(account: Account, key: string, request: Request, response: Response) {
  const { uid } = account;
  const saved = await loadWeek(uid, key);
  const outcome = candidatesFor(
    saved ? (saved.data() as SavedWeek) : null,
    Number(request.query.day_index),
    typeof request.query.exercise_id === "string" ? request.query.exercise_id : "",
    // `q` 가 있으면 추천이 아니라 **전체 검색**이다(D20-1 탈출구).
    typeof request.query.q === "string" ? request.query.q : "",
    // `muscle` 은 **부위 훑기**다(백로그 020). 콤마로 여럿 — 화면의 부위 하나가
    // 근육 여럿이다(`등` = lats·middle back·lower back·traps). 검색어와 함께 적용한다.
    typeof request.query.muscle === "string"
      ? request.query.muscle.split(",").map((m) => m.trim()).filter(Boolean)
      : [],
    request.query.limit === undefined ? undefined : Number(request.query.limit),
  );
  await accountResponse(account, response, outcome.code, outcome.body);
}

/**
 * 운동일 아침 푸시(계약 §2.8 · D90) — 매일 08:00 서울. 동의한 토스 사용자 중 **오늘이 운동일인 사람에게만** 한 통.
 * 쉬는 날·빈 주·플랜 없음은 보내지 않는다. 한 사람의 실패(미동의 FAIL 포함)는 로그만 남기고 다음 사람으로 간다.
 * 사용자당 분당 10회 · 앱당 분당 15,000회 상한 — 하루 한 통이라 걸리지 않는다.
 */
export const workoutDayPush = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Asia/Seoul", region: REGION, timeoutSeconds: 540, memory: "256MiB", secrets: [TOSS_CLIENT_CERT, TOSS_CLIENT_KEY] },
  async (event) => {
    await sendWorkoutDayPushes(new Date(event.scheduleTime ?? Date.now()));
  },
);

/** 예약 함수의 몸통 — 테스트가 시각을 주고 부른다. 보낸 수를 돌려준다. */
export async function sendWorkoutDayPushes(now: Date): Promise<number> {
  const toss = {
    clientCert: TOSS_CLIENT_CERT.value() || process.env.TOSS_CLIENT_CERT || undefined,
    clientKey: TOSS_CLIENT_KEY.value() || process.env.TOSS_CLIENT_KEY || undefined,
  };
  if (!toss.clientCert || !toss.clientKey) { logger.error("workoutDayPush: 토스 인증서 미설정 — 발송 생략"); return 0; }
  const today = seoulToday(now);
  const week = mondayOf(today);
  const subs = await db().collection(PUSH_SUBS).where("workout_day", "==", true).get();
  let sent = 0, skipped = 0, failed = 0;
  for (const sub of subs.docs) {
    try {
      const userKey = userKeyOf(sub.id);
      const doc = userKey ? await weeksOf(sub.id).doc(week).get() : null;
      const focus = doc?.exists ? workoutDayFocus({ ...(doc.data() as SavedWeek), week_start_date: doc.id }, today) : null;
      if (!userKey || !focus) { skipped += 1; continue; }
      // 보내기 직전에 다시 읽는다 — 앞 사람을 보내는 사이 끈 사람에게 가면 안 된다(codex N4 R1).
      if ((await sub.ref.get()).get("workout_day") !== true) { skipped += 1; continue; }
      // 한 요청이 멈춰도 다음 사람은 간다 — `mtlsRequest` 가 15초 무응답이면 연결을 끊고 던진다.
      await sendTossPush(toss, userKey, WORKOUT_DAY_TEMPLATE, { focus });
      sent += 1;
    } catch (err) {
      // 오류 코드만 남긴다 — 토스 `reason` 원문·사용자 키·본문은 남기지 않는다.
      failed += 1;
      logger.info("workoutDayPush: not sent", { reason: (err as Error).message.split(" — ")[0] });
    }
  }
  logger.info("workoutDayPush: done", { today, sent, skipped, failed });
  return sent;
}
