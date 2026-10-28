/**
 * Generation API contract test (001 T5.1 — contracts/generation-api.md §검증).
 *
 * Drives the real Firebase entrypoints (`plansGenerate` / `plansWorker` /
 * `plansGet`) with firebase-admin mocked out and the LLM pointed at the local
 * fake host, so every status code, body shape and side effect in the contract is
 * asserted without a project, a queue, or a paid call. What genuinely needs the
 * cloud — queue delivery, the 540s kill, TTL expiry, a real push — is verified
 * after the G2 deploy (T6.2–T6.4).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkWeeklyPlan } from "../src/schemas/validate";
import { expandDraftToWeeklyPlan } from "../src/generation/expand";
import { prepareGeneration } from "../src/generation/prepare";
import * as generationHandler from "../src/generation/handler";
import type { GenerateRequest } from "../src/generation/types";
import { startFakeLlm, type FakeLlm } from "./fake-llm-server";
import { EVAL_PROFILES, GOLDEN_PROFILES } from "./fixtures/golden-profiles";
import drafts from "./fixtures/golden-drafts.json";
import exerciseLabels from "../src/data/exercise-labels.json";

const CASES = (drafts as { cases: Record<string, { draft: unknown }> }).cases;
const SAMPLE = GOLDEN_PROFILES[0]!;

// ── firebase-admin doubles ───────────────────────────────────────────────────
const enqueued: unknown[] = [];
const pushes: unknown[] = [];
let enqueueFails = false;
let beforeTransaction: (() => Promise<void>) | null = null;
let beforeQuery: (() => Promise<void>) | null = null;
let transactionTail: Promise<unknown> = Promise.resolve();

vi.mock("firebase-admin/app", () => ({ initializeApp: () => ({}) }));
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    // "token-<uid>" verifies as that uid; anything else is rejected the way a
    // forged or expired token would be.
    verifyIdToken: async (token: string) => {
      const match = /^token-(.+)$/.exec(token);
      if (!match) throw new Error("invalid token");
      return { uid: match[1] };
    },
  }),
}));
/** Store per collection: jobs and rate-limit counters must not share a keyspace. */
const collections = new Map<string, Map<string, Record<string, unknown>>>();
const store = (name: string) => {
  const existing = collections.get(name);
  if (existing) return existing;
  const created = new Map<string, Record<string, unknown>>();
  collections.set(name, created);
  return created;
};

/**
 * `set(..., {merge: true})` 는 **맵을 깊게 합친다** — Firestore 실제 동작이다.
 * 얕게 덮으면 `sessions.{day}` 하나를 쓸 때 다른 요일이 사라져, 배포본에서는
 * 멀쩡한 것이 테스트에서만 깨진다(§2.4 멱등 upsert 가 바로 이 경로다).
 * 배열은 합치지 않고 통째로 교체한다 — 이것도 Firestore 와 같다.
 */
function deepMerge(into: Record<string, unknown>, patch: Record<string, unknown>) {
  const out = { ...into };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    const mergeable = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
    out[key] = value && typeof value === "object" && "__increment" in value
      ? (typeof prev === "number" ? prev : 0) + (value as { __increment: number }).__increment
      : mergeable(prev) && mergeable(value)
      ? deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return out;
}

/**
 * DocumentSnapshot. **`get(field)` 가 있어야 한다** — 접수의 연속성·진행 경로가
 * `prev.get("plan")`·`prev.get("sessions")` 로 읽는다. 없으면 그 호출이 던지고
 * 접수의 try/catch 가 삼켜, 연속성이 통째로 죽은 채로 테스트는 초록이 된다.
 */
function snapshot(collection: string, id: string) {
  const bucket = store(collection);
  return {
    exists: bucket.has(id),
    id,
    data: () => bucket.get(id),
    get: (field: string) => bucket.get(id)?.[field],
    ref: docRef(collection, id),
  };
}

function docRef(collection: string, id: string) {
  const bucket = store(collection);
  return {
    _collection: collection,
    _id: id,
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) =>
      void bucket.set(id, options?.merge ? deepMerge(bucket.get(id) ?? {}, data) : { ...data }),
    // **없는 문서에는 실패한다** — 실제 Firestore `update()` 가 NOT_FOUND 를 던진다.
    // 만들어 버리면, 사용자가 지운 뒤 돌던 워커가 잡을 되살리는 것을 못 잡는다.
    update: async (patch: Record<string, unknown>) => {
      if (!bucket.has(id)) throw new Error(`NOT_FOUND: ${collection}/${id}`);
      bucket.set(id, { ...bucket.get(id), ...patch });
    },
    delete: async () => void bucket.delete(id),
    // `update(FieldPath(root, child), value)` — 실제 Firestore 처럼 **그 값을 통째로 바꾼다**(깊은 병합 아님) · `FieldValue.delete()` 는 지운다.
    setPath: async (root: string, child: string, value: unknown) => {
      if (!bucket.has(id)) throw new Error(`NOT_FOUND: ${collection}/${id}`);
      const doc = { ...bucket.get(id) };
      const map = { ...(doc[root] as Record<string, unknown> | undefined) };
      if (value && typeof value === "object" && "__delete" in value) delete map[child]; else map[child] = value;
      bucket.set(id, { ...doc, [root]: map });
    },
    // `ref`·`id` 는 편집 경로가 쓴다(읽은 문서에 그대로 되쓴다 — 백로그 016).
    get: async () => snapshot(collection, id),
    // 하위 컬렉션은 `부모/{id}/이름` 을 키로 쓰는 또 하나의 버킷이다 —
    // 실제 Firestore 처럼 사용자마다 분리된 키스페이스가 된다.
    collection: (sub: string) => collectionRef(`${collection}/${id}/${sub}`),
  };
}

/**
 * 컬렉션 참조. `plansGet` 이 쓰는 만큼만 흉내낸다 — 문서 id 역순 1건.
 * 실제 Firestore 도 `__name__` 정렬은 기본 색인이라 복합 색인 없이 돈다.
 */
function collectionRef(name: string) {
  const query = (limitTo: number, desc = true) => ({
    limit: (n: number) => query(n, desc),
    get: async () => {
      const hook = beforeQuery;
      beforeQuery = null;
      await hook?.();
      const sorted = [...store(name).keys()].sort();
      const ids = (desc ? sorted.reverse() : sorted).slice(0, limitTo);
      return { docs: ids.map((id) => snapshot(name, id)) };
    },
  });
  return {
    doc: (id: string) => docRef(name, id),
    limit: (n: number) => query(n),
    // 컬렉션 전체 — 삭제 경로가 하위 컬렉션을 훑을 때 쓴다(NFR-PRIV-2).
    get: async () => ({ docs: [...store(name).keys()].sort().map((id) => snapshot(name, id)) }),
    // 단일 필드 동등 질의. 삭제가 `user_id` 로 잡을 훑는다(단일 필드 색인은 기본이다).
    where: (field: string, op: string, value: unknown) => {
      if (op !== "==") throw new Error("이 테스트 더블은 == 만 흉내낸다");
      return {
        get: async () => ({
          docs: [...store(name).keys()]
            .filter((id) => store(name).get(id)?.[field] === value)
            .sort()
            .map((id) => snapshot(name, id)),
        }),
      };
    },
    // 오름차순(기본)과 내림차순 둘 다 — 배포본은 색인 없이 도는 **오름차순**으로 읽고 뒤에서 자른다(`latestWeeks`).
    orderBy: (_field: unknown, direction?: string) => {
      if (direction !== undefined && direction !== "asc" && direction !== "desc") throw new Error("이 테스트 더블은 asc·desc 만 흉내낸다");
      return query(Infinity, direction === "desc");
    },
  };
}

/** `YYYY-MM-DD` + n일(UTC). */
function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

vi.mock("firebase-admin/firestore", () => ({
  // `orderBy(FieldPath.documentId())` — 더블은 정렬 축이 하나뿐이라 표식이면 된다.
  FieldPath: class { constructor(...public segments: string[]) {} static documentId() { return "__name__"; } },
  FieldValue: { increment: (amount: number) => ({ __increment: amount }), delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }) },
  getFirestore: () => ({
    collection: (name: string) => collectionRef(name),
    // Writes are committed only after all reads and the callback succeed.
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const hook = beforeTransaction;
      beforeTransaction = null;
      await hook?.();
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
      const writes: Array<() => Promise<unknown>> = [];
      const result = await fn({
        get: (ref: { get: () => Promise<unknown> }) => {
          if (writes.length) throw new Error("Firestore transactions require reads before writes");
          return ref.get();
        },
        set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>, options?: { merge?: boolean }) => { writes.push(() => ref.set(data, options)); },
        update: (ref: ReturnType<typeof docRef>, data: Record<string, unknown> | { segments: string[] }, value?: unknown) => {
          if ("segments" in data) {
            const [root, child] = data.segments;
            writes.push(() => ref.setPath(root!, child!, value));
          } else writes.push(() => ref.update(data));
        },
        delete: (ref: ReturnType<typeof docRef>) => { writes.push(() => ref.delete()); },
      });
      for (const write of writes) await write();
      return result;
      } finally { release(); }
    },
  }),
}));
vi.mock("firebase-admin/functions", () => ({
  getFunctions: () => ({
    taskQueue: () => ({
      enqueue: async (payload: unknown) => {
        if (enqueueFails) throw new Error("queue unavailable");
        enqueued.push(payload);
      },
    }),
  }),
}));
vi.mock("firebase-admin/messaging", () => ({
  getMessaging: () => ({ send: async (message: unknown) => void pushes.push(message) }),
}));

const { authToss, plansGenerate, plansWorker, plansGet, tossWithdraw, workerDeadlineMs, sendWorkoutDayPushes } = await import("../src/index");
const { accountKey, loginAccount, readLoginRevision, LoginInterrupted } = await import("../src/auth/account");
const { mintSession, verifySessionClaims } = await import("../src/auth/toss");
const { getFirestore } = await import("firebase-admin/firestore");
const { WEEKLY_GENERATION_LIMIT } = await import("../src/rate-limit");
const { generationWeek, generationAccess, settleGeneration, RESERVATION_MS } = await import("../src/generation/access");

/** The jobs collection, which most assertions are about. */
const docs = store("generation_jobs");

// ── HTTP doubles ─────────────────────────────────────────────────────────────
/**
 * Express response double. `onRequest` awaits `res.on("finish")` and the task
 * wrapper answers with `status().end()`, so both have to work.
 */
function res() {
  const captured = { code: 0, body: undefined as unknown };
  const finish: Array<() => void> = [];
  const done = () => finish.splice(0).forEach((cb) => cb());
  const self = {
    status(code: number) {
      captured.code = code;
      return self;
    },
    json(body_: unknown) {
      captured.body = body_;
      done();
      return self;
    },
    send(body_: unknown) {
      captured.body = body_;
      done();
      return self;
    },
    end() {
      done();
      return self;
    },
    // cors 미들웨어(vary/cors 패키지)가 실제 ServerResponse 모양을 요구한다.
    // `cors: CORS_ORIGINS` 를 켜면서 필요해진 것들이다.
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      self.headers[name.toLowerCase()] = value;
      return self;
    },
    getHeader(name: string) {
      return self.headers[name.toLowerCase()];
    },
    getHeaders() {
      return self.headers;
    },
    removeHeader(name: string) {
      delete self.headers[name.toLowerCase()];
      return self;
    },
    writeHead(code: number) {
      captured.code = code;
      return self;
    },
    on(event: string, cb: () => void) {
      if (event === "finish") finish.push(cb);
      return self;
    },
    captured,
  };
  return self;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "u1",
    week_start_date: "2026-08-17",
    fcm_token: "tok",
    profile: SAMPLE.profile,
    prior_logs: [],
    ...overrides,
  };
}

/** 키를 통째로 뺀 요청. `{fcm_token: undefined}` 는 키가 남아 태스크 디코더가 걸린다. */
function bodyWithout(key: string) {
  const b = body() as Record<string, unknown>;
  delete b[key];
  return b;
}

type Handler = (req: unknown, response: unknown) => Promise<void>;
const AUTH = { authorization: "Bearer token-u1" };

const post = (payload: unknown, headers: Record<string, string> = AUTH) => ({
  method: "POST",
  body: payload,
  query: {},
  path: "/",
  headers,
});
const get = (jobId?: string, path = "/", headers: Record<string, string> = AUTH) => ({
  method: "GET",
  query: jobId ? { job_id: jobId } : {},
  path,
  headers,
});

beforeEach(() => {
  for (const bucket of collections.values()) bucket.clear();
  enqueued.length = 0;
  pushes.length = 0;
  enqueueFails = false;
  beforeTransaction = null;
  beforeQuery = null;
  delete process.env.SESSION_SECRET;
  delete process.env.TOSS_REWARDED_AD_GROUP_ID;
  delete process.env.TOSS_REWARDED_GENERATION_ENABLED;
});

describe("진행 초안 API — 저장·충돌·닫기", () => {
  const week = "2026-08-17";
  const path = `/v1/plans/${week}/progress/0`;
  const call = async (method: string, target = path, requestBody?: unknown) => {
    const response = res();
    await (plansGet as unknown as Handler)({ method, path: target, query: {}, body: requestBody, headers: AUTH }, response);
    return response.captured as { code: number; body: any };
  };

  it("완료 세션을 덮지 않고 초안 revision을 검증해 보관한다", async () => {
    const savedSession = { session_id: "existing", day_index: 0 };
    const weeks = store("weekly_plans/u1/weeks");
    weeks.set(week, { plan: { plan_meta: { plan_id: "u1-w1", generated_at: "new-generation" } }, sessions: { "0": savedSession } });
    const progress = { barbell_squat: [{ done: true, kg: "25", reps: "10" }] };
    const input = { plan_id: "u1-w1", plan_generated_at: "new-generation", base_revision: 0, progress };
    const written = await call("PUT", path, input);
    expect(written).toMatchObject({ code: 200, body: { draft: { revision: 1, progress } } });
    expect((await call("GET")).body.draft.progress).toEqual(progress);
    expect(await call("PUT", path, { ...input, progress: { barbell_squat: [{ done: true, kg: "999", reps: "1" }] } }))
      .toMatchObject({ code: 409, body: { code: "DRAFT_CONFLICT", draft: { revision: 1 } } });
    expect(weeks.get(week)?.progress_drafts).toMatchObject({ "0": { progress } });
    expect(await call("PUT", `${path}/close`)).toMatchObject({ code: 200, body: { status: "ok" } });
    expect(weeks.get(week)?.progress_drafts).toMatchObject({ "0": { revision: 2, closed: true, closed_reason: "session_completed", progress } });
    expect(weeks.get(week)?.sessions).toEqual({ "0": savedSession });
  });

  it("교체된 플랜의 옛 초안은 첫 새 입력 전에 별도 보관하고 오래된 플랜 쓰기를 거부한다", async () => {
    const old = { plan_id: "u1-w1", plan_generated_at: "old-generation", revision: 4,
      updated_at: "old", closed: true, closed_reason: "plan_replaced",
      progress: { barbell_squat: [{ done: true, kg: "45", reps: "5" }] } };
    const weeks = store("weekly_plans/u1/weeks");
    weeks.set(week, { plan: { plan_meta: { plan_id: "u1-w1", generated_at: "new-generation" } }, progress_drafts: { "0": old } });
    const input = { plan_id: "u1-w1", plan_generated_at: "new-generation", base_revision: 4,
      progress: { barbell_squat: [{ done: true, kg: "30", reps: "8" }] } };
    expect(await call("PUT", path, input)).toMatchObject({ code: 409, body: { code: "DRAFT_RETIRED" } });
    expect(await call("PUT", path, { ...input, plan_generated_at: "old-generation", start_after_retire: true }))
      .toMatchObject({ code: 409, body: { code: "PLAN_CHANGED" } });
    expect(weeks.get(week)?.progress_drafts).toEqual({ "0": old });
    expect(await call("PUT", path, { ...input, start_after_retire: true }))
      .toMatchObject({ code: 200, body: { draft: { revision: 5, progress: input.progress } } });
    const archives = weeks.get(week)?.progress_draft_archives as Record<string, unknown>;
    expect(Object.values(archives)).toEqual([old]);
    expect(weeks.get(week)?.progress_drafts).toMatchObject({ "0": { closed: false, revision: 5 } });
  });
});

describe("intake — POST /v1/plans:generate (contract §1)", () => {
  it("accepts a valid request with 202 queued + job_id", async () => {
    const r = res();
    await (plansGenerate as unknown as Handler)(post(body()), r);

    expect(r.captured.code).toBe(202);
    const out = r.captured.body as { status: string; job_id: string; poll_url: string };
    expect(out.status).toBe("queued");
    expect(out.job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.poll_url).toBe(`/v1/plans/${out.job_id}`);
    // Job persisted as `queued` with the TTL field set, and exactly one enqueue.
    const job = docs.get(out.job_id) as { status: string; expires_at: Date };
    expect(job.status).toBe("queued");
    // **Date 여야 한다** — 문자열이면 Firestore TTL 정책이 못 읽어 잡이 영원히 남는다.
    expect(job.expires_at).toBeInstanceOf(Date);
    expect(job.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(enqueued).toHaveLength(1);
  });

  it("blocks hard red flags with 200 blocked_red_flag, no job, no enqueue", async () => {
    const r = res();
    await (plansGenerate as unknown as Handler)(
      post(
        body({
          profile: { ...SAMPLE.profile, red_flags: { hard: ["chest_pain_on_exertion"], low_risk: [] } },
        }),
      ),
      r,
    );

    expect(r.captured.code).toBe(200);
    expect((r.captured.body as { status: string }).status).toBe("blocked_red_flag");
    expect(docs.size).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("ignores any bypass field a caller invents", async () => {
    const r = res();
    await (plansGenerate as unknown as Handler)(
      post(
        body({
          skip_red_flag_check: true,
          force: true,
          profile: { ...SAMPLE.profile, red_flags: { hard: ["pregnancy"], low_risk: [] } },
        }),
      ),
      r,
    );

    expect((r.captured.body as { status: string }).status).toBe("blocked_red_flag");
    expect(enqueued).toHaveLength(0);
  });

  it("rejects a request missing contract-required fields with 400", async () => {
    // profile 만 필수다. fcm_token 은 선택이 되었다 — 아래 테스트 참고.
    const payloads = [{}, bodyWithout("profile")];
    for (const payload of payloads) {
      const r = res();
      await (plansGenerate as unknown as Handler)(post(payload), r);
      expect(r.captured.code).toBe(400);
    }
  });

  it("accepts a request without fcm_token — 토스 미니앱은 FCM 을 못 쓴다", async () => {
    const r = res();
    await (plansGenerate as unknown as Handler)(post(bodyWithout("fcm_token")), r);
    expect(r.captured.code).toBe(202);

    const { job_id } = r.captured.body as { job_id: string };
    // Firestore 는 undefined 필드를 거부하므로 키 자체가 없어야 한다.
    expect(Object.keys(docs.get(job_id) ?? {})).not.toContain("fcm_token");
  });

  it("rejects a non-POST method with 405", async () => {
    const r = res();
    await (plansGenerate as unknown as Handler)({ method: "GET", body: {}, query: {}, path: "/", headers: AUTH }, r);
    expect(r.captured.code).toBe(405);
  });

  it("reports an enqueue failure as 503", async () => {
    enqueueFails = true;
    const r = res();
    await (plansGenerate as unknown as Handler)(post(body()), r);
    expect(r.captured.code).toBe(503);
  });

  it("rejects a week_start_date that is not YYYY-MM-DD (문서 id 가 된다)", async () => {
    for (const bad of ["", "2026-8-17", "../../etc", "2026-08-17/x"]) {
      const r = res();
      await (plansGenerate as unknown as Handler)(post(body({ week_start_date: bad })), r);
      expect(r.captured.code, bad).toBe(400);
      expect(enqueued, bad).toHaveLength(0);
    }
  });
});

describe("worker — plansWorker (contract §1 완료 + §3 푸시)", () => {
  /**
   * `plansWorker` is an HTTP endpoint behind Cloud Tasks, so it has to be driven
   * with the request shape the platform sends: POST, JSON, `{ data }`.
   * FUNCTIONS_EMULATOR skips the IAM bearer check the real queue supplies.
   */
  async function runWorker(
    payload: Record<string, unknown>,
    responses: unknown[],
    llmOpts: { failAll?: boolean; delayMs?: number; pipeline?: "p0" | "p1" | "auto" | "default" } = {},
  ) {
    const llm: FakeLlm = await startFakeLlm(responses, llmOpts);
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.LLM_PROVIDER = "minimax";
    process.env.LLM_API_KEY = "fake-key";
    process.env.LLM_BASE_URL = llm.baseUrl;
    process.env.LLM_MODEL = "fake-model";
    const previousPipeline = process.env.GENERATION_PIPELINE;
    if (llmOpts.pipeline === "default") delete process.env.GENERATION_PIPELINE;
    else process.env.GENERATION_PIPELINE = llmOpts.pipeline ?? "p0";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-cloudtasks-queuename": "plansWorker",
    };
    const req = {
      method: "POST",
      headers,
      body: { data: payload },
      header: (name: string) => headers[name.toLowerCase()],
    };
    const r = res();
    try {
      await (plansWorker as unknown as Handler)(req, r);
    } finally {
      if (previousPipeline === undefined) delete process.env.GENERATION_PIPELINE;
      else process.env.GENERATION_PIPELINE = previousPipeline;
      await llm.close();
    }
    return r;
  }

  // 실제 슬롯 응답을 로컬 HTTP 제공자에 싣는다. handler만 검사하지 않고
  // Cloud Task → 생성 → 저장 검사 → 정본 → GET 전체를 통과해야 한다.
  function slotDraft(req: GenerateRequest, acceptedAt: string) {
    return {
      slots: prepareGeneration(req, "auto", Date.parse(acceptedAt)).skeleton!.flatMap(day => day.slots.map(slot => ({
        slot: slot.key, exercise_id: slot.candidates[0], reason: "기본 동작으로 구성했어요",
      }))),
      week_note: "차근차근 진행해요",
    };
  }

  it.each(EVAL_PROFILES.filter(item => item.profile.environment === "full_gym"))(
    "P1 worker regression: default auto persists and serves $id",
    async item => {
      const acceptedAt = "2026-08-17T03:00:00.000Z";
      const req: GenerateRequest = {
        ...body(), profile: item.profile, prior_logs: item.priorLogs ?? [], week_number: item.weekNumber ?? 1,
      };
      docs.set("p1-job", { job_id: "p1-job", user_id: req.user_id, status: "queued", created_at: acceptedAt });
      const response = await runWorker({ jobId: "p1-job", req }, [slotDraft(req, acceptedAt)], { pipeline: "default" });
      expect(response.captured.code).toBe(204);
      const job = docs.get("p1-job")!;
      expect(job.status, String(job.message ?? "")).toBe("ok");
      expect(checkWeeklyPlan(job.plan).ok).toBe(true);
      expect(store("weekly_plans/u1/weeks").get(req.week_start_date)?.plan).toEqual(job.plan);
      const read = res();
      await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/current"), read);
      expect(read.captured).toMatchObject({ code: 200, body: { status: "ok", plan: job.plan } });
    },
  );

  it.each([
    ["2026-08-20T03:00:00.000Z", "2026-08-21T03:00:00.000Z", 3],
    ["2026-08-23T14:59:59.000Z", "2026-08-23T15:00:01.000Z", 6],
  ])("P1 worker regression: accepted %s remains authoritative when worker runs %s", async (acceptedAt, ranAt, firstDay) => {
    const req: GenerateRequest = {
      ...body(), profile: { ...SAMPLE.profile, split_pref: "body_part_3" },
      recent_exercise_ids: ["leverage_chest_press"],
      completed_this_week: [{ day_index: 0, exercise_ids: ["leg_press"] }],
    };
    docs.set("p1-late", { job_id: "p1-late", user_id: req.user_id, status: "queued", created_at: acceptedAt });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(ranAt));
    try {
      await runWorker({ jobId: "p1-late", req }, [slotDraft(req, acceptedAt)], { pipeline: "auto" });
    } finally { clock.mockRestore(); }
    const job = docs.get("p1-late")!;
    expect(job.status, String(job.message ?? "")).toBe("ok");
    const plan = job.plan as { week: Array<{ day_index: number }>; plan_meta: { days_per_week: number } };
    expect(plan.week.length).toBeGreaterThan(0);
    expect(plan.week.every(day => day.day_index >= firstDay)).toBe(true);
    expect(Math.min(...plan.week.map(day => day.day_index))).toBe(firstDay);
    expect(plan.plan_meta.days_per_week).toBe(req.profile.days_per_week);
    expect(store("weekly_plans/u1/weeks").get(req.week_start_date)?.plan).toEqual(plan);
  });

  it("P1 worker regression: Toss intake commits the reserved generation and preserves completed records", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-19T03:00:00.000Z"));
    try {
      const uid = "toss:p1-regression", version = "v1", secret = "p1-fixture-secret";
      process.env.SESSION_SECRET = secret;
      process.env.TOSS_REWARDED_GENERATION_ENABLED = "true";
      process.env.TOSS_REWARDED_AD_GROUP_ID = "fixture-group";
      store("account_lifecycle").set(accountKey(uid), { version });
      const headers = { authorization: `Bearer ${mintSession(uid, secret, Date.now(), version)}` };
      const weeks = store(`weekly_plans/${uid}/weeks`);
      const completed = { session_id: "already-done", day_index: 0 };
      const initial = expandDraftToWeeklyPlan({
        draft: CASES[SAMPLE.id]!.draft, profile: SAMPLE.profile, userId: uid,
        weekStartDate: "2026-08-17", weekNumber: 1, priorLogs: [], disclaimer: "fixture",
      });
      const completedDay = (initial.plan as { week: Array<{ day_index: number }> }).week.find(day => day.day_index === 0)!;
      expect(completedDay).toBeDefined();
      weeks.set("2026-08-17", { plan: initial.plan, draft: initial.draft, sessions: { "0": completed } });
      const intake = res();
      await (plansGenerate as unknown as Handler)(post(bodyWithout("fcm_token"), headers), intake);
      expect(intake.captured.code).toBe(202);
      const payload = enqueued[0] as { jobId: string; req: GenerateRequest };
      const acceptedAt = String(docs.get(payload.jobId)!.created_at);
      await runWorker(payload, [slotDraft(payload.req, acceptedAt)], { pipeline: "default" });
      expect(docs.get(payload.jobId)?.status).toBe("ok");
      expect(weeks.get("2026-08-17")).toMatchObject({ sessions: { "0": completed } });
      const saved = weeks.get("2026-08-17")!.plan as { week: Array<{ day_index: number }> };
      expect(saved.week.find(day => day.day_index === 0)).toEqual(completedDay);
      expect(store("generation_access").get(uid)).toMatchObject({ active: null, free_week: generationWeek(Date.now()).week });
      const read = res();
      await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/current", headers), read);
      expect(read.captured).toMatchObject({ code: 200, body: { status: "ok", plan: saved } });
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ["full_gym", "not_a_catalogue_exercise"],
    ["full_gym", "goblet_squat"],
    ["bodyweight_only", "barbell_squat"],
  ] as const)("P1 worker regression: save guard rejects %s / %s", async (environment, exerciseId) => {
    const req = body({ profile: { ...SAMPLE.profile, environment, ...(environment === "bodyweight_only" ? { equipment: [] } : {}) } });
    docs.set("p1-invalid", { job_id: "p1-invalid", user_id: req.user_id, status: "queued" });
    const forged = vi.spyOn(generationHandler, "generatePlan").mockResolvedValue({
      status: "ok", plan: { week: [{ exercises: [{ exercise_id: exerciseId }] }] },
    });
    try {
      await runWorker({ jobId: "p1-invalid", req }, [], { pipeline: "default" });
    } finally { forged.mockRestore(); }
    expect(docs.get("p1-invalid")).toMatchObject({ status: "error", message: expect.stringContaining("저장하지 않았습니다") });
    expect(store("weekly_plans/u1/weeks").size).toBe(0);
  });

  it("transitions the job to ok with a schema-valid plan and pushes once", async () => {
    docs.set("job-1", { job_id: "job-1", user_id: "u1", status: "queued" });
    const r = await runWorker({ jobId: "job-1", req: body() }, [CASES[SAMPLE.id]!.draft]);
    expect(r.captured.code).toBe(204); // the task is acked, never re-enqueued

    const job = docs.get("job-1") as { status: string; plan: unknown };
    expect(job.status).toBe("ok");
    expect(checkWeeklyPlan(job.plan).ok).toBe(true);
    // 플랜 정본도 함께 남는다(D19) — 잡은 TTL 로 사라진다.
    expect(store("weekly_plans/u1/weeks").get("2026-08-17")).toMatchObject({
      user_id: "u1",
      week_start_date: "2026-08-17",
      plan: job.plan,
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      token: "tok",
      data: { type: "plan_generated", job_id: "job-1", status: "ok" },
    });
  }, 30_000);

  // D80 · codex N2 R1: 「오늘」은 워커 실행 시각이 아니라 접수 시각(`created_at`)이다.
  it("T2-9 접수 목요일(KST) 잡은 늦게 돌아도 목~일에만 운동을 놓는다", async () => {
    docs.set("job-thu", { job_id: "job-thu", user_id: "u1", status: "queued", created_at: "2026-08-20T01:00:00.000Z" });
    await runWorker({ jobId: "job-thu", req: body() }, [CASES[SAMPLE.id]!.draft]);
    const job = docs.get("job-thu") as { status: string; plan: { week: Array<{ day_index: number }> } };
    expect(job.status).toBe("ok");
    expect(job.plan.week.length).toBeGreaterThan(0);
    expect(job.plan.week.every((d) => d.day_index >= 3)).toBe(true);
  }, 30_000);

  it("토큰이 없으면 완료 푸시를 보내지 않는다 (폴링 전용 클라이언트)", async () => {
    docs.set("job-nopush", { job_id: "job-nopush", user_id: "u1", status: "queued" });
    pushes.length = 0;
    await runWorker(
      { jobId: "job-nopush", req: bodyWithout("fcm_token") },
      [CASES[SAMPLE.id]!.draft],
    );

    expect((docs.get("job-nopush") as { status: string }).status).toBe("ok");
    expect(pushes).toHaveLength(0); // 보낼 곳이 없으므로 발송 시도 자체가 없다
  }, 30_000);

  it("records an unrecoverable failure as status=error and still pushes", async () => {
    docs.set("job-2", { job_id: "job-2", user_id: "u1", status: "queued" });
    // A draft that passes nothing: repair retries exhaust, so the job must error.
    await runWorker({ jobId: "job-2", req: body() }, [{ schema_version: "1.0", split_type: "nope" }]);

    const job = docs.get("job-2") as { status: string; plan?: unknown; message: string };
    expect(job.status).toBe("error");
    expect(job.plan).toBeUndefined();
    expect(job.message).toBeTruthy();
    expect(pushes[0]).toMatchObject({ data: { status: "error" } });
  }, 30_000);

  it("ends an over-budget job as error + failure push instead of leaving it running", async () => {
    // The platform kill at `timeoutSeconds` runs none of our code, so the worker
    // stops itself `DEADLINE_MARGIN_SEC` early, never sooner than 5s. With
    // WORKER_TIMEOUT_SEC=16 the deadline is that 5s floor; the host answers at 6s.
    docs.set("job-5", { job_id: "job-5", user_id: "u1", status: "queued" });
    process.env.WORKER_TIMEOUT_SEC = "16";
    try {
      await runWorker({ jobId: "job-5", req: body() }, [CASES[SAMPLE.id]!.draft], { delayMs: 6_000 });
    } finally {
      delete process.env.WORKER_TIMEOUT_SEC;
    }

    const job = docs.get("job-5") as { status: string; plan?: unknown; message: string };
    expect(job.status).toBe("error");
    expect(job.plan).toBeUndefined();
    expect(job.message).toContain("제한 시간");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ data: { status: "error" } });
  }, 30_000);

  it("derives the deadline from the timeout it actually declares", () => {
    // The 6s test above can only exercise the floor; this pins the deployed
    // arithmetic (540s → 525s) and the clamp that keeps a misconfigured
    // WORKER_TIMEOUT_SEC from pushing the deadline past the platform's kill.
    const endpoint = (plansWorker as unknown as { __endpoint: { timeoutSeconds: number } }).__endpoint;
    expect(endpoint.timeoutSeconds).toBe(540);
    expect(workerDeadlineMs(endpoint.timeoutSeconds)).toBe(525_000);
    expect(workerDeadlineMs(600)).toBe(525_000); // clamped to the declared timeout
    expect(workerDeadlineMs(16)).toBe(5_000); // floor
  });
});

describe("fetch — GET /v1/plans/{job_id} (contract §2)", () => {
  it("returns the plan only once the job is ok", async () => {
    docs.set("job-3", { job_id: "job-3", user_id: "u1", status: "queued", warnings: [] });
    const queued = res();
    await (plansGet as unknown as Handler)(get("job-3"), queued);
    expect(queued.captured.code).toBe(200);
    expect(queued.captured.body).toMatchObject({ status: "queued" });
    expect((queued.captured.body as { plan?: unknown }).plan).toBeUndefined();

    docs.set("job-3", { job_id: "job-3", user_id: "u1", status: "ok", plan: { a: 1 }, warnings: [] });
    const done = res();
    await (plansGet as unknown as Handler)(get("job-3"), done);
    expect((done.captured.body as { plan: unknown }).plan).toEqual({ a: 1 });
  });

  it("reads the job id from the path when there is no query param", async () => {
    docs.set("job-4", { job_id: "job-4", user_id: "u1", status: "running" });
    const r = res();
    await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/job-4"), r);
    expect(r.captured.body).toMatchObject({ status: "running" });
  });

  it("returns 404 for an unknown or TTL-expired job", async () => {
    const r = res();
    await (plansGet as unknown as Handler)(get("gone"), r);
    expect(r.captured.code).toBe(404);
  });

  it("rejects a non-GET method with 405", async () => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "POST", query: {}, path: "/", headers: AUTH }, r);
    expect(r.captured.code).toBe(405);
  });
});

describe("fetch — GET /v1/plans/current (D19 플랜 정본)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const current = async () => {
    const r = res();
    await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/current"), r);
    return r.captured;
  };

  it("returns the caller's saved plan without a job id", async () => {
    weeksOf("u1").set("2026-08-17", { user_id: "u1", week_start_date: "2026-08-17", plan: { a: 1 } });
    const r = await current();
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ status: "ok", plan: { a: 1 }, week_start_date: "2026-08-17" });
  });

  it("keeps past weeks and serves the newest (주차별 이력)", async () => {
    weeksOf("u1").set("2026-08-10", { user_id: "u1", week_start_date: "2026-08-10", plan: { week: 1 } });
    weeksOf("u1").set("2026-08-17", { user_id: "u1", week_start_date: "2026-08-17", plan: { week: 2 } });
    const r = await current();
    expect(r.body).toMatchObject({ plan: { week: 2 }, week_start_date: "2026-08-17" });
    // 지난 주가 살아 있다 — 덮어쓰기였다면 여기서 죽는다.
    expect(weeksOf("u1").get("2026-08-10")).toMatchObject({ plan: { week: 1 } });
  });

  it("serves one past week by date, and 404s for a week never generated", async () => {
    weeksOf("u1").set("2026-08-10", { user_id: "u1", week_start_date: "2026-08-10", plan: { week: 1 } });
    const hit = res();
    await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/2026-08-10"), hit);
    expect(hit.captured.body).toMatchObject({ status: "ok", plan: { week: 1 } });

    const miss = res();
    await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/2026-07-06"), miss);
    expect(miss.captured.code).toBe(404);
  });

  it("returns 404 when nothing is saved yet — a new user, not an error", async () => {
    expect((await current()).code).toBe(404);
  });

  it("never serves another user's plan (하위 컬렉션이 uid 로 갈린다)", async () => {
    weeksOf("u2").set("2026-08-17", { user_id: "u2", week_start_date: "2026-08-17", plan: { secret: true } });
    expect((await current()).code).toBe(404); // 토큰은 u1 이다
  });
});

describe("intake latency (T5.3 / S-GEN-13: p95 ≤ 2s)", () => {
  it("answers 202 in code time, leaving the budget to the network legs", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      // A fresh uid per iteration: we are timing intake, not the weekly quota.
      const headers = { authorization: `Bearer token-perf-${i}` };
      const r = res();
      const started = performance.now();
      await (plansGenerate as unknown as Handler)(post(body(), headers), r);
      samples.push(performance.now() - started);
      expect(r.captured.code).toBe(202);
    }
    samples.sort((a, b) => a - b);
    const measured = samples[Math.ceil(0.95 * samples.length) - 1]!;
    // eslint-disable-next-line no-console
    console.log(`[perf] intake handler p95 = ${measured.toFixed(2)}ms (n=${samples.length})`);
    // Firestore write + Cloud Tasks enqueue are doubles here, so this is our own
    // parse → gate → respond cost. The real RTT is measured after the G2 deploy.
    expect(measured).toBeLessThan(50);
  }, 30_000);
});

describe("caller authentication (T5.5)", () => {
  const anonymous = { authorization: "" };

  it("refuses an unauthenticated generate with 401 and no side effects", async () => {
    for (const headers of [anonymous, { authorization: "Bearer forged" }, { authorization: "token-u1" }]) {
      const r = res();
      await (plansGenerate as unknown as Handler)(post(body(), headers), r);
      expect(r.captured.code).toBe(401);
      expect(docs.size).toBe(0);
      expect(enqueued).toHaveLength(0);
    }
  });

  it("refuses an unauthenticated fetch with 401", async () => {
    docs.set("job-9", { job_id: "job-9", user_id: "u1", status: "ok", plan: { a: 1 } });
    const r = res();
    await (plansGet as unknown as Handler)(get("job-9", "/", anonymous), r);
    expect(r.captured.code).toBe(401);
    expect(r.captured.body).not.toMatchObject({ plan: { a: 1 } });
  });

  it("supports_circuits 는 true 일 때만 워커로 넘어간다 (T10d-2)", async () => {
    for (const [sent, expected] of [[true, true], ["yes", undefined], [undefined, undefined]] as const) {
      enqueued.length = 0;
      const r = res();
      await (plansGenerate as unknown as Handler)(post(body(sent === undefined ? {} : { supports_circuits: sent })), r);
      expect(r.captured.code).toBe(202);
      expect((enqueued[0] as { req: { supports_circuits?: boolean } }).req.supports_circuits, String(sent)).toBe(expected);
    }
  });

  it("takes the user id from the token, not the body", async () => {
    const r = res();
    await (plansGenerate as unknown as Handler)(post(body({ user_id: "someone-else" })), r);

    const { job_id } = r.captured.body as { job_id: string };
    expect((docs.get(job_id) as { user_id: string }).user_id).toBe("u1");
    expect((enqueued[0] as { req: { user_id: string } }).req.user_id).toBe("u1");
  });

  it("hides another user's job behind a 404", async () => {
    docs.set("job-8", { job_id: "job-8", user_id: "someone-else", status: "ok", plan: { secret: true } });
    const r = res();
    await (plansGet as unknown as Handler)(get("job-8"), r);

    // 404 rather than 403: the existence of a job id is itself information.
    expect(r.captured.code).toBe(404);
    expect(JSON.stringify(r.captured.body)).not.toContain("secret");
  });
});

describe("weekly generation quota (429 — 계약 §오류 코드)", () => {
  it("allows the weekly allowance and refuses the next one with 429", async () => {
    for (let i = 0; i < WEEKLY_GENERATION_LIMIT; i++) {
      const r = res();
      await (plansGenerate as unknown as Handler)(post(body()), r);
      expect(r.captured.code, `attempt ${i + 1}`).toBe(202);
    }

    const blocked = res();
    await (plansGenerate as unknown as Handler)(post(body()), blocked);
    expect(blocked.captured.code).toBe(429);
    expect((blocked.captured.body as { message: string }).message).toMatch(/한도/);
    // The refused attempt must cost nothing: no job, no task, no LLM call.
    expect(docs.size).toBe(WEEKLY_GENERATION_LIMIT);
    expect(enqueued).toHaveLength(WEEKLY_GENERATION_LIMIT);
  });

  it("counts per user, not globally", async () => {
    for (let i = 0; i < WEEKLY_GENERATION_LIMIT; i++) {
      await (plansGenerate as unknown as Handler)(post(body()), res());
    }
    const other = res();
    await (plansGenerate as unknown as Handler)(post(body(), { authorization: "Bearer token-u2" }), other);
    expect(other.captured.code).toBe(202);
  });

  it("does not spend the allowance on a blocked red flag", async () => {
    const blockedProfile = {
      profile: { ...SAMPLE.profile, red_flags: { hard: ["pregnancy"], low_risk: [] } },
    };
    for (let i = 0; i < WEEKLY_GENERATION_LIMIT + 2; i++) {
      const r = res();
      await (plansGenerate as unknown as Handler)(post(body(blockedProfile)), r);
      expect(r.captured.code).toBe(200);
    }
    // Still fully entitled afterwards.
    const r = res();
    await (plansGenerate as unknown as Handler)(post(body()), r);
    expect(r.captured.code).toBe(202);
  });
});

describe("edit — PUT /v1/plans/current (계약 §2.2 · 백로그 016)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";
  const DRAFT = CASES[SAMPLE.id]!.draft as { week: Array<{ day_index: number; items: Array<{ exercise_id?: string }> }> };

  /** 워커가 남기는 것과 같은 모양으로 정본을 심는다(플랜·드래프트·프로필). */
  function seed(uid = "u1", extra: Record<string, unknown> = {}) {
    weeksOf(uid).set(WEEK, {
      user_id: uid,
      week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1 }, week: [] },
      draft: structuredClone(DRAFT),
      profile: SAMPLE.profile,
      ...extra,
    });
  }

  const put = async (payload: unknown, path = `/v1/plans/current`, headers = AUTH) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", body: payload, query: {}, path, headers }, r);
    return r.captured;
  };

  /** 편집된 플랜에서 그 요일의 근력 종목 id 들. */
  const idsOn = (plan: unknown, dayIndex: number) =>
    (((plan as { week?: Array<{ day_index: number; exercises: Array<{ exercise_id: string }> }> }).week ?? [])
      .find((d) => d.day_index === dayIndex)?.exercises ?? []).map((e) => e.exercise_id);

  it("추가 — 종목이 들어가고, 수치는 코드가 채우고, 정본이 갱신된다", async () => {
    seed();
    const out = await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" });

    expect(out.code).toBe(200);
    const plan = (out.body as { plan: unknown }).plan;
    expect(idsOn(plan, 0)).toContain("dumbbell_bicep_curl");
    // INV-1: 클라이언트가 수치를 보낸 적 없는데 세트가 붙어 있고 스키마를 통과한다.
    expect(checkWeeklyPlan(plan).ok).toBe(true);
    const added = (plan as { week: Array<{ day_index: number; exercises: Array<{ exercise_id: string; sets: unknown[] }> }> })
      .week.find((d) => d.day_index === 0)!.exercises.find((e) => e.exercise_id === "dumbbell_bicep_curl")!;
    expect(added.sets.length).toBeGreaterThan(0);
    // 정본에 플랜과 드래프트가 같이 갱신된다 — 다음 편집의 입력이 드래프트다.
    const stored = weeksOf("u1").get(WEEK) as { plan: unknown; draft: typeof DRAFT; edited_at: string };
    expect(stored.plan).toEqual(plan);
    expect(stored.draft.week[0]!.items.some((i) => i.exercise_id === "dumbbell_bicep_curl")).toBe(true);
    expect(Date.parse(stored.edited_at)).toBeLessThanOrEqual(Date.now());
  });

  it("삭제 — 그 종목만 빠지고 나머지는 남는다", async () => {
    seed();
    const before = DRAFT.week[0]!.items.filter((i) => i.exercise_id).map((i) => i.exercise_id!);
    const out = await put({ op: "remove", day_index: 0, exercise_id: "barbell_squat" });

    expect(out.code).toBe(200);
    const ids = idsOn((out.body as { plan: unknown }).plan, 0);
    expect(ids).not.toContain("barbell_squat");
    for (const kept of before.filter((id) => id !== "barbell_squat")) expect(ids).toContain(kept);
  });

  it("교체 — 같은 자리에 다른 종목이 온다", async () => {
    seed();
    const out = await put({
      op: "replace",
      day_index: 0,
      exercise_id: "barbell_squat",
      to_exercise_id: "dumbbell_squat",
    });

    expect(out.code).toBe(200);
    const ids = idsOn((out.body as { plan: unknown }).plan, 0);
    expect(ids).toContain("dumbbell_squat");
    expect(ids).not.toContain("barbell_squat");
    expect(checkWeeklyPlan((out.body as { plan: unknown }).plan).ok).toBe(true);
  });

  it("수정 — 세트 수·무게를 사용자가 정하고, 되돌릴 수 있다", async () => {
    seed();
    const working = (plan: unknown) =>
      (plan as { week: Array<{ day_index: number; exercises: Array<{ exercise_id: string; sets: Array<{ set_kind: string; target_load_kg: number | null }> }> }> })
        .week.find((d) => d.day_index === 0)!.exercises.find((e) => e.exercise_id === "barbell_squat")!
        .sets.filter((set) => set.set_kind === "working");

    const out = await put({ op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: 5, load_kg: 62.4 });
    expect(out.code).toBe(200);
    const tuned = working((out.body as { plan: unknown }).plan);
    expect(tuned).toHaveLength(5);
    expect(tuned.every((set) => set.target_load_kg === 62.5)).toBe(true); // 0.5kg 단위로 맞춘다
    expect(checkWeeklyPlan((out.body as { plan: unknown }).plan).ok).toBe(true);

    // 값은 드래프트에 남는다 — 다른 편집으로 재확장해도 살아남는다.
    const after = await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" });
    expect(after.code).toBe(200);
    expect(working((after.body as { plan: unknown }).plan)).toHaveLength(5);

    // null 이면 코드가 계산한 값으로 되돌아간다.
    const reset = await put({ op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: null, load_kg: null });
    expect(reset.code).toBe(200);
    expect(working((reset.body as { plan: unknown }).plan).length).toBeLessThan(5);
  });

  it("수정 — 범위 밖 값과 빈 본문은 400", async () => {
    seed();
    for (const payload of [
      { op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: 11 },
      { op: "tune", day_index: 0, exercise_id: "barbell_squat", load_kg: -1 },
      { op: "tune", day_index: 0, exercise_id: "barbell_squat" },
      { op: "tune", day_index: 0, sets: 3 },
    ]) {
      expect((await put(payload)).code).toBe(400);
    }
  });

  it("편집은 주간 생성 한도를 소모하지 않는다", async () => {
    seed();
    await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" });
    // 한도 카운터는 `plansGenerate` 만 건드린다 — 편집 뒤에도 비어 있어야 한다.
    for (const [name, bucket] of collections) {
      if (name.includes("quota") || name.includes("rate")) expect(bucket.size).toBe(0);
    }
    expect(enqueued).toHaveLength(0); // LLM 도 부르지 않는다
  });

  it("카탈로그에 없는 운동은 400 (조용히 사라지지 않는다)", async () => {
    seed();
    const out = await put({ op: "add", day_index: 0, to_exercise_id: "nonexistent_lift_9000" });
    expect(out.code).toBe(400);
  });

  it("op·day_index 가 계약 밖이면 400", async () => {
    seed();
    expect((await put({ op: "frobnicate", day_index: 0, to_exercise_id: "dumbbell_squat" })).code).toBe(400);
    expect((await put({ op: "add", day_index: 9, to_exercise_id: "dumbbell_squat" })).code).toBe(400);
  });

  it("드래프트 없는 옛 플랜은 409 — 조용히 실패하지 않는다", async () => {
    weeksOf("u1").set(WEEK, { user_id: "u1", week_start_date: WEEK, plan: { week: [] } });
    const out = await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_squat" });
    expect(out.code).toBe(409);
  });

  it("저장된 플랜이 없으면 404", async () => {
    expect((await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_squat" })).code).toBe(404);
  });

  it("남의 플랜은 편집되지 않는다", async () => {
    seed("u2");
    const out = await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_squat" });
    expect(out.code).toBe(404); // 토큰은 u1 이다
    expect((weeksOf("u2").get(WEEK) as { edited_at?: string }).edited_at).toBeUndefined();
  });

  it("후보 — 그 날에 이미 있는 종목은 주지 않는다", async () => {
    seed();
    // 후보는 저장된 플랜의 그 날 종목을 보고 거른다.
    const added = await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" });
    expect(added.code).toBe(200);

    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "GET", query: { day_index: "0" }, path: "/v1/plans/current/candidates", headers: AUTH },
      r,
    );
    expect(r.captured.code).toBe(200);
    const { candidates } = r.captured.body as { candidates: Array<{ id: string; name_ko: string }> };
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((c) => c.id)).not.toContain("dumbbell_bicep_curl");
    expect(candidates.every((c) => c.name_ko.length > 0)).toBe(true);
  });
});

/** 옛 플랜(D45 ① 이전)의 휴식일 1 사이클링을 확장에서만 재현한다 — 저장 드래프트에는 넣지 않는다(백로그 079). */
const LEGACY_REST_CARDIO = (draft: unknown) => {
  const d = structuredClone(draft) as { week: Array<Record<string, unknown>> };
  d.week = [...d.week.filter((x) => x.day_index !== 1), { day_index: 1, session_type: "rest", focus: "", items: [], cardio_override: { exercise_id: "bicycling_stationary" } }];
  return d;
};

describe("edit — 유산소 줄 (계약 §2.2 · 백로그 030 §1.1 · D45 ④)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";
  const DRAFT = CASES[SAMPLE.id]!.draft;
  type Row = { exercise_id: string; modality: string; cardio_detail?: { modality: string; style: string; duration_min: number; intensity_zone: string; placement: string } };
  type Plan = { week: Array<{ day_index: number; exercises: Row[] }> };

  // SAMPLE(주 2일·maintain_health): 0·3 무거운 하체일 + 사이클링(separate_session) · 1 휴식일 사이클링 · 2·4·5·6 빈 날.
  // **1 휴식일 사이클링은 D45 ① 이전 생성이 남긴 옛 플랜의 모양이다**(백로그 078·079) — 지금 확장기는 휴식일에 놓지 않으므로
  // 확장 때만 그 날 결정을 얹고, 저장 드래프트에는 결정이 없다. 편집 입구의 `pinRestDayCardio` 가 그 줄을 결정으로 고정한다.
  function seed() {
    const { plan } = expandDraftToWeeklyPlan({
      draft: LEGACY_REST_CARDIO(DRAFT), profile: SAMPLE.profile, userId: "u1", weekStartDate: WEEK, weekNumber: 1, priorLogs: [], disclaimer: "d",
    });
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK, plan, draft: structuredClone(DRAFT), profile: SAMPLE.profile,
    });
  }
  const put = async (payload: unknown) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", body: payload, query: {}, path: "/v1/plans/current", headers: AUTH }, r);
    const plan = (r.captured.body as { plan?: Plan }).plan;
    if (plan) expect(checkWeeklyPlan(plan).ok).toBe(true); // T1-9
    return { code: r.captured.code, plan: plan! };
  };
  const cardioOn = (plan: Plan, day: number) =>
    (plan.week.find((d) => d.day_index === day)?.exercises ?? []).filter((e) => e.modality === "cardio");
  const cardioCount = (plan: Plan) => plan.week.flatMap((d) => d.exercises).filter((e) => e.modality === "cardio").length;

  it("빼기 — 그 날 유산소만 사라지고, 다른 편집 뒤에도 되살아나지 않고, 다른 날로 옮겨 가지 않는다", async () => {
    seed();
    const out = await put({ op: "remove", day_index: 1, exercise_id: "bicycling_stationary" });
    expect(out.code).toBe(200);
    expect(cardioOn(out.plan, 1)).toHaveLength(0);
    expect(cardioCount(out.plan)).toBe(2); // 3 → 2, 빈 날(2·4·5·6)에 새로 놓이지 않는다
    const again = await put({ op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: 4 });
    expect(cardioOn(again.plan, 1)).toHaveLength(0);
    expect(cardioCount(again.plan)).toBe(2);
  });

  it("바꾸기 — 고른 모달리티가 필터 없이 들어가고, 분·존·스타일·배치는 코드 값 그대로다", async () => {
    seed();
    const rowing = await put({ op: "replace", day_index: 0, exercise_id: "bicycling_stationary", to_exercise_id: "rowing_stationary" });
    expect(rowing.code).toBe(200);
    const [row] = cardioOn(rowing.plan, 0);
    expect(row!.exercise_id).toBe("rowing_stationary");
    expect(row!.cardio_detail).toMatchObject({ modality: "rowing", style: "LISS", duration_min: 30, intensity_zone: "Zone 2 (최대심박 60–70%)", placement: "separate_session" });
    // 러닝은 생성이 고르지 않지만(`chooseModality`) 사용자가 고르면 들어간다.
    const running = await put({ op: "replace", day_index: 1, exercise_id: "bicycling_stationary", to_exercise_id: "running_treadmill" });
    expect(cardioOn(running.plan, 1)[0]!.cardio_detail!.modality).toBe("running");
    expect(cardioOn(running.plan, 0)[0]!.cardio_detail!.modality).toBe("rowing"); // 앞 결정이 남는다
  });

  it("넣기 — 유산소 없는 날에 LISS 1회(도스 분), 휴식일에도 된다, 이미 있으면 400", async () => {
    seed();
    await put({ op: "remove", day_index: 0, exercise_id: "bicycling_stationary" });
    const back = await put({ op: "add", day_index: 0, to_exercise_id: "elliptical_trainer" });
    expect(back.code).toBe(200);
    expect(cardioOn(back.plan, 0)[0]!.cardio_detail).toMatchObject({ modality: "elliptical", duration_min: 30, placement: "separate_session" });
    const rest = await put({ op: "add", day_index: 5, to_exercise_id: "walking_treadmill" });
    expect(rest.code).toBe(200);
    expect(cardioOn(rest.plan, 5)[0]!.cardio_detail).toMatchObject({ modality: "incline_walk", style: "LISS", placement: "rest_day" });
    expect((await put({ op: "add", day_index: 0, to_exercise_id: "rowing_stationary" })).code).toBe(400);
  });

  it("교차 replace 는 빼고 넣기다 — 유산소 자리에 근력, 근력 자리에 유산소", async () => {
    seed();
    const toLift = await put({ op: "replace", day_index: 0, exercise_id: "bicycling_stationary", to_exercise_id: "dumbbell_squat" });
    expect(toLift.code).toBe(200);
    expect(cardioOn(toLift.plan, 0)).toHaveLength(0);
    expect(toLift.plan.week.find((d) => d.day_index === 0)!.exercises.some((e) => e.exercise_id === "dumbbell_squat")).toBe(true);
    const toCardio = await put({ op: "replace", day_index: 0, exercise_id: "barbell_squat", to_exercise_id: "rowing_stationary" });
    expect(toCardio.code).toBe(200);
    expect(cardioOn(toCardio.plan, 0)[0]!.exercise_id).toBe("rowing_stationary");
    expect(toCardio.plan.week.find((d) => d.day_index === 0)!.exercises.some((e) => e.exercise_id === "barbell_squat")).toBe(false);
  });

  it("없는 줄은 400", async () => {
    seed();
    expect((await put({ op: "remove", day_index: 2, exercise_id: "bicycling_stationary" })).code).toBe(400);
    expect((await put({ op: "tune", day_index: 0, exercise_id: "bicycling_stationary", sets: 3 })).code).toBe(400); // INV-1
  });

  // 백로그 079: 옛 플랜의 휴식일 AI 유산소를 옮기면 제자리에 남았다(드래프트에 옮길 것이 없었다).
  it("T1-4·T1-5·T1-6 옛 플랜의 유산소만 있는 날이 옮겨지고, 다른 편집에도 남고, 근력일 유산소는 고정하지 않는다", async () => {
    seed();
    const moved = await put({ op: "move", day_index: 1, to_day_index: 4, mode: "swap" });
    expect(moved.code).toBe(200);
    expect(cardioOn(moved.plan, 4).map((e) => e.exercise_id)).toEqual(["bicycling_stationary"]);
    expect(cardioOn(moved.plan, 1)).toHaveLength(0);
    seed();
    const kept = await put({ op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: 4 });
    expect(cardioOn(kept.plan, 1)).toHaveLength(1);
    const draft = weeksOf("u1").get(WEEK)!.draft as { week: Array<{ day_index: number; cardio_override?: unknown }> };
    expect(draft.week.find((d) => d.day_index === 1)!.cardio_override).toEqual({ exercise_id: "bicycling_stationary" }); // LISS 는 id 만 — 목표로 고정하면 직전 주 기록 복사가 막힌다(codex N1 R2)
    expect(draft.week.filter((d) => d.day_index === 0 || d.day_index === 3).every((d) => d.cardio_override === undefined)).toBe(true);
  });

  // codex N1 R1: id 만 고정하면 옛 휴식일 HIIT 가 도스 LISS 로 바뀌고, 금기로 빠진 종목이 드래프트에 남은 날은 고정을 건너뛰었다.
  it("T1-7 옛 휴식일 HIIT 는 방식·시간 그대로 남고, 드래프트에 확장이 버린 종목이 남은 날도 고정된다", async () => {
    const legacy = (day1: Record<string, unknown>) => {
      const d = structuredClone(DRAFT) as { week: Array<Record<string, unknown>> };
      d.week = [...d.week.filter((x) => x.day_index !== 1), { day_index: 1, focus: "", ...day1 }];
      const { plan } = expandDraftToWeeklyPlan({ draft: d, profile: SAMPLE.profile, userId: "u1", weekStartDate: WEEK, weekNumber: 1, priorLogs: [], disclaimer: "d" });
      const stored = structuredClone(d);
      delete stored.week.find((x) => x.day_index === 1)!.cardio_override;
      weeksOf("u1").set(WEEK, { user_id: "u1", week_start_date: WEEK, plan, draft: stored, profile: SAMPLE.profile });
    };
    legacy({ session_type: "rest", items: [], cardio_override: { exercise_id: "rowing_stationary", target: { style: "HIIT", duration_min: 18 } } });
    const hiit = await put({ op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: 4 });
    expect(cardioOn(hiit.plan, 1)[0]!.cardio_detail).toMatchObject({ style: "HIIT", duration_min: 18 });
    legacy({ session_type: "lift", items: [{ kind: "strength", exercise_id: "no_such_exercise", role: "primary", order: 1, rep_intent: "hypertrophy" }], cardio_override: { exercise_id: "rowing_stationary" } });
    expect(weeksOf("u1").get(WEEK)!.plan.week.find((d: { day_index: number }) => d.day_index === 1).exercises.every((e: { modality: string }) => e.modality === "cardio")).toBe(true);
    const kept = await put({ op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: 4 });
    expect(cardioOn(kept.plan, 1).map((e) => e.exercise_id)).toEqual(["rowing_stationary"]);
  });

  it("요일 이동 — 유산소 결정이 그 날 운동을 따라간다", async () => {
    seed();
    await put({ op: "replace", day_index: 0, exercise_id: "bicycling_stationary", to_exercise_id: "rowing_stationary" });
    const moved = await put({ op: "move", day_index: 0, to_day_index: 2, mode: "swap" });
    expect(moved.code).toBe(200);
    expect(cardioOn(moved.plan, 2)[0]!.cardio_detail!.modality).toBe("rowing");
    expect(cardioOn(moved.plan, 0).every((e) => e.cardio_detail!.modality === "cycling")).toBe(true);
  });

  it("요일 합치기 — 유산소만 있는 대상 날의 결정이 이기고, 원래 날의 「뺐다」는 대상 날 유산소를 지우지 않는다", async () => {
    seed();
    await put({ op: "add", day_index: 5, to_exercise_id: "walking_treadmill" });
    const onto = await put({ op: "move", day_index: 0, to_day_index: 5, mode: "merge" });
    expect(onto.code).toBe(200);
    expect(cardioOn(onto.plan, 5)[0]!.cardio_detail!.modality).toBe("incline_walk");

    seed();
    await put({ op: "remove", day_index: 0, exercise_id: "bicycling_stationary" });
    const merged = await put({ op: "move", day_index: 0, to_day_index: 3, mode: "merge" });
    expect(cardioOn(merged.plan, 3)).toHaveLength(1);
  });

  it("빈 대상 날로는 swap 과 merge 가 같은 결과다 — 「뺐다」도 따라간다(계약 §2.2 mode)", async () => {
    const after = async (mode: string) => {
      seed();
      await put({ op: "remove", day_index: 0, exercise_id: "bicycling_stationary" });
      const out = await put({ op: "move", day_index: 0, to_day_index: 5, mode });
      return out.plan.week.map((d) => [d.day_index, cardioOn(out.plan, d.day_index).length]);
    };
    const swapped = await after("swap");
    expect(await after("merge")).toEqual(swapped);
    expect(swapped).toContainEqual([5, 0]);
  });
});

describe("edit — 유산소 목표 (op: cardio · 계약 §2.2 · 041 N4 · D57)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";
  const DRAFT = CASES[SAMPLE.id]!.draft;
  type Detail = { modality: string; style: string; duration_min: number; intensity_zone: string; placement: string; distance_m?: number; incline_pct?: number; level?: number; segments?: Array<Record<string, unknown>> };
  type Row = { exercise_id: string; name: string; modality: string; cardio_detail?: Detail };
  type Plan = { week: Array<{ day_index: number; est_duration_min: number; exercises: Row[] }> };

  // SAMPLE(주 2일·maintain_health): 0·3 무거운 하체일 + 사이클링(separate_session) · 1 휴식일 사이클링 · 2·4·5·6 빈 날.
  // **1 휴식일 사이클링은 D45 ① 이전 생성이 남긴 옛 플랜의 모양이다**(백로그 078·079) — 지금 확장기는 휴식일에 놓지 않으므로
  // 확장 때만 그 날 결정을 얹고, 저장 드래프트에는 결정이 없다. 편집 입구의 `pinRestDayCardio` 가 그 줄을 결정으로 고정한다.
  function seed() {
    const { plan } = expandDraftToWeeklyPlan({
      draft: LEGACY_REST_CARDIO(DRAFT), profile: SAMPLE.profile, userId: "u1", weekStartDate: WEEK, weekNumber: 1, priorLogs: [], disclaimer: "d",
    });
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK, plan, draft: structuredClone(DRAFT), draft_original: structuredClone(DRAFT), profile: SAMPLE.profile,
    });
  }
  const put = async (payload: unknown) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", body: payload, query: {}, path: "/v1/plans/current", headers: AUTH }, r);
    const body = r.captured.body as { plan?: Plan; message?: string };
    if (body.plan) expect(checkWeeklyPlan(body.plan).ok).toBe(true);
    return { code: r.captured.code, plan: body.plan!, message: body.message };
  };
  const line = (plan: Plan, day: number) => (plan.week.find((d) => d.day_index === day)?.exercises ?? []).find((e) => e.modality === "cardio");
  const dayOf = (plan: Plan, day: number) => plan.week.find((d) => d.day_index === day)!;

  it("T4-1·T4-6 목표가 계획에 실리고 요일 소요가 따라온다", async () => {
    seed();
    const before = await put({ op: "replace", day_index: 1, exercise_id: "bicycling_stationary", to_exercise_id: "running_treadmill" });
    const out = await put({ op: "cardio", day_index: 1, exercise_id: "running_treadmill", cardio: { style: "LISS", duration_min: 40, distance_m: 6000, incline_pct: 1 } });
    expect(out.code).toBe(200);
    expect(line(out.plan, 1)!.cardio_detail).toMatchObject({ modality: "running", style: "LISS", duration_min: 40, distance_m: 6000, incline_pct: 1 });
    expect(dayOf(out.plan, 1).est_duration_min - dayOf(before.plan, 1).est_duration_min).toBe(10);
    // 다른 편집으로 재확장해도 목표가 남는다.
    const again = await put({ op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: 4 });
    expect(line(again.plan, 1)!.cardio_detail).toMatchObject({ duration_min: 40, distance_m: 6000 });
  });

  it("T4-2 무거운 하체일에도 인터벌을 받는다 — 배치 표시만 그대로 (D57 A11)", async () => {
    seed();
    const out = await put({ op: "cardio", day_index: 0, exercise_id: "bicycling_stationary", cardio: { style: "HIIT", duration_min: 20, level: 8, segments: [{ label: "질주", sec: 60, level: 12 }, { label: "회복", sec: 60, level: 4 }] } });
    expect(out.code).toBe(200);
    const detail = line(out.plan, 0)!.cardio_detail!;
    expect(detail).toMatchObject({ style: "HIIT", duration_min: 20, level: 8, placement: "separate_session" });
    expect(detail.intensity_zone).toContain("인터벌");
    expect(detail.segments).toEqual([{ label: "질주", sec: 60, level: 12 }, { label: "회복", sec: 60, level: 4 }]);
  });

  it("T4-3 HIIT 횟수 제한이 없다 — 세 날 모두 인터벌", async () => {
    seed();
    // 요일마다 추천 종류가 돌아간다(N6 · 자전거 → 인클라인 걷기 → 일립티컬) — 그 날 줄의 id 로 고친다.
    const seeded = weeksOf("u1").get(WEEK)!.plan as Plan;
    for (const day of [0, 1, 3]) {
      const id = line(seeded, day)!.exercise_id;
      expect((await put({ op: "cardio", day_index: day, exercise_id: id, cardio: { style: "HIIT", duration_min: 15 } })).code).toBe(200);
    }
    const last = await put({ op: "tune", day_index: 0, exercise_id: "barbell_squat", sets: 3 });
    expect([0, 1, 3].map((d) => line(last.plan, d)!.cardio_detail!.style)).toEqual(["HIIT", "HIIT", "HIIT"]);
  });

  it("T4-4 범위·모양 위반은 400 — 기록과 같은 판정", async () => {
    seed();
    const bad = async (cardio: unknown) => put({ op: "cardio", day_index: 1, exercise_id: "bicycling_stationary", cardio });
    expect((await bad({ style: "LISS", duration_min: 30, level: 31 })).message).toMatch(/레벨/);
    expect((await bad({ style: "LISS", duration_min: 301 })).code).toBe(400);
    expect((await bad({ style: "LISS", duration_min: 30, incline_pct: 5 })).message).toMatch(/칸이 없는/);
    expect((await bad({ style: "LISS", duration_min: 30, level: "8" })).code).toBe(400);
    expect((await bad({ style: "FAST", duration_min: 30 })).code).toBe(400);
    expect((await bad({ style: "HIIT", duration_min: 30, segments: [{ sec: "60" }] })).code).toBe(400);
    // 구간 안쪽 칸도 모양 위반이다 — 길이만 세면 조용히 빠진 채 저장된다(codex N4 R1).
    expect((await bad({ style: "HIIT", duration_min: 30, segments: [{ sec: 60, level: "8" }] })).code).toBe(400);
    expect((await bad({ style: "HIIT", duration_min: 30, segments: [{ sec: 60, label: 5 }] })).code).toBe(400);
    expect((await bad({ style: "HIIT", duration_min: 30, segments: [{ sec: 60, speed_kmh: null }] })).code).toBe(200);
    // 숫자 칸의 null 은 「그 칸 비우기」지만 segments 는 배열이거나 없어야 한다(계약 §2.2).
    expect((await bad({ style: "HIIT", duration_min: 30, segments: null })).code).toBe(400);
  });

  it("T4-5 근력 id · 유산소 없는 날 · 다른 유산소 id 는 400", async () => {
    seed();
    const cardio = { style: "LISS", duration_min: 30 };
    expect((await put({ op: "cardio", day_index: 0, exercise_id: "barbell_squat", cardio })).code).toBe(400);
    expect((await put({ op: "cardio", day_index: 2, exercise_id: "bicycling_stationary", cardio })).code).toBe(400);
    expect((await put({ op: "cardio", day_index: 1, exercise_id: "rowing_stationary", cardio })).code).toBe(400);
  });

  it("T4-7 교체는 새 운동의 설정 방식을 따른다 (D57 A14)", async () => {
    seed();
    await put({ op: "replace", day_index: 1, exercise_id: "bicycling_stationary", to_exercise_id: "running_treadmill" });
    await put({ op: "cardio", day_index: 1, exercise_id: "running_treadmill", cardio: { style: "HIIT", duration_min: 25, distance_m: 4000, segments: [{ label: "질주", sec: 60, speed_kmh: 12 }, { label: "회복", sec: 60, speed_kmh: 6 }] } });
    const walk = await put({ op: "replace", day_index: 1, exercise_id: "running_treadmill", to_exercise_id: "walking_treadmill" });
    expect(line(walk.plan, 1)!.cardio_detail).toMatchObject({ style: "HIIT", duration_min: 25, distance_m: 4000, segments: [{ label: "질주", sec: 60, speed_kmh: 12 }, { label: "회복", sec: 60, speed_kmh: 6 }] });
    const bike = await put({ op: "replace", day_index: 1, exercise_id: "walking_treadmill", to_exercise_id: "bicycling_stationary" });
    const detail = line(bike.plan, 1)!.cardio_detail!;
    expect(detail).toMatchObject({ style: "HIIT", duration_min: 25, segments: [{ label: "질주", sec: 60 }, { label: "회복", sec: 60 }] });
    expect("distance_m" in detail).toBe(false);
  });

  it("T4-7b 칸이 같아도 새 운동의 범위 밖이면 버린다 (codex N4 R2)", async () => {
    seed();
    await put({ op: "replace", day_index: 1, exercise_id: "bicycling_stationary", to_exercise_id: "mymountain" });
    // 마이마운틴 경사는 −5~50, 트레드밀은 −3~20 — 그대로 옮기면 새 운동에서 범위 밖 목표가 된다.
    expect((await put({ op: "cardio", day_index: 1, exercise_id: "mymountain", cardio: { style: "LISS", duration_min: 30, incline_pct: 30 } })).code).toBe(200);
    const walk = await put({ op: "replace", day_index: 1, exercise_id: "mymountain", to_exercise_id: "walking_treadmill" });
    const detail = walk.plan && line(walk.plan, 1)!.cardio_detail!;
    expect(detail).toMatchObject({ style: "LISS", duration_min: 30 });
    expect("incline_pct" in detail!).toBe(false);

    // 구간도 같은 규칙 — 범위 밖인 그 칸만 버리고 배열은 남는다(codex N4 R4).
    await put({ op: "replace", day_index: 1, exercise_id: "walking_treadmill", to_exercise_id: "mymountain" });
    await put({ op: "cardio", day_index: 1, exercise_id: "mymountain", cardio: { style: "HIIT", duration_min: 30, segments: [{ label: "오르막", sec: 120, incline_pct: 30 }, { label: "회복", sec: 60, incline_pct: 5 }] } });
    const back = await put({ op: "replace", day_index: 1, exercise_id: "mymountain", to_exercise_id: "walking_treadmill" });
    const segs = line(back.plan, 1)!.cardio_detail!.segments!;
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ label: "오르막", sec: 120 });
    expect("incline_pct" in segs[0]!).toBe(false);      // 30 은 트레드밀 범위(−3~20) 밖
    expect(segs[1]).toMatchObject({ incline_pct: 5 });  // 5 는 범위 안이라 남는다
  });

  it("T4-8 새 종류로 교체·추가하면 줄 id 가 고른 운동이다", async () => {
    seed();
    const step = await put({ op: "replace", day_index: 1, exercise_id: "bicycling_stationary", to_exercise_id: "step_mill" });
    expect(line(step.plan, 1)).toMatchObject({ exercise_id: "step_mill", cardio_detail: { modality: "stairs" } });
    const mountain = await put({ op: "replace", day_index: 1, exercise_id: "step_mill", to_exercise_id: "mymountain" });
    expect(line(mountain.plan, 1)).toMatchObject({ exercise_id: "mymountain", name: "마이마운틴", cardio_detail: { modality: "incline_walk" } });
    const recumbent = await put({ op: "add", day_index: 5, to_exercise_id: "recumbent_bike" });
    expect(line(recumbent.plan, 5)).toMatchObject({ exercise_id: "recumbent_bike", cardio_detail: { modality: "cycling", placement: "rest_day" } });
    expect((await put({ op: "add", day_index: 6, to_exercise_id: "prowler_sprint" })).code).toBe(400); // 13종 밖
  });

  it("T4-10 요일 이동이 목표를 들고 간다", async () => {
    seed();
    await put({ op: "cardio", day_index: 0, exercise_id: "bicycling_stationary", cardio: { style: "LISS", duration_min: 45, level: 6 } });
    const moved = await put({ op: "move", day_index: 0, to_day_index: 2, mode: "swap" });
    expect(moved.code).toBe(200);
    expect(line(moved.plan, 2)!.cardio_detail).toMatchObject({ duration_min: 45, level: 6 });
    expect(line(moved.plan, 0)?.cardio_detail?.duration_min).not.toBe(45);
  });

  it("T4-11 뺀 뒤 넣으면 목표가 지워지고 도스로 시작한다", async () => {
    // 되돌리기(`reset`)로 지우는 길은 없어졌다([D59](../../docs/decisions/mvp-decision-log.md#d59)) — 남은 길은 빼고 다시 넣는 것이다.
    seed();
    await put({ op: "cardio", day_index: 1, exercise_id: "bicycling_stationary", cardio: { style: "HIIT", duration_min: 18, level: 9 } });
    expect((await put({ op: "reset" })).code).toBe(400);
    await put({ op: "remove", day_index: 1, exercise_id: "bicycling_stationary" });
    const back = await put({ op: "add", day_index: 1, to_exercise_id: "bicycling_stationary" });
    expect(line(back.plan, 1)!.cardio_detail).toMatchObject({ style: "LISS", duration_min: 30 });
    expect("level" in line(back.plan, 1)!.cardio_detail!).toBe(false);
  });

  it("T4-12 목표는 LLM 표면에 없다 — 드래프트 스키마·프롬프트 불변 (INV-1)", async () => {
    const draftSchema = JSON.stringify((await import("../src/schemas/draft-plan.schema.json")).default);
    for (const key of ["cardio_override", "target", "distance_m", "incline_pct", "segments"]) expect(draftSchema.includes(`"${key}"`), key).toBe(false);
  });
});

describe("edit — 정책 위반도 그대로 저장한다 (D20-1: 강제도 경고도 없다)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";

  it("요일의 마지막 운동을 빼도 200 — 그 요일이 비고 정본에 남는다", async () => {
    const draft = structuredClone(CASES[SAMPLE.id]!.draft) as {
      week: Array<{ day_index: number; items: Array<{ kind?: string; exercise_id?: string }> }>;
    };
    weeksOf("u1").set(WEEK, {
      user_id: "u1",
      week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1 }, week: [] },
      draft,
      profile: SAMPLE.profile,
    });

    const day0 = draft.week.find((d) => d.day_index === 0)!;
    const ids = day0.items.filter((i) => i.kind === "strength").map((i) => i.exercise_id!);
    for (const id of ids) {
      const r = res();
      await (plansGet as unknown as Handler)(
        { method: "PUT", body: { op: "remove", day_index: 0, exercise_id: id }, query: {}, path: "/v1/plans/current", headers: AUTH },
        r,
      );
      // 훈련일이 days_per_week 에 모자라져도 거절하지 않는다 — 사용자 플랜이다.
      expect(r.captured.code).toBe(200);
    }

    const stored = weeksOf("u1").get(WEEK) as {
      draft: typeof draft;
      plan: { week: Array<{ day_index: number; exercises: unknown[] }> };
    };
    expect(stored.draft.week.find((d) => d.day_index === 0)!.items.filter((i) => i.kind === "strength")).toHaveLength(0);
    const day = stored.plan.week.find((d) => d.day_index === 0);
    // 유산소는 남을 수 있으나 근력은 하나도 없다.
    expect((day?.exercises ?? []).filter((e) => (e as { modality: string }).modality !== "cardio")).toHaveLength(0);
    // 정책은 풀어도 구조는 지킨다 — 저장된 플랜은 여전히 계약 스키마를 통과한다.
    expect(checkWeeklyPlan(stored.plan).ok).toBe(true);
  });
});

describe("edit — 후보에 맨몸 운동이 빠지지 않는다 (계약 §2.3)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);

  it("bodyweight_only 프로필도 후보를 받는다", async () => {
    // 맨몸 111종은 modality 가 `bodyweight` 다 — `strength` 로 좁히면 0개가 된다.
    weeksOf("u1").set("2026-08-17", {
      user_id: "u1",
      week_start_date: "2026-08-17",
      plan: { plan_meta: { week_number: 1 }, week: [{ day_index: 0, exercises: [{ exercise_id: "pushups" }] }] },
      draft: CASES[SAMPLE.id]!.draft,
      profile: { ...SAMPLE.profile, environment: "bodyweight_only", equipment: ["body only"] },
    });

    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "GET", query: { day_index: "0" }, path: "/v1/plans/current/candidates", headers: AUTH },
      r,
    );
    expect(r.captured.code).toBe(200);
    const { candidates } = r.captured.body as { candidates: Array<{ id: string }> };
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((c) => c.id)).not.toContain("pushups"); // 이미 그 날에 있다
  });
});

describe("edit — add 의 중복·순서 (2차 교차검증 findings)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";
  const put = async (payload: unknown) => {
    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "PUT", body: payload, query: {}, path: "/v1/plans/current", headers: AUTH },
      r,
    );
    return r.captured;
  };
  const seed = () =>
    weeksOf("u1").set(WEEK, {
      user_id: "u1",
      week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1 }, week: [] },
      draft: structuredClone(CASES[SAMPLE.id]!.draft),
      profile: SAMPLE.profile,
    });

  it("같은 종목을 두 번 넣을 수 없다", async () => {
    seed();
    expect((await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" })).code).toBe(200);
    const dup = await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" });
    expect(dup.code).toBe(400);
    expect((dup.body as { message: string }).message).toMatch(/이미 있어요/);
  });

  it("빼고 나서 넣어도 order 가 겹치지 않는다", async () => {
    seed();
    const draft = weeksOf("u1").get(WEEK)!.draft as { week: Array<{ day_index: number; items: Array<{ exercise_id?: string; order?: number }> }> };
    const first = draft.week.find((d) => d.day_index === 0)!.items.find((i) => i.exercise_id)!.exercise_id!;

    // remove 는 번호를 다시 매기지 않는다 — 그 뒤 add 가 items.length+1 을 쓰면 겹친다.
    expect((await put({ op: "remove", day_index: 0, exercise_id: first })).code).toBe(200);
    expect((await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" })).code).toBe(200);

    const after = (weeksOf("u1").get(WEEK)!.draft as typeof draft).week.find((d) => d.day_index === 0)!.items;
    const orders = after.map((i) => i.order).filter((o): o is number => typeof o === "number");
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe("세션 기록 — PUT /v1/plans/current/sessions/{day_index} (계약 §2.4 · 019 M2)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";

  function seed(uid = "u1", extra: Record<string, unknown> = {}) {
    weeksOf(uid).set(WEEK, {
      user_id: uid,
      week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1, plan_id: "p1" }, week: [] },
      profile: SAMPLE.profile,
      ...extra,
    });
  }

  /** PerformedSession v1 하나. 기본은 벤치프레스 60kg×8 한 세트다. */
  function session(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: "1.0",
      session_id: "s-1",
      plan_id: "p1",
      date: "2026-08-17",
      day_index: 0,
      completion: "completed",
      completion_pct: 1,
      exercises: [
        {
          exercise_id: "barbell_bench_press",
          modality: "strength",
          sets: [{ set_number: 1, set_kind: "working", actual_reps: 8, actual_load_kg: 60 }],
        },
      ],
      ...overrides,
    };
  }

  const putSession = async (dayIndex: number | string, payload: unknown, week = "current", headers = AUTH) => {
    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "PUT", body: payload, query: {}, path: `/v1/plans/${week}/sessions/${dayIndex}`, headers },
      r,
    );
    return r.captured;
  };

  it("저장하고 200 ok — 주차 문서의 sessions 맵에 그 요일로 들어간다", async () => {
    seed();
    const out = await putSession(0, session());

    expect(out.code).toBe(200);
    expect(out.body).toEqual({ status: "ok" });
    const stored = weeksOf("u1").get(WEEK) as { sessions: Record<string, { session_id: string }> };
    expect(stored.sessions["0"]!.session_id).toBe("s-1");
    // 하위 컬렉션이 아니라 **그 주차 문서 안**이다 — GET current 가 이미 이걸 읽는다.
    expect(weeksOf("u1").size).toBe(1);
  });

  it("멱등 upsert — 같은 요일로 다시 보내면 덮어쓰고, 다른 요일은 남는다", async () => {
    seed();
    await putSession(0, session());
    await putSession(2, session({ session_id: "s-2", day_index: 2, date: "2026-08-19" }));
    // 완료한 날에 한 세트를 더 하고 다시 저장하는 경로다.
    const again = await putSession(0, session({ session_id: "s-1b", completion: "partial", completion_pct: 0.5 }));

    expect(again.code).toBe(200);
    const stored = weeksOf("u1").get(WEEK) as { sessions: Record<string, { session_id: string }> };
    expect(stored.sessions["0"]!.session_id).toBe("s-1b"); // 덮어썼다
    expect(stored.sessions["2"]!.session_id).toBe("s-2"); // 다른 요일은 그대로다
  });

  it("경로와 본문의 day_index 가 다르면 400", async () => {
    seed();
    const out = await putSession(1, session({ day_index: 0 }));
    expect(out.code).toBe(400);
    expect((out.body as { message: string }).message).toMatch(/day_index/);
    expect(weeksOf("u1").get(WEEK)!.sessions).toBeUndefined();
  });

  it("스키마 위반은 400 — 유산소 세트에 무게를 실으면 거절한다", async () => {
    seed();
    const bad = session({
      exercises: [
        {
          exercise_id: "stationary_bike",
          modality: "cardio",
          // 스키마 `oneOf`: cardio 세트에 actual_* 를 같이 넣을 수 없다.
          sets: [{ set_number: 1, set_kind: "working", actual_reps: 0, actual_load_kg: 0, cardio: { modality: "cycling", duration_min: 20 } }],
        },
      ],
    });
    const out = await putSession(0, bad);
    expect(out.code).toBe(400);
    expect(weeksOf("u1").get(WEEK)!.sessions).toBeUndefined();
  });

  it("day_index 가 0–6 밖이면 400", async () => {
    seed();
    for (const bad of [7, -1, "x"]) {
      const out = await putSession(bad, session({ day_index: bad }));
      expect(out.code, String(bad)).toBe(400);
    }
  });

  it("저장된 플랜이 없으면 404, 남의 플랜에도 404", async () => {
    expect((await putSession(0, session())).code).toBe(404);
    // u2 의 플랜은 u1 의 경로에 없다 — 하위 컬렉션이 소유권을 구조로 가른다.
    seed("u2");
    expect((await putSession(0, session())).code).toBe(404);
  });

  it("인증 없으면 401", async () => {
    seed();
    expect((await putSession(0, session(), "current", {} as typeof AUTH)).code).toBe(401);
  });

  it("GET current 가 sessions 를 함께 싣는다 — 기기를 바꿔도 한 날을 안다", async () => {
    seed();
    await putSession(0, session());
    const r = res();
    await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/current"), r);

    expect(r.captured.code).toBe(200);
    const out = r.captured.body as { sessions: Record<string, { session_id: string }> };
    expect(out.sessions["0"]!.session_id).toBe("s-1");
  });

  it("주간 생성 한도를 소모하지 않는다 — LLM 을 부르지 않는다", async () => {
    seed();
    await putSession(0, session());
    expect(store("rate_limits").size).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe("이력 — GET /v1/plans/history (계약 §2.6 · 백로그 025 §2 · D35)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const SQUAT = "barbell_squat";

  /** 그 주차 문서 하나 — 요일 0 에 스쿼트 한 종목이 실린 세션. */
  const seedWeek = (uid: string, weekStart: string, kg: number, reps: number, exerciseId = SQUAT) =>
    weeksOf(uid).set(weekStart, {
      user_id: uid,
      week_start_date: weekStart,
      plan: { week: [{ day_index: 0, session_type: "strength" }] },
      sessions: {
        0: {
          exercises: [{
            exercise_id: exerciseId,
            modality: "strength",
            sets: [{ set_number: 1, set_kind: "working", actual_reps: reps, actual_load_kg: kg }],
          }],
        },
      },
    });

  const history = async (query: Record<string, string> = {}, headers = AUTH) => {
    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "GET", query, path: "/v1/plans/history", headers },
      r,
    );
    return r.captured;
  };

  it("exercise_id 가 없으면 지금 동작 그대로다 — 주별 done/total (메인 히트맵)", async () => {
    seedWeek("u1", "2026-08-17", 50, 12);
    const r = await history();
    expect(r.code).toBe(200);
    expect(r.body).toEqual({
      status: "ok",
      history: [{ week_start_date: "2026-08-17", done: 1, total: 1 }],
    });
  });

  it("trend=1 은 이번 주와 7일 전 주만 비교한다 (계약 §2.6.2 · T1·T2)", async () => {
    seedWeek("u1", "2026-09-21", 100, 5); // 2주 전 — 지난주가 없을 때 대신 쓰면 안 된다
    seedWeek("u1", "2026-10-05", 82.5, 5);
    let r = await history({ trend: "1", week_start_date: "2026-10-05" });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ status: "ok", week_start_date: "2026-10-05", previous_week: "2026-09-28", exercises: [] });
    seedWeek("u1", "2026-09-28", 80, 5);
    r = await history({ trend: "1", week_start_date: "2026-10-05" });
    expect(r.body).toMatchObject({ exercises: [{ exercise_id: SQUAT, previous: { top_load_kg: 80 }, current: { top_load_kg: 82.5 } }] });
  });

  it("trend=1 에 week_start_date 가 없거나 형식이 어긋나면 400 — 서버가 이번 주를 정하지 않는다 (T3)", async () => {
    expect((await history({ trend: "1" })).code).toBe(400);
    expect((await history({ trend: "1", week_start_date: "zzz" })).code).toBe(400);
    expect((await history({ trend: "1", week_start_date: "2026-13-01" })).code).toBe(400);
  });

  it("exercise_id 가 trend 를 이긴다 — 종목 모드 응답은 그대로다 (T2)", async () => {
    seedWeek("u1", "2026-08-17", 50, 12);
    const r = await history({ exercise_id: SQUAT, trend: "1" });
    expect(r.body).toHaveProperty("previous");
    expect(r.body).not.toHaveProperty("exercises");
  });

  it("exercise_id 가 붙으면 previous·best 를 준다", async () => {
    seedWeek("u1", "2026-08-10", 45, 12);
    seedWeek("u1", "2026-08-17", 50, 12);
    const r = await history({ exercise_id: SQUAT });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({
      status: "ok",
      previous: { week_start_date: "2026-08-17", top_load_kg: 50, top_reps: 12, one_rm_kg: 70, volume_kg: 600 },
      best: { week_start_date: "2026-08-17", top_load_kg: 50, top_reps: 12, one_rm_kg: 70, volume_kg: 600 },
    });
    // `history` 는 안 싣는다 — 같은 경로가 두 모드로 갈린다는 것이 응답에서도 보여야 한다.
    expect(r.body).not.toHaveProperty("history");
  });

  it("유산소 종목이면 previous_cardio 가 응답에 실린다 (041 N6 · 계약 §2.6.1)", async () => {
    // 🔴 핸들러가 집계 결과에서 필드를 하나씩 꺼내 쓰면 이 칸이 조용히 빠진다(codex 041 N6 R1).
    const cardio = { modality: "running", style: "LISS", duration_min: 45, distance_m: 5200 };
    weeksOf("u1").set("2026-08-17", {
      user_id: "u1",
      week_start_date: "2026-08-17",
      plan: { week: [{ day_index: 0, session_type: "cardio_only" }] },
      sessions: {
        0: {
          date: "2026-08-17",
          exercises: [{
            exercise_id: "running_treadmill",
            modality: "cardio",
            sets: [{ set_number: 1, set_kind: "working", cardio }],
          }],
        },
      },
    });
    const r = await history({ exercise_id: "running_treadmill", week_start_date: "2026-08-24" });
    expect(r.code).toBe(200);
    // 유산소는 무게·회수가 없어 previous·best 는 null 이고, 이력은 이 칸에만 있다.
    expect(r.body).toEqual({
      status: "ok",
      previous: null,
      best: null,
      previous_cardio: { week_start_date: "2026-08-17", cardio },
    });
  });

  it("week_start_date 를 주면 previous 에서 이번 주가 빠지고 best 에는 남는다 (G4 2026-08-31)", async () => {
    seedWeek("u1", "2026-08-17", 50, 12);
    seedWeek("u1", "2026-08-31", 100, 12); // 오늘 저장한 기록
    const r = await history({ exercise_id: SQUAT, week_start_date: "2026-08-31" });
    expect(r.body).toMatchObject({
      previous: { week_start_date: "2026-08-17", top_load_kg: 50 },
      best: { week_start_date: "2026-08-31", top_load_kg: 100 },
    });
  });

  it("week_start_date 형식이 어긋나면 안 준 것으로 친다 — previous 가 통째로 사라지지 않는다", async () => {
    seedWeek("u1", "2026-08-17", 50, 12);
    // 문자열 비교라 `zzz` 를 그대로 쓰면 모든 주가 '이번 주 이후'로 걸려 전부 빠진다.
    const r = await history({ exercise_id: SQUAT, week_start_date: "zzz" });
    expect(r.body).toMatchObject({ previous: { week_start_date: "2026-08-17" } });
  });

  it("한 번도 안 한 종목은 null 이다 (0 도 빈 객체도 아니다)", async () => {
    seedWeek("u1", "2026-08-17", 50, 12);
    expect((await history({ exercise_id: "deadlift" })).body)
      .toEqual({ status: "ok", previous: null, best: null });
  });

  it("T0-6 uid 격리 — 남의 주차 문서는 안 보인다", async () => {
    seedWeek("u2", "2026-08-17", 200, 12); // 남의 기록이 더 무겁다
    seedWeek("u1", "2026-08-10", 50, 12);
    const r = await history({ exercise_id: SQUAT });
    expect(r.body).toMatchObject({
      previous: { week_start_date: "2026-08-10", top_load_kg: 50 },
      best: { top_load_kg: 50 },
    });
    // 나에게 아무 기록이 없으면 남의 것이 새어 들어오는 대신 null 이다.
    const other = await history({ exercise_id: SQUAT }, { authorization: "Bearer token-u3" });
    expect(other.body).toEqual({ status: "ok", previous: null, best: null });
  });

  it("T0-4 weeks 상한이 Firestore 읽기를 실제로 자른다 (선언만이 아니다)", async () => {
    // 53주를 심고 `weeks=999` 로 부른다. 상한(52)이 질의에 안 걸리면 가장 오래된
    // 주(무게가 가장 무겁다)가 best 에 든다.
    for (let i = 0; i < 53; i += 1) {
      const day = String(10 + i).padStart(2, "0");
      seedWeek("u1", `2026-01-${day}`, 200 - i, 10); // 2026-01-10 이 가장 오래되고 가장 무겁다
    }
    const r = await history({ exercise_id: SQUAT, weeks: "999" });
    // 최신 52주만 본다 → 잘려나간 첫 주(200kg)는 안 보이고 그 다음(199kg)이 최고다.
    expect((r.body as { best: { top_load_kg: number } }).best.top_load_kg).toBe(199);
  });

  it("weeks 기본은 26 주다 — 그보다 오래된 주는 안 든다", async () => {
    for (let i = 0; i < 27; i += 1) {
      const day = String(10 + i).padStart(2, "0");
      seedWeek("u1", `2026-01-${day}`, 200 - i, 10);
    }
    const r = await history({ exercise_id: SQUAT });
    expect((r.body as { best: { top_load_kg: number } }).best.top_load_kg).toBe(199);
  });

  it("인증 없으면 401 이고 아무것도 읽지 않는다", async () => {
    seedWeek("u1", "2026-08-17", 50, 12);
    expect((await history({ exercise_id: SQUAT }, {} as typeof AUTH)).code).toBe(401);
  });

  it("주간 생성 한도를 소모하지 않는다 — LLM 을 부르지 않는다", async () => {
    seedWeek("u1", "2026-08-17", 50, 12);
    await history({ exercise_id: SQUAT });
    expect(store("rate_limits").size).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe("prior_logs 는 서버가 만든다 (계약 §1 · D22-6 · 019 M2)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const PREV = "2026-08-10";
  const WEEK = "2026-08-17";

  /** 워커를 한 번 돌린다(위 `runWorker` 와 같은 요청 모양 — 그쪽은 그 describe 안에 갇혀 있다). */
  async function runWorkerFor(payload: Record<string, unknown>) {
    const llm: FakeLlm = await startFakeLlm([CASES[SAMPLE.id]!.draft]);
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.LLM_PROVIDER = "minimax";
    process.env.LLM_API_KEY = "fake-key";
    process.env.LLM_BASE_URL = llm.baseUrl;
    process.env.LLM_MODEL = "fake-model";
    process.env.GENERATION_PIPELINE = "p0"; // 가짜 LLM 은 P0 드래프트 — 기본 auto 면 헬스장이 P1(D105 ①)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-cloudtasks-queuename": "plansWorker",
    };
    const r = res();
    try {
      await (plansWorker as unknown as Handler)(
        { method: "POST", headers, body: { data: payload }, header: (n: string) => headers[n.toLowerCase()] },
        r,
      );
    } finally {
      await llm.close();
    }
    return r;
  }

  /** 직전 주 문서 — 플랜 + 실측 세션. 다음 주 생성이 이걸 읽어야 진행이 돈다. */
  function seedPrevWeek(sessions: Record<string, unknown>) {
    weeksOf("u1").set(PREV, {
      user_id: "u1",
      week_start_date: PREV,
      plan: { plan_meta: { week_number: 1 }, week: [] },
      profile: SAMPLE.profile,
      sessions,
    });
  }

  const performed = (exerciseId: string, loadKg: number) => ({
    schema_version: "1.0",
    session_id: `s-${exerciseId}`,
    plan_id: "p1",
    date: PREV,
    day_index: 0,
    completion: "completed",
    exercises: [
      {
        exercise_id: exerciseId,
        modality: "strength",
        sets: [
          { set_number: 1, set_kind: "working", actual_reps: 10, actual_load_kg: loadKg },
          { set_number: 2, set_kind: "working", actual_reps: 10, actual_load_kg: loadKg },
        ],
      },
    ],
  });

  it("본문에 실어 보낸 prior_logs 는 접수에서 버려진다", async () => {
    const forged = [performed("barbell_squat", 999)];
    const r = res();
    await (plansGenerate as unknown as Handler)(post(body({ prior_logs: forged })), r);

    expect(r.captured.code).toBe(202);
    // 큐로 넘어가는 요청이 곧 워커의 입력이다 — 여기서 이미 비어 있어야 한다.
    const queued = enqueued[0] as { req: { prior_logs: unknown[] } };
    expect(queued.req.prior_logs).toEqual([]);
  });

  it("직전 주 sessions 를 서버가 읽어 넣는다 — 클라이언트는 보내지 않는다", async () => {
    seedPrevWeek({ 0: performed("barbell_squat", 60) });
    const r = res();
    await (plansGenerate as unknown as Handler)(post(bodyWithout("prior_logs")), r);

    expect(r.captured.code).toBe(202);
    const queued = enqueued[0] as { req: { prior_logs: Array<{ session_id: string }> } };
    expect(queued.req.prior_logs).toHaveLength(1);
    expect(queued.req.prior_logs[0]!.session_id).toBe("s-barbell_squat");
  });

  it("실측이 진행 결정에 실제로 닿는다 — 처방 무게가 1주차의 null 에서 벗어난다", async () => {
    // 이 리포가 실제로 겪던 상태다: 미니앱이 늘 `[]` 를 보내 매주 1주차 플랜을 받고
    // `target_load_kg` 가 항상 null 이었다(D22-6 "되찾는 것").
    seedPrevWeek({ 0: performed("barbell_squat", 60) });
    docs.set("job-prior", { job_id: "job-prior", user_id: "u1", status: "queued" });

    const intake = res();
    await (plansGenerate as unknown as Handler)(post(bodyWithout("prior_logs")), intake);
    const queued = (enqueued[0] as { req: Record<string, unknown> }).req;

    await runWorkerFor({ jobId: "job-prior", req: { ...queued, week_start_date: WEEK } });

    const stored = weeksOf("u1").get(WEEK) as { plan: { week: Array<{ exercises: Array<{ exercise_id: string; sets: Array<{ target_load_kg: number | null }> }> }> } };
    const squat = stored.plan.week.flatMap((d) => d.exercises).find((e) => e.exercise_id === "barbell_squat");
    // 실측이 닿았으면 코드가 무게를 처방한다. 안 닿으면 전부 null 이다.
    expect(squat?.sets.some((s) => typeof s.target_load_kg === "number" && s.target_load_kg > 0)).toBe(true);
  });

  it("같은 주 재생성은 이번 주 실측을 먹지 않는다 — 되먹임 금지", async () => {
    // 이번 주에 이미 한 운동이 이번 주 처방의 근거가 되면, 재생성할 때마다 오늘 든
    // 무게를 근거로 오늘의 처방이 올라간다. 계약 §1 은 **직전 주** 기록이라고 쓴다.
    weeksOf("u1").set(WEEK, {
      user_id: "u1",
      week_start_date: WEEK,
      plan: { plan_meta: { week_number: 2 }, week: [] },
      profile: SAMPLE.profile,
      sessions: { 0: performed("barbell_squat", 100) },
    });

    const r = res();
    await (plansGenerate as unknown as Handler)(post(body({ week_start_date: WEEK })), r);

    expect(r.captured.code).toBe(202);
    const queued = enqueued[0] as { req: { prior_logs: unknown[] } };
    expect(queued.req.prior_logs).toEqual([]); // 이번 주 것은 안 먹는다
  });

  it("앞선 주가 여럿이면 가장 가까운 앞선 주를 먹는다", async () => {
    weeksOf("u1").set(PREV, {
      user_id: "u1", week_start_date: PREV, plan: { plan_meta: { week_number: 1 }, week: [] },
      profile: SAMPLE.profile, sessions: { 0: performed("barbell_squat", 60) },
    });
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK, plan: { plan_meta: { week_number: 2 }, week: [] },
      profile: SAMPLE.profile, sessions: { 0: { ...performed("barbell_squat", 100), date: WEEK } },
    });

    const r = res();
    await (plansGenerate as unknown as Handler)(post(body({ week_start_date: "2026-08-24" })), r);

    const queued = enqueued[0] as { req: { prior_logs: Array<{ exercises: Array<{ sets: Array<{ actual_load_kg: number }> }> }> } };
    expect(queued.req.prior_logs).toHaveLength(1);
    // 100kg 인 이번 주(WEEK)가 가장 가까운 앞선 주다 — PREV(60kg)가 아니다.
    expect(queued.req.prior_logs[0]!.exercises[0]!.sets[0]!.actual_load_kg).toBe(100);
  });

  it("4주 내 운동별 최근 기록을 큐와 저장 플랜까지 잇고 미래·다른 계정·5주 전은 제외한다", async () => {
    const old = { ...performed("barbell_squat", 60), date: "2026-08-03" };
    weeksOf("u1").set("2026-08-03", { plan: { plan_meta: { week_number: 3 } }, sessions: { 0: old } });
    seedPrevWeek({ 0: performed("barbell_curl", 20) });
    weeksOf("u1").set("2026-07-13", { sessions: { 0: { ...performed("barbell_squat", 200), date: "2026-07-13" } } });
    weeksOf("u2").set(PREV, { sessions: { 0: performed("barbell_squat", 300) } });
    // More future documents than the old two-document fetch: they must not hide past history.
    for (const date of ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]) {
      weeksOf("u1").set(date, { plan: { plan_meta: { week_number: 99 } }, sessions: { 0: { ...performed("barbell_squat", 400), date } } });
    }
    const intake = res();
    await (plansGenerate as unknown as Handler)(post(body({ week_start_date: WEEK, prior_logs: [performed("barbell_squat", 999)] })), intake);
    expect(intake.captured.code).toBe(202);
    const queued = (enqueued[0] as { req: Record<string, unknown> }).req;
    expect(queued.week_number).toBe(2);
    expect(queued.prior_logs).toEqual([old, performed("barbell_curl", 20)]);
    docs.set("job-four-weeks", { job_id: "job-four-weeks", user_id: "u1", status: "queued" });
    await runWorkerFor({ jobId: "job-four-weeks", req: queued });
    const stored = weeksOf("u1").get(WEEK) as { prior_logs: unknown[]; plan: { week: Array<{ exercises: Array<{ exercise_id: string; progression_decision: unknown }> }> } };
    expect(stored.prior_logs).toEqual(queued.prior_logs);
    const squat = stored.plan.week.flatMap((d) => d.exercises).find((e) => e.exercise_id === "barbell_squat");
    expect(squat?.progression_decision).toMatchObject({ decision: "hold", reason_code: "history_gap", to_load_kg: 60, source_date: "2026-08-03" });
  });

  it("재생성해도 완료 세션은 남는다 (D22-7) — 미완료 진행은 클라이언트 소관이다", async () => {
    // 그 주에 이미 완료해 올린 세션. 실제로 한 운동이고 다음 주 진행의 유일한 근거다.
    weeksOf("u1").set(WEEK, {
      user_id: "u1",
      week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1 }, week: [] },
      profile: SAMPLE.profile,
      sessions: { 0: performed("barbell_bench_press", 50) },
    });
    docs.set("job-regen", { job_id: "job-regen", user_id: "u1", status: "queued" });

    await runWorkerFor({ jobId: "job-regen", req: { ...body(), week_start_date: WEEK } });

    const stored = weeksOf("u1").get(WEEK) as { sessions?: Record<string, { session_id: string }>; plan: unknown; draft: unknown };
    expect(stored.sessions?.["0"]?.session_id).toBe("s-barbell_bench_press");
    expect(stored.plan).toBeTruthy(); // 플랜은 새로 쓰였다
  });

  // ── 044 N1 · D60 ① — 완료한 요일의 plan·draft 는 재생성이 덮지 않는다 ──────────
  /** 완료한 월요일. 새 드래프트의 day 0(스쿼트·벤치…)과 다른 종목을 심어 구분한다. */
  const DONE_DRAFT_DAY = {
    day_index: 0, session_type: "lift", focus: "하체",
    items: [{ kind: "strength", exercise_id: "barbell_lunge", role: "primary", order: 1, rep_intent: "hypertrophy" }],
  };
  const DONE_PLAN_DAY = { day_index: 0, marker: "done-monday", exercises: [{ exercise_id: "barbell_lunge" }] };
  function seedDoneMonday(withSessions = true) {
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1 }, week: [DONE_PLAN_DAY] },
      draft: { schema_version: "1.0", split_type: "full_body", week: [DONE_DRAFT_DAY] },
      profile: SAMPLE.profile,
      ...(withSessions ? { sessions: { 0: performed("barbell_lunge", 60) } } : {}),
    });
  }
  type StoredWeek = { sessions?: Record<string, unknown>; plan: { week: Array<{ day_index: number; exercises?: Array<{ exercise_id: string }> }> }; draft: { week: Array<{ day_index: number }> } };
  const idsOnDay = (plan: StoredWeek["plan"], day: number) =>
    plan.week.find((d) => d.day_index === day)?.exercises?.map((e) => e.exercise_id) ?? [];
  async function regenerate(jobId: string, week = WEEK) {
    docs.set(jobId, { job_id: jobId, user_id: "u1", status: "queued" });
    await runWorkerFor({ jobId, req: { ...body(), week_start_date: week } });
    return weeksOf("u1").get(week) as StoredWeek;
  }

  it("T1-2 재생성은 완료한 요일의 plan·draft 항목을 바이트 그대로 남긴다 — 나머지 요일은 새 것", async () => {
    seedDoneMonday();
    const stored = await regenerate("job-keep");
    expect(stored.sessions?.["0"]).toBeTruthy();
    // 재확장을 거치지 않았다 — 심은 것과 toEqual.
    expect(stored.plan.week.find((d) => d.day_index === 0)).toEqual(DONE_PLAN_DAY);
    expect(stored.draft.week.find((d) => d.day_index === 0)).toEqual(DONE_DRAFT_DAY);
    expect(stored.plan.week.filter((d) => d.day_index === 0)).toHaveLength(1); // 새 day 0 은 버려졌다(Q2 ㉠)
    expect(stored.plan.week.some((d) => d.day_index === 3)).toBe(true); // 새 드래프트의 day 3 은 들어왔다
    expect(idsOnDay(stored.plan, 3)).not.toContain("barbell_lunge");
  });

  it("T1-3 편집 한 번에 되돌아가지 않는다 — 재확장이 병합된 드래프트를 먹는다", async () => {
    seedDoneMonday();
    await regenerate("job-keep2");
    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "PUT", body: { op: "add", day_index: 3, to_exercise_id: "dumbbell_bicep_curl" }, query: {}, path: "/v1/plans/current", headers: AUTH },
      r,
    );
    expect(r.captured.code).toBe(200);
    const after = (r.captured.body as { plan: StoredWeek["plan"] }).plan;
    expect(idsOnDay(after, 0)).toContain("barbell_lunge");
    expect(idsOnDay(after, 0)).not.toContain("barbell_bench_press_medium_grip"); // 새 드래프트의 day 0 이 아니다
    expect(idsOnDay(after, 3)).toContain("dumbbell_bicep_curl");
  });

  it("T1-4 완료 세션이 없으면 종전대로 통째 교체 — 첫 생성(문서 없음)도 예외 없음", async () => {
    seedDoneMonday(false);
    const stored = await regenerate("job-none");
    expect(JSON.stringify(stored.plan.week)).not.toContain("done-monday");
    expect(JSON.stringify(stored.draft.week)).not.toContain("barbell_lunge");
    const first = await regenerate("job-first", "2026-09-07");
    expect(first.plan.week.length).toBeGreaterThan(0);
  });

  it("T1-8 빈 주(blank)는 병합을 타지 않는다 — 완료한 날도 비운다", async () => {
    seedDoneMonday();
    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "PUT", body: { op: "blank", profile: SAMPLE.profile }, query: {}, path: `/v1/plans/${WEEK}`, headers: AUTH },
      r,
    );
    expect(r.captured.code).toBe(200);
    const stored = weeksOf("u1").get(WEEK) as StoredWeek;
    // 빈 주 드래프트는 7일 휴식 + 유산소 "none"(D75) — 완료한 월요일도 항목 없이 비운다.
    expect(stored.draft.week.map((d) => (d as { items?: unknown[] }).items)).toEqual(Array(7).fill([]));
    expect(stored.sessions?.["0"]).toBeTruthy(); // 기록은 남는다(D22-7) — 플랜만 비운다
  });

  // ── 044 N2 · D60 ② — completed_this_week 는 서버가 같은 주 문서에서만 만든다 ──────
  it("T2-7 같은 주 재생성이면 이번 주 sessions 에서 만든다 · 본문 값은 버린다 · prior_logs 는 여전히 빈 값", async () => {
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK, plan: { plan_meta: { week_number: 1 }, week: [] },
      profile: SAMPLE.profile, sessions: { 0: performed("barbell_squat", 100) },
    });
    const r = res();
    await (plansGenerate as unknown as Handler)(post(body({ week_start_date: WEEK, completed_this_week: [{ day_index: 5, exercise_ids: ["barbell_curl"] }] })), r);
    expect(r.captured.code).toBe(202);
    const queued = enqueued[0] as { req: { completed_this_week: unknown; prior_logs: unknown[] } };
    expect(queued.req.completed_this_week).toEqual([{ day_index: 0, exercise_ids: ["barbell_squat"] }]);
    expect(queued.req.prior_logs).toEqual([]); // 되먹임 금지는 그대로(INV-1)
  });

  it("T2-7 다음 주 생성은 빈 값 — 직전 주 일요일 세션이 있어도 넘어오지 않는다(D60 Q6) · 문서 없음도 빈 값", async () => {
    weeksOf("u1").set(PREV, {
      user_id: "u1", week_start_date: PREV, plan: { plan_meta: { week_number: 1 }, week: [] },
      profile: SAMPLE.profile, sessions: { 6: performed("barbell_squat", 60) },
    });
    const r = res();
    await (plansGenerate as unknown as Handler)(post(body({ week_start_date: WEEK })), r);
    const queued = enqueued[0] as { req: { completed_this_week: unknown; prior_logs: unknown[] } };
    expect(queued.req.completed_this_week).toEqual([]);
    expect(queued.req.prior_logs).toHaveLength(1); // 직전 주는 prior_logs 경로 그대로
    const r2 = res();
    await (plansGenerate as unknown as Handler)(post(body({ week_start_date: "2026-09-07", completed_this_week: [{ day_index: 0, exercise_ids: ["barbell_squat"] }] })), r2);
    expect((enqueued[1] as { req: { completed_this_week: unknown } }).req.completed_this_week).toEqual([]);
  });

  it("T2-5 편집은 이 순서로 거절되지 않는다(D20-1) — 완료 월 하체 뒤 화요일에 하체를 넣어도 200", async () => {
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1 }, week: [] },
      draft: { schema_version: "1.0", split_type: "upper_lower", week: [
        { day_index: 0, session_type: "lift", focus: "하체", items: [{ kind: "strength", exercise_id: "barbell_squat", role: "primary", order: 1, rep_intent: "hypertrophy" }] },
        { day_index: 1, session_type: "lift", focus: "상체", items: [{ kind: "strength", exercise_id: "barbell_bench_press_medium_grip", role: "primary", order: 1, rep_intent: "hypertrophy" }] },
      ] },
      profile: { ...SAMPLE.profile, days_per_week: 2, available_days: [0, 1], split_pref: "upper_lower" },
      sessions: { 0: performed("barbell_squat", 60) },
    });
    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "PUT", body: { op: "add", day_index: 1, to_exercise_id: "barbell_lunge" }, query: {}, path: "/v1/plans/current", headers: AUTH },
      r,
    );
    expect(r.captured.code).toBe(200);
    expect(idsOnDay((r.captured.body as { plan: StoredWeek["plan"] }).plan, 1)).toContain("barbell_lunge");
  });

  it("편집이 재확장해도 진행 결정이 남는다 — 저장된 prior_logs 를 다시 먹는다", async () => {
    seedPrevWeek({ 0: performed("barbell_squat", 60) });
    docs.set("job-edit", { job_id: "job-edit", user_id: "u1", status: "queued" });

    const intake = res();
    await (plansGenerate as unknown as Handler)(post(bodyWithout("prior_logs")), intake);
    const queued = (enqueued[0] as { req: Record<string, unknown> }).req;
    await runWorkerFor({ jobId: "job-edit", req: { ...queued, week_start_date: WEEK } });

    const before = weeksOf("u1").get(WEEK) as { plan: { week: Array<{ exercises: Array<{ exercise_id: string; sets: Array<{ target_load_kg: number | null }> }> }> }; prior_logs: unknown[] };
    // 생성이 쓴 실측이 문서에 남아 있어야 편집이 같은 입력을 다시 먹는다.
    expect(before.prior_logs).toHaveLength(1);
    const loadBefore = before.plan.week.flatMap((d) => d.exercises)
      .find((e) => e.exercise_id === "barbell_squat")?.sets.find((s) => s.target_load_kg !== null)?.target_load_kg;
    expect(typeof loadBefore).toBe("number");

    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "PUT", body: { op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" }, query: {}, path: "/v1/plans/current", headers: AUTH },
      r,
    );
    expect(r.captured.code).toBe(200);

    const after = (r.captured.body as { plan: { week: Array<{ exercises: Array<{ exercise_id: string; sets: Array<{ target_load_kg: number | null }> }> }> } }).plan;
    const loadAfter = after.week.flatMap((d) => d.exercises)
      .find((e) => e.exercise_id === "barbell_squat")?.sets.find((s) => s.target_load_kg !== null)?.target_load_kg;
    // 편집 한 번에 처방이 1주차(null)로 되돌아가면 안 된다.
    expect(loadAfter).toBe(loadBefore);
  });
});

describe("요일 이동 — PUT /v1/plans/current (op: move · 계약 §2.2 · D22-4 · 019 M4)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";

  /** 두 날에 서로 다른 종목이 있는 드래프트. 요일 이동은 **날**이 대상이다. */
  const draftWith = (days: Record<number, string[]>) => ({
    week: Object.entries(days).map(([day, ids]) => ({
      day_index: Number(day),
      session_type: "lift",
      focus: "",
      items: ids.map((id, i) => ({ kind: "strength", exercise_id: id, role: "accessory", order: i + 1, rep_intent: "hypertrophy" })),
    })),
  });

  function seed(days: Record<number, string[]>, extra: Record<string, unknown> = {}) {
    weeksOf("u1").set(WEEK, {
      user_id: "u1",
      week_start_date: WEEK,
      plan: { plan_meta: { week_number: 2 }, week: [] },
      draft: draftWith(days),
      profile: SAMPLE.profile,
      ...extra,
    });
  }

  const put = async (payload: unknown) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", body: payload, query: {}, path: "/v1/plans/current", headers: AUTH }, r);
    return r.captured;
  };

  /** 저장된 드래프트에서 그 요일의 종목 id 들(순서 그대로). */
  const draftIdsOn = (dayIndex: number) => {
    const stored = weeksOf("u1").get(WEEK) as { draft: { week: Array<{ day_index: number; items: Array<{ exercise_id: string }>; session_type: string }> } };
    const day = stored.draft.week.find((d) => d.day_index === dayIndex);
    return { ids: (day?.items ?? []).map((i) => i.exercise_id), type: day?.session_type };
  };

  it("빈 요일로 옮기면 그냥 간다 — swap·merge 가 같은 결과다", async () => {
    for (const mode of ["swap", "merge", undefined]) {
      seed({ 0: ["barbell_squat", "barbell_bench_press"] });
      const out = await put({ op: "move", day_index: 0, to_day_index: 3, ...(mode ? { mode } : {}) });

      expect(out.code, String(mode)).toBe(200);
      expect(draftIdsOn(3).ids, String(mode)).toEqual(["barbell_squat", "barbell_bench_press"]);
      expect(draftIdsOn(0).ids, String(mode)).toEqual([]);
      expect(draftIdsOn(0).type, String(mode)).toBe("rest"); // 떠난 자리는 휴식일이다
    }
  });

  it("맞바꾸기 — 두 날이 통째로 교환된다(덮어쓰기가 아니다)", async () => {
    seed({ 0: ["barbell_squat"], 2: ["barbell_bench_press"] });
    const out = await put({ op: "move", day_index: 0, to_day_index: 2, mode: "swap" });

    expect(out.code).toBe(200);
    expect(draftIdsOn(2).ids).toEqual(["barbell_squat"]);
    // **대상 날 운동이 사라지지 않는다** — 사라지면 그 주에서 없어지고 되돌릴 길이 없다.
    expect(draftIdsOn(0).ids).toEqual(["barbell_bench_press"]);
  });

  it("맞바꾸기는 왕복하면 제자리다", async () => {
    seed({ 0: ["barbell_squat"], 2: ["barbell_bench_press"] });
    await put({ op: "move", day_index: 0, to_day_index: 2, mode: "swap" });
    await put({ op: "move", day_index: 0, to_day_index: 2, mode: "swap" });

    expect(draftIdsOn(0).ids).toEqual(["barbell_squat"]);
    expect(draftIdsOn(2).ids).toEqual(["barbell_bench_press"]);
  });

  it("합치기 — 두 날이 대상에 모이고 원래 날은 휴식일이 된다", async () => {
    seed({ 0: ["barbell_squat"], 2: ["barbell_bench_press"] });
    const out = await put({ op: "move", day_index: 0, to_day_index: 2, mode: "merge" });

    expect(out.code).toBe(200);
    expect(draftIdsOn(2).ids).toEqual(["barbell_bench_press", "barbell_squat"]);
    expect(draftIdsOn(0).ids).toEqual([]);
    expect(draftIdsOn(0).type).toBe("rest");
  });

  it("합치기 — 같은 종목이 두 줄이 되지 않는다", async () => {
    seed({ 0: ["barbell_squat", "barbell_bench_press"], 2: ["barbell_squat"] });
    await put({ op: "move", day_index: 0, to_day_index: 2, mode: "merge" });

    // 중복이면 볼륨이 두 번 잡힌다 — add 가 중복을 막는 것과 같은 이유다.
    expect(draftIdsOn(2).ids).toEqual(["barbell_squat", "barbell_bench_press"]);
  });

  it("합친 뒤 order 가 겹치지 않는다 — 어느 종목이 주 운동인지가 흔들리면 안 된다", async () => {
    seed({ 0: ["barbell_squat"], 2: ["barbell_bench_press"] });
    await put({ op: "move", day_index: 0, to_day_index: 2, mode: "merge" });

    const stored = weeksOf("u1").get(WEEK) as { draft: { week: Array<{ day_index: number; items: Array<{ order?: number }> }> } };
    const orders = stored.draft.week.find((d) => d.day_index === 2)!.items.map((i) => i.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("교환하면 기록·진행 초안도 운동을 따라간다 — 잠금 없음 (계약 §2.2 · D79)", async () => {
    // 월(0)에 한 기록 · 수(2)는 진행 초안만. 0↔2 를 맞바꾸면 기록은 수로, 초안은 월로 간다.
    const session = { schema_version: "1.0", session_id: "s", plan_id: "p", date: WEEK, day_index: 0, completion: "completed", exercises: [], stale_key: "x" };
    const draft = { plan_id: "p", plan_generated_at: "old", revision: 4, updated_at: "t", closed: false, progress: { barbell_bench_press: [{ done: true, kg: "40", reps: "8" }] } };
    seed({ 0: ["barbell_squat"], 2: ["barbell_bench_press"] }, { sessions: { 0: session, 2: { schema_version: "1.0", session_id: "w", plan_id: "p", date: WEEK, day_index: 2, completion: "partial", exercises: [], extra_old: 1 } }, progress_drafts: { 2: draft } });
    // 수(2)에도 기록이 있으면 맞바뀐다 — 옛 수요일 기록의 키(`extra_old`)가 월요일 자리에 섞이지 않는다(통째 교체).
    const out = await put({ op: "move", day_index: 0, to_day_index: 2, mode: "swap" });
    expect(out.code).toBe(200);
    expect(draftIdsOn(2).ids).toEqual(["barbell_squat"]);
    const doc = weeksOf("u1").get(WEEK) as { sessions: Record<string, Record<string, unknown>>; progress_drafts: Record<string, Record<string, unknown>>; plan: { plan_meta: { generated_at: string } } };
    expect(doc.sessions["2"]).toMatchObject({ session_id: "s", day_index: 2, stale_key: "x" });
    expect(doc.sessions["2"]!.date).toBe(addDaysIso(WEEK, 2));
    expect(doc.sessions["0"]).toMatchObject({ day_index: 0, date: WEEK, extra_old: 1 });
    expect(doc.sessions["0"]).not.toHaveProperty("stale_key");
    // 초안은 닫히지 않고 월로 — 입력 그대로, 새 플랜 시각. 빈 자리(수)는 지워진다.
    expect(doc.progress_drafts["0"]).toMatchObject({ closed: false, revision: 4, progress: draft.progress, plan_generated_at: doc.plan.plan_meta.generated_at });
    expect(doc.progress_drafts["2"]).toBeUndefined();

    // 한쪽에만 기록 — 되돌리면(2→0 … 여기선 0↔3 빈 날) 기록이 옮겨 가고 빈 자리는 지워진다.
    const back = await put({ op: "move", day_index: 0, to_day_index: 3, mode: "swap" });
    expect(back.code).toBe(200);
    const after = weeksOf("u1").get(WEEK) as { sessions: Record<string, Record<string, unknown>> };
    expect(after.sessions["3"]).toMatchObject({ day_index: 3, date: addDaysIso(WEEK, 3), extra_old: 1 });
    expect(after.sessions["0"]).toBeUndefined();
  });

  it("실제로 합쳐지는 merge 는 기록을 옮기지 않고 두 날 초안을 닫는다 (계약 §2.2 · D79 ③)", async () => {
    const session = { schema_version: "1.0", session_id: "s", plan_id: "p", date: WEEK, day_index: 0, completion: "completed", exercises: [] };
    const draft = { plan_id: "p", plan_generated_at: "old", revision: 1, updated_at: "t", closed: false, progress: {} };
    seed({ 0: ["barbell_squat"], 2: ["barbell_bench_press"] }, { sessions: { 0: session }, progress_drafts: { 0: draft } });
    expect((await put({ op: "move", day_index: 0, to_day_index: 2, mode: "merge" })).code).toBe(200);
    const doc = weeksOf("u1").get(WEEK) as { sessions: Record<string, unknown>; progress_drafts: Record<string, Record<string, unknown>> };
    expect(doc.sessions["0"]).toMatchObject({ day_index: 0 });
    expect(doc.sessions["2"]).toBeUndefined();
    expect(doc.progress_drafts["0"]).toMatchObject({ closed: true, closed_reason: "plan_replaced" });
  });

  it("계약 밖 move 는 400 — 같은 요일·범위 밖·모르는 mode", async () => {
    seed({ 0: ["barbell_squat"] });
    for (const bad of [
      { op: "move", day_index: 0, to_day_index: 0 },
      { op: "move", day_index: 0, to_day_index: 7 },
      { op: "move", day_index: 0 },
      { op: "move", day_index: 0, to_day_index: 2, mode: "overwrite" },
    ]) {
      expect((await put(bad)).code, JSON.stringify(bad)).toBe(400);
    }
  });

  it("원본이 비어 있어도 거절하지 않는다 — swap 은 대칭이다 (계약 §2.2)", async () => {
    seed({ 2: ["barbell_bench_press"] });
    // 빈 5요일과 2요일을 맞바꾸면, 2요일 운동이 5요일로 간다.
    const out = await put({ op: "move", day_index: 5, to_day_index: 2, mode: "swap" });

    expect(out.code).toBe(200);
    expect(draftIdsOn(5).ids).toEqual(["barbell_bench_press"]);
    expect(draftIdsOn(2).ids).toEqual([]);
    expect(draftIdsOn(2).type).toBe("rest");

    // **반대 방향으로 옮긴 것과 결과가 같다** — 그게 대칭의 뜻이다.
    seed({ 2: ["barbell_bench_press"] });
    await put({ op: "move", day_index: 2, to_day_index: 5, mode: "swap" });
    expect(draftIdsOn(5).ids).toEqual(["barbell_bench_press"]);
    expect(draftIdsOn(2).ids).toEqual([]);
  });

  it("휴식일에 종목을 추가할 수 있다 (018 §4-3)", async () => {
    // 드래프트에 없던 날이다 — 만들어 주지 않으면 "추가했는데 사라진다"가 된다.
    seed({ 0: ["barbell_squat"] });
    const out = await put({ op: "add", day_index: 4, to_exercise_id: "dumbbell_bicep_curl" });

    expect(out.code).toBe(200);
    expect(draftIdsOn(4).ids).toEqual(["dumbbell_bicep_curl"]);
    expect(draftIdsOn(4).type).toBe("lift"); // 휴식일이면 확장이 항목을 통째로 버린다
    const plan = (out.body as { plan: { week: Array<{ day_index: number; exercises: Array<{ exercise_id: string }> }> } }).plan;
    expect((plan.week.find((d) => d.day_index === 4)?.exercises ?? []).map((e) => e.exercise_id)).toContain("dumbbell_bicep_curl");
  });
});

describe("데이터 삭제 — DELETE /v1/plans (NFR-PRIV-2 · 019 M2.5)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);

  function seedUser(uid: string) {
    for (const week of ["2026-08-10", "2026-08-17"]) {
      weeksOf(uid).set(week, {
        user_id: uid,
        week_start_date: week,
        plan: { plan_meta: { week_number: 1 }, week: [] },
        profile: SAMPLE.profile,
        sessions: { 0: { session_id: `s-${uid}` } },
      });
    }
    store("rate_limits").set(uid, { uid, week_start: "2026-08-17", count: 2 });
  }

  const del = async (headers: Record<string, string> = AUTH) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "DELETE", query: {}, path: "/v1/plans", headers }, r);
    return r.captured;
  };

  it("주차 문서를 하나도 남기지 않는다 — 하위 컬렉션은 부모를 지워도 남는다", async () => {
    seedUser("u1");
    expect(weeksOf("u1").size).toBe(2);

    const out = await del();
    expect(out.code).toBe(200);
    expect((out.body as { deleted_weeks: number }).deleted_weeks).toBe(2);
    expect(weeksOf("u1").size).toBe(0);
    // 실측 운동 기록은 주차 문서 안에 있으므로 같이 사라진다(§2.4).
    // 한도 카운터는 남는다 — 앱 안 초기화로 주간 생성 한도를 되살리지 못한다(§2.5 · 백로그 037).
    expect(store("rate_limits").get("u1")?.count).toBe(2);
  });

  it("남의 데이터는 지우지 않는다", async () => {
    seedUser("u1");
    seedUser("u2");
    await del();

    expect(weeksOf("u1").size).toBe(0);
    expect(weeksOf("u2").size).toBe(2);
    expect(store("rate_limits").has("u2")).toBe(true);
  });

  it("멱등이다 — 지울 것이 없어도 200", async () => {
    // 탈퇴 처리는 여러 번 올 수 있다. 없는 것을 404 로 알리면 실패로 보인다.
    expect((await del()).code).toBe(200);
    seedUser("u1");
    expect((await del()).code).toBe(200);
    expect((await del()).code).toBe(200);
  });

  it("하위 경로에서는 지워지지 않는다 — 한 주만 지우려던 요청이 계정을 날리면 안 된다", async () => {
    seedUser("u1");
    const r = res();
    await (plansGet as unknown as Handler)({ method: "DELETE", query: {}, path: "/v1/plans/current", headers: AUTH }, r);

    expect(r.captured.code).toBe(404);
    expect(weeksOf("u1").size).toBe(2);
  });

  it("인증이 없으면 401 이고 아무것도 지우지 않는다", async () => {
    seedUser("u1");
    const out = await del({} as typeof AUTH);
    expect(out.code).toBe(401);
    expect(weeksOf("u1").size).toBe(2);
  });

  // ── 탈퇴 콜백 (계약 §2.5.1) — 같은 삭제를 토스가 부른다 ──────────────────
  const withdraw = async (body: unknown, headers: Record<string, string> = { authorization: "Basic id:pw" }) => {
    process.env.TOSS_WITHDRAW_BASIC = "id:pw";
    const r = res();
    await (tossWithdraw as unknown as Handler)({ method: "POST", query: {}, path: "/v1/webhooks/toss/withdraw", headers, body }, r);
    delete process.env.TOSS_WITHDRAW_BASIC;
    return r.captured;
  };

  it("캡처된 본문이 오면 그 userKey 의 데이터를 지운다", async () => {
    // uid 는 로그인이 만드는 것과 같은 모양이어야 한다(`toss:{userKey}`).
    seedUser("toss:12345");
    seedUser("u2");

    expect((await withdraw({ userKey: 12345, referrer: "UNLINK" })).code).toBe(200);
    expect(weeksOf("toss:12345").size).toBe(0);
    expect(weeksOf("u2").size).toBe(2); // 남의 것은 그대로
  });

  it("모르는 본문이면 200 이지만 아무것도 지우지 않는다 — 삭제는 되돌릴 수 없다", async () => {
    seedUser("toss:12345");
    for (const body of [{ userKey: 12345, referrer: "LOGIN" }, { userKey: 12345 }, { referrer: "UNLINK" }, "userKey=12345"]) {
      expect((await withdraw(body)).code).toBe(200);
      expect(weeksOf("toss:12345").size).toBe(2);
    }
  });

  it("Basic 인증이 틀리면 401 이고 지우지 않는다", async () => {
    seedUser("toss:12345");
    const out = await withdraw({ userKey: 12345, referrer: "UNLINK" }, { authorization: "Basic wrong" });
    expect(out.code).toBe(401);
    expect(weeksOf("toss:12345").size).toBe(2);
  });

  it("잡도 지운다 — 잡 문서에 완성된 플랜과 푸시 토큰이 들어 있다", async () => {
    seedUser("u1");
    docs.set("j1", { job_id: "j1", user_id: "u1", status: "ok", plan: {}, fcm_token: "tok" });
    docs.set("j2", { job_id: "j2", user_id: "u2", status: "ok", plan: {} });

    await del();
    // TTL 24시간이 있지만 "지체 없이 파기"는 24시간이 아니다.
    expect(docs.has("j1")).toBe(false);
    expect(docs.has("j2")).toBe(true); // 남의 잡은 그대로
  });

  it("삭제 직후 돌던 생성이 데이터를 되살리지 않는다", async () => {
    // 삭제가 잡을 지우므로 워커는 자기 잡이 사라진 것을 보고 저장을 건너뛴다.
    docs.set("job-gone", { job_id: "job-gone", user_id: "u1", status: "queued" });
    const llm: FakeLlm = await startFakeLlm([CASES[SAMPLE.id]!.draft], { delayMs: 40 });
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.LLM_PROVIDER = "minimax";
    process.env.LLM_API_KEY = "fake-key";
    process.env.LLM_BASE_URL = llm.baseUrl;
    process.env.LLM_MODEL = "fake-model";
    process.env.GENERATION_PIPELINE = "p0"; // 가짜 LLM 은 P0 드래프트 — 기본 auto 면 헬스장이 P1(D105 ①)
    const headers: Record<string, string> = { "content-type": "application/json", "x-cloudtasks-queuename": "plansWorker" };
    // **생성이 도는 중에** 지운다 — 시작 전에 지우면 다른 시점(아래 별도 테스트)이다.
    setTimeout(() => docs.delete("job-gone"), 5);

    const r = res();
    try {
      await (plansWorker as unknown as Handler)(
        { method: "POST", headers, body: { data: { jobId: "job-gone", req: body() } }, header: (n: string) => headers[n.toLowerCase()] },
        r,
      );
    } finally {
      await llm.close();
    }

    // 태스크는 정상 종료한다(재큐잉 없음) — 잡 소실은 오류가 아니라 취소다.
    expect(r.captured.code).toBe(204);
    // **생성은 실제로 돌았다** — 돌지도 않고 통과하면 이 테스트는 가드를 안 지난다.
    expect(llm.requests.length).toBeGreaterThan(0);
    expect(weeksOf("u1").size).toBe(0); // 지운 뒤에 되살아나지 않는다
    expect(docs.has("job-gone")).toBe(false); // 잡을 되살리지도 않는다
  });

  it("시작 전에 지워졌으면 워커가 조용히 끝난다 — 오류가 아니라 취소다", async () => {
    // 큐에 들어간 뒤 시작 전에 지울 수 있다. 그냥 update 하면 NOT_FOUND 로 500 이 된다.
    const llm: FakeLlm = await startFakeLlm([CASES[SAMPLE.id]!.draft]);
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.LLM_PROVIDER = "minimax";
    process.env.LLM_API_KEY = "fake-key";
    process.env.LLM_BASE_URL = llm.baseUrl;
    process.env.LLM_MODEL = "fake-model";
    process.env.GENERATION_PIPELINE = "p0"; // 가짜 LLM 은 P0 드래프트 — 기본 auto 면 헬스장이 P1(D105 ①)
    const headers: Record<string, string> = { "content-type": "application/json", "x-cloudtasks-queuename": "plansWorker" };

    const r = res();
    try {
      await (plansWorker as unknown as Handler)(
        { method: "POST", headers, body: { data: { jobId: "never-existed", req: body() } }, header: (n: string) => headers[n.toLowerCase()] },
        r,
      );
    } finally {
      await llm.close();
    }

    expect(r.captured.code).toBe(204);
    expect(llm.requests).toHaveLength(0); // LLM 을 부르지도 않는다(비용 0)
    expect(weeksOf("u1").size).toBe(0);
  });

  it("지운 뒤에는 GET current 가 404 다", async () => {
    seedUser("u1");
    await del();
    const r = res();
    await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/current"), r);
    expect(r.captured.code).toBe(404);
  });
});

describe("전체 검색 — GET .../candidates?q= (D20-1 탈출구 · 019 M7)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";
  const DRAFT = CASES[SAMPLE.id]!.draft;

  /** 장비를 맨몸으로 좁히고 어깨를 금기로 잡은 프로필 — 추천이 크게 걸러진다. */
  const NARROW = {
    ...SAMPLE.profile,
    equipment: ["body only"],
    injuries: [{ region: "shoulders" }],
  };

  function seed(profile: unknown = NARROW) {
    // **플랜과 드래프트를 같은 내용으로 심는다** — 배포본은 둘을 함께 쓴다.
    // 어긋나게 심으면 후보(플랜을 읽는다)와 편집(드래프트를 읽는다)이 다른 세상을
    // 보게 돼, 테스트만 실패하고 실제 결함은 아닌 상황이 만들어진다.
    const day0 = (DRAFT as { week: Array<{ day_index: number; items: Array<{ exercise_id?: string }> }> })
      .week.find((d) => d.day_index === 0);
    weeksOf("u1").set(WEEK, {
      user_id: "u1",
      week_start_date: WEEK,
      plan: {
        plan_meta: { week_number: 1 },
        week: [{ day_index: 0, exercises: (day0?.items ?? []).filter((i) => i.exercise_id).map((i) => ({ exercise_id: i.exercise_id })) }],
      },
      draft: structuredClone(DRAFT),
      profile,
    });
  }

  const candidates = async (q?: string) => {
    const r = res();
    const query: Record<string, string> = { day_index: "0", ...(q === undefined ? {} : { q }) };
    await (plansGet as unknown as Handler)(
      { method: "GET", query, path: "/v1/plans/current/candidates", headers: AUTH },
      r,
    );
    return r.captured;
  };

  it("검색은 추천이 거른 것 밖으로 나간다 — 장비 밖 종목이 나온다", async () => {
    seed();
    const recommended = (await candidates()).body as { candidates: Array<{ id: string; equipment: string }> };
    // 추천은 프로필 장비로 좁힌다 — 맨몸만 남는다.
    expect(recommended.candidates.every((c) => c.equipment === "body only")).toBe(true);

    const found = (await candidates("바벨")).body as { candidates: Array<{ id: string; equipment: string }> };
    expect(found.candidates.length).toBeGreaterThan(0);
    // **장비 밖이 나온다** — 걸러진 것만 고를 수 있으면 추천이 아니라 강제다(D20-1).
    expect(found.candidates.some((c) => c.equipment === "barbell")).toBe(true);
  });

  it("검색은 OR 다 — 「덤벨 프레스」는 덤벨 종목과 프레스 종목이 다 나온다(사용자 결정 2026-09-08)", async () => {
    seed();
    const both = (await candidates("덤벨 프레스")).body as { candidates: Array<{ id: string; name_ko: string }> };
    expect(both.candidates.length).toBeGreaterThan(0);
    // 낱말 하나라도 들어가면 맞는다 — 둘 다 든 종목만 나오는 AND 가 아니다.
    const labels = exerciseLabels as Record<string, { aliases: string[] }>;
    expect(both.candidates.every((c) => [c.name_ko, ...(labels[c.id]?.aliases ?? [])]
      .some((name) => name.includes("덤벨") || name.includes("프레스")))).toBe(true);
    const dumbbellOnly = both.candidates.filter((c) => c.name_ko.includes("덤벨") && !c.name_ko.includes("프레스"));
    const pressOnly = both.candidates.filter((c) => c.name_ko.includes("프레스") && !c.name_ko.includes("덤벨"));
    expect(dumbbellOnly.length + pressOnly.length).toBeGreaterThan(0);
  });

  it("검색도 부상 금기는 넘지 않는다 — 고르면 사라질 것을 보여주지 않는다", async () => {
    seed();
    // FR-GEN-4 가 "최종 플랜의 금기 교집합 = 0" 을 하드 AC 로 잡아, 금기 종목은
    // 골라도 재확장이 다시 빼낸다. 검색에 실으면 **고르면 조용히 사라지는 항목**이
    // 되는데 그건 D20-1 이 없애려던 경험이다. 이 선을 옮기려면 G4 가 필요하다.
    const found = (await candidates("숄더")).body as { candidates: Array<{ primary_muscles: string[] }> };
    expect(found.candidates.some((c) => c.primary_muscles.includes("shoulders"))).toBe(false);
    // 금기가 없는 프로필에서는 같은 검색이 나온다 — 검색 자체가 죽은 게 아니다.
    seed(SAMPLE.profile);
    const open = (await candidates("숄더")).body as { candidates: unknown[] };
    expect(open.candidates.length).toBeGreaterThan(0);
  });

  it("검색 결과에 경고 표시를 붙이지 않는다 — 응답 모양이 추천과 같다", async () => {
    seed();
    const found = (await candidates("바벨")).body as { candidates: Array<Record<string, unknown>> };
    // D20-1: 강제도 **경고도** 없다. 안전은 상시 면책 문구로만 남는다.
    for (const c of found.candidates) {
      expect(Object.keys(c).sort()).toEqual(["equipment", "id", "name_ko", "primary_muscles"]);
    }
  });

  it("검색으로 고른 장비 밖 종목이 거절 없이 저장된다", async () => {
    seed();
    const found = (await candidates("바벨")).body as { candidates: Array<{ id: string; equipment: string }> };
    const outOfKit = found.candidates.find((c) => c.equipment === "barbell")!;

    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "PUT", body: { op: "add", day_index: 0, to_exercise_id: outOfKit.id }, query: {}, path: "/v1/plans/current", headers: AUTH },
      r,
    );

    // 정책으로 거절하지 않는다(D20-1) — 사용자가 자기 플랜에 대해 내린 결정이다.
    expect(r.captured.code, JSON.stringify(r.captured.body)).toBe(200);
    const plan = (r.captured.body as { plan: { week: Array<{ day_index: number; exercises: Array<{ exercise_id: string }> }> } }).plan;
    expect((plan.week.find((d) => d.day_index === 0)?.exercises ?? []).map((e) => e.exercise_id)).toContain(outOfKit.id);
  });

  it("유산소는 검색으로도 들어오지 않는다 — 프로필이 정한다", async () => {
    seed();
    const found = (await candidates("사이클")).body as { candidates: Array<{ id: string }> };
    expect(found.candidates.some((c) => c.id.includes("bike") || c.id.includes("cycling"))).toBe(false);
  });

  it("공백·대소문자를 가리지 않고, 상한은 40개다", async () => {
    // 금기 없는 프로필로 본다 — 여기서 보는 것은 검색어 처리이지 필터가 아니다.
    seed(SAMPLE.profile);
    const spaced = (await candidates("벤치 프레스")).body as { candidates: Array<{ id: string }> };
    expect(spaced.candidates.length).toBeGreaterThan(0);
    // 영문 id 로도 찾는다.
    const byId = (await candidates("BARBELL")).body as { candidates: Array<{ id: string }> };
    expect(byId.candidates.length).toBeGreaterThan(0);
    expect(byId.candidates.length).toBeLessThanOrEqual(40);
  });

  it("q 가 없거나 공백뿐이면 예전 그대로다 — 추천 경로가 바뀌지 않았다", async () => {
    seed(NARROW);
    const recommended = (await candidates()).body as { candidates: Array<{ equipment: string }> };
    expect(recommended.candidates.length).toBeGreaterThan(0);

    // **공백뿐인 q 가 필터를 우회하면 안 된다** — 빈 문자열은 모든 이름에 걸린다.
    const blank = (await candidates("   ")).body as { candidates: Array<{ equipment: string }> };
    expect(blank.candidates).toEqual(recommended.candidates);
    expect(blank.candidates.every((c) => c.equipment === "body only")).toBe(true);
  });
});

describe("부위 훑기 — GET .../candidates?muscle= (백로그 020)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";
  const DRAFT = CASES[SAMPLE.id]!.draft;

  /** 맨몸 + 어깨 금기 — 장비 필터와 금기가 둘 다 보이는 프로필이다. */
  const NARROW = { ...SAMPLE.profile, equipment: ["body only"], injuries: [{ region: "shoulders" }] };

  function seed(profile: unknown = NARROW) {
    const day0 = (DRAFT as { week: Array<{ day_index: number; items: Array<{ exercise_id?: string }> }> })
      .week.find((d) => d.day_index === 0);
    weeksOf("u1").set(WEEK, {
      user_id: "u1",
      week_start_date: WEEK,
      plan: {
        plan_meta: { week_number: 1 },
        week: [{ day_index: 0, exercises: (day0?.items ?? []).filter((i) => i.exercise_id).map((i) => ({ exercise_id: i.exercise_id })) }],
      },
      draft: structuredClone(DRAFT),
      profile,
    });
  }

  type Body = { candidates: Array<{ id: string; equipment: string; primary_muscles: string[] }>; muscle_counts: Record<string, number>; total: number };
  const candidates = async (query: Record<string, string>) => {
    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "GET", query: { day_index: "0", ...query }, path: "/v1/plans/current/candidates", headers: AUTH },
      r,
    );
    return r.captured;
  };

  it("부위로 좁힌다 — 그 날의 근육군이 아니라 고른 근육이 기준이다", async () => {
    seed(SAMPLE.profile);
    const back = (await candidates({ muscle: "lats,middle back,lower back,traps" })).body as Body;
    expect(back.candidates.length).toBeGreaterThan(0);
    // 고른 부위 밖은 한 개도 없다.
    const wanted = new Set(["lats", "middle back", "lower back", "traps"]);
    expect(back.candidates.every((c) => c.primary_muscles.some((m) => wanted.has(m)))).toBe(true);

    // 추천과 다른 목록이다 — 아니면 파라미터가 아무 일도 안 한 것이다.
    const recommended = (await candidates({})).body as Body;
    expect(back.candidates.map((c) => c.id)).not.toEqual(recommended.candidates.map((c) => c.id));
  });

  it("훑기는 장비를 지킨다 — `q` 와 다른 문이다", async () => {
    seed(); // 맨몸만
    const back = (await candidates({ muscle: "lats" })).body as Body;
    expect(back.candidates.length).toBeGreaterThan(0);
    // D20-1 탈출구는 `q` 하나다. 훑기는 추천의 확장이라 못 하는 종목을 열지 않는다.
    expect(back.candidates.every((c) => c.equipment === "body only")).toBe(true);
  });

  it("금기 근육은 목록에도 개수에도 없다", async () => {
    seed(); // 어깨 금기
    const shoulders = (await candidates({ muscle: "shoulders" })).body as Body;
    expect(shoulders.candidates).toEqual([]);
    // 개수가 0이면 클라이언트가 칩을 그리지 않는다 — 눌러서 빈 목록이 나올 일이 없다.
    expect(shoulders.muscle_counts.shoulders ?? 0).toBe(0);
    expect((shoulders.muscle_counts.abdominals ?? 0)).toBeGreaterThan(0);
  });

  it("개수는 프로필 장비를 반영한다 — 카탈로그 전수가 아니다", async () => {
    seed();
    const bodyOnly = (await candidates({})).body as Body;
    seed(SAMPLE.profile);
    const gym = (await candidates({})).body as Body;
    expect(gym.muscle_counts.lats!).toBeGreaterThan(bodyOnly.muscle_counts.lats ?? 0);
    // 유산소는 세지 않는다 — 후보에도 안 나오므로 개수만 있으면 거짓말이 된다.
    expect(Object.keys(gym.muscle_counts).length).toBeGreaterThan(0);
  });

  it("검색어와 선택 부위를 함께 적용한다", async () => {
    seed(SAMPLE.profile);
    const both = (await candidates({ muscle: "lats", q: "풀" })).body as Body;
    expect(both.candidates.length).toBeGreaterThan(0);
    expect(both.candidates.every((c) => c.primary_muscles.includes("lats"))).toBe(true);
    const other = (await candidates({ muscle: "biceps", q: "벤치프레스" })).body as Body;
    expect(other.candidates).toEqual([]);
    const all = (await candidates({ q: "벤치프레스" })).body as Body;
    expect(all.candidates.some((c) => c.primary_muscles.includes("chest"))).toBe(true);
  });

  it("카탈로그에 없는 근육은 400", async () => {
    seed();
    const r = await candidates({ muscle: "lats,gluteus_maximus" });
    expect(r.code).toBe(400);
    expect((r.body as { message: string }).message).toContain("gluteus_maximus");
  });

  it("bodyweight_only 는 맨몸만 나온다 — 프리셋이 빈 배열이어도 제한 없음이 아니다", async () => {
    // `ENV_PRESET.bodyweight_only` 는 `[]` 다. `profile.equipment` 만 보면 그게
    // "제한 없음"으로 읽혀, 아무 장비도 없다고 답한 사람에게 케틀벨이 나왔다.
    seed({ ...SAMPLE.profile, environment: "bodyweight_only", equipment: [] });
    const back = (await candidates({ muscle: "lats,middle back,lower back,traps" })).body as Body;
    expect(back.candidates.length).toBeGreaterThan(0);
    expect(back.candidates.every((c) => c.equipment === "body only")).toBe(true);
    // 추천 경로도 같은 규칙이다 — 훑기에서만 고치면 두 목록이 갈린다.
    const recommended = (await candidates({})).body as Body;
    expect(recommended.candidates.every((c) => c.equipment === "body only")).toBe(true);
    // 개수도 같은 좁히기를 쓴다 — 칩 숫자가 못 하는 종목을 세면 거짓말이다.
    // 도구(`requires`)를 빼면 맨몸 광배 주동 종목은 0 이라 키가 없다(운동목록 N1) — 등은 로우류(middle back)로 남는다.
    expect(back.muscle_counts.lats ?? 0).toBeLessThan(38); // 카탈로그 전수 38
    expect(back.muscle_counts["middle back"]).toBeGreaterThan(0);
  });

  it("검색 중에도 잘못된 muscle 은 400", async () => {
    seed(SAMPLE.profile);
    const r = await candidates({ muscle: "nope", q: "벤치" });
    expect(r.code).toBe(400);
  });

  it("40개 뒤의 EZ바 컬도 더 보기로 고를 수 있다", async () => {
    seed({ ...SAMPLE.profile, equipment: [], injuries: [] });
    const first = (await candidates({ muscle: "biceps" })).body as Body;
    expect(first.candidates).toHaveLength(40);
    const more = (await candidates({ muscle: "biceps", limit: "1000" })).body as Body;
    expect(more.total).toBe(first.total);
    expect(more.candidates).toHaveLength(more.total);
    expect(more.candidates.slice(0, 40)).toEqual(first.candidates);
    expect(more.candidates.some((c) => c.id === "ez_bar_curl")).toBe(true);
    expect(new Set(more.candidates.map((c) => c.id)).size).toBe(more.total);
  });

  it.each(["0", "-1", "1.5", "1001", "nope"])("잘못된 limit=%s 은 400", async (limit) => {
    seed(SAMPLE.profile);
    expect((await candidates({ q: "컬", limit })).code).toBe(400);
  });

  it.each([
    ["이지바", "ez_bar_curl"], ["이지바 바벨컬", "ez_bar_curl"], ["EZ바컬", "ez_bar_curl"], ["EZ", "ez_bar_curl"],
    ["이지바 바벨", "barbell_curl"],
    ["티바", "t_bar_row_with_handle"], ["브이바", "v_bar_pulldown"],
    ["제이엠", "jm_press"], ["에스엠알", "calves_smr"],
    ["ㅂㅂㅋ", "barbell_curl"], ["벤ㅊ", "barbell_bench_press_medium_grip"],
  ])("%s 검색으로 기존 종목을 찾는다", async (q, id) => {
    seed({ ...SAMPLE.profile, equipment: [], injuries: [] });
    const week = weeksOf("u1").get(WEEK) as { plan: { week: unknown[] } };
    week.plan.week = [];
    const found = (await candidates({ q, limit: "1000" })).body as Body;
    expect(found.candidates.some((c) => c.id === id)).toBe(true);
  });

  it("한글 검색도 금기를 지키고, 명시한 부위 안에서는 장비 밖까지 찾는다", async () => {
    seed({ ...SAMPLE.profile, environment: "bodyweight_only", equipment: [], injuries: [] });
    const found = (await candidates({ muscle: "biceps", q: "이지바" })).body as Body;
    expect(found.candidates.some((c) => c.id === "ez_bar_curl")).toBe(true);
    expect(found.candidates.every((c) => c.primary_muscles.includes("biceps"))).toBe(true);
    seed({ ...SAMPLE.profile, injuries: [{ region: "biceps" }] });
    expect(((await candidates({ muscle: "biceps", q: "이지바" })).body as Body).candidates).toEqual([]);
  });

  it("칩 개수는 목록과 같은 것을 센다 — 1인데 눌러서 빈 목록이 나오지 않는다", async () => {
    seed(SAMPLE.profile);
    // 후보 하나를 그 날에 심고 개수가 그만큼 줄어드는지 본다.
    const before = (await candidates({ muscle: "biceps" })).body as Body;
    const victim = before.candidates[0]!;
    const week = weeksOf("u1").get(WEEK) as { plan: { week: Array<{ day_index: number; exercises: Array<{ exercise_id: string }> }> } };
    week.plan.week.find((d) => d.day_index === 0)!.exercises.push({ exercise_id: victim.id });

    const after = (await candidates({ muscle: "biceps" })).body as Body;
    expect(after.candidates.map((c) => c.id)).not.toContain(victim.id);
    expect(after.muscle_counts.biceps!).toBe(before.muscle_counts.biceps! - 1);
  });

  it("muscle 이 없으면 예전 그대로다 — 추천 경로가 바뀌지 않았다", async () => {
    seed();
    const before = (await candidates({})).body as Body;
    const blank = (await candidates({ muscle: "" })).body as Body;
    expect(blank.candidates).toEqual(before.candidates);
  });
});

describe("렙 범위 의도 — PUT /v1/plans/current (op: retarget · 019 M8)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";
  const DRAFT = CASES[SAMPLE.id]!.draft as { week: Array<{ day_index: number; items: Array<{ exercise_id?: string }> }> };

  function seed() {
    weeksOf("u1").set(WEEK, {
      user_id: "u1",
      week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1 }, week: [] },
      draft: structuredClone(DRAFT),
      profile: SAMPLE.profile,
    });
  }

  const put = async (payload: unknown) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", body: payload, query: {}, path: "/v1/plans/current", headers: AUTH }, r);
    return r.captured;
  };

  /** 그 종목 워킹 세트의 렙 범위. 의도가 실제로 닿았는지는 이 값으로만 보인다. */
  const repsOf = (plan: unknown, id: string) => {
    const ex = ((plan as { week: Array<{ exercises: Array<{ exercise_id: string; sets: Array<{ set_kind: string; target_reps_low: number; target_reps_high: number }> }> }> }).week ?? [])
      .flatMap((d) => d.exercises).find((e) => e.exercise_id === id);
    const working = (ex?.sets ?? []).filter((s) => s.set_kind === "working")[0];
    return working && { low: working.target_reps_low, high: working.target_reps_high };
  };

  const firstId = () => DRAFT.week.find((d) => d.day_index === 0)!.items.find((i) => i.exercise_id)!.exercise_id!;

  it("의도를 바꾸면 렙 범위가 실제로 바뀐다 — 저장만 되고 끝나면 안 된다", async () => {
    seed();
    const id = firstId();

    const strength = await put({ op: "retarget", day_index: 0, exercise_id: id, rep_intent: "strength" });
    expect(strength.code).toBe(200);
    const low = repsOf((strength.body as { plan: unknown }).plan, id)!;

    const endurance = await put({ op: "retarget", day_index: 0, exercise_id: id, rep_intent: "endurance" });
    expect(endurance.code).toBe(200);
    const high = repsOf((endurance.body as { plan: unknown }).plan, id)!;

    // strength 는 낮은 렙, endurance 는 높은 렙이다(`loading.ts` repRangeFor).
    // 재확장이 이 값을 안 읽으면 둘이 같아진다 — 그게 "저장만 되고 끝난다"이다.
    expect(high.high).toBeGreaterThan(low.high);
    expect(high.low).toBeGreaterThan(low.low);
  });

  it("드래프트에 남아 다음 편집에도 살아 있다 — 수치는 여전히 코드 소유다", async () => {
    seed();
    const id = firstId();
    await put({ op: "retarget", day_index: 0, exercise_id: id, rep_intent: "endurance" });

    const stored = weeksOf("u1").get(WEEK) as { draft: { week: Array<{ day_index: number; items: Array<{ exercise_id?: string; rep_intent?: string; user_pick?: boolean }> }> } };
    const item = stored.draft.week.find((d) => d.day_index === 0)!.items.find((i) => i.exercise_id === id)!;
    expect(item.rep_intent).toBe("endurance");
    // 범위를 손댔다는 건 그 종목을 지키겠다는 뜻이다(볼륨 예산에서 안 밀린다).
    expect(item.user_pick).toBe(true);

    // 다른 편집을 해도 의도가 남는다.
    await put({ op: "add", day_index: 0, to_exercise_id: "dumbbell_bicep_curl" });
    const again = weeksOf("u1").get(WEEK) as typeof stored;
    expect(again.draft.week.find((d) => d.day_index === 0)!.items.find((i) => i.exercise_id === id)!.rep_intent).toBe("endurance");
  });

  it("계약 밖 값은 400", async () => {
    seed();
    const id = firstId();
    for (const bad of [
      { op: "retarget", day_index: 0, exercise_id: id, rep_intent: "power" },
      { op: "retarget", day_index: 0, exercise_id: id },
      { op: "retarget", day_index: 0, rep_intent: "strength" },
      { op: "retarget", day_index: 0, exercise_id: "not_in_that_day", rep_intent: "strength" },
    ]) {
      expect((await put(bad)).code, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("되돌리기는 없다 — PUT {op: reset} 은 400 (D59 · 039 T0-1)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-17";
  const DRAFT = CASES[SAMPLE.id]!.draft;

  it("원본이 남은 옛 문서에서도 400 이고 아무것도 저장하지 않는다", async () => {
    // D59 전에 저장된 문서에는 `draft_original` 이 남아 있다 — 읽는 곳이 없어야 한다.
    const doc = {
      user_id: "u1", week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1 }, week: [] },
      draft: structuredClone(DRAFT), draft_original: structuredClone(DRAFT), profile: SAMPLE.profile,
    };
    weeksOf("u1").set(WEEK, structuredClone(doc));
    // 요일 없이 보내면 day_index 검사에서, 요일을 붙이면 op 목록 문구에서 막힌다 — 둘 다 본다.
    for (const body of [{ op: "reset" }, { op: "reset", day_index: 0 }]) {
      const r = res();
      await (plansGet as unknown as Handler)({ method: "PUT", body, query: {}, path: "/v1/plans/current", headers: AUTH }, r);

      expect(r.captured.code, JSON.stringify(body)).toBe(400);
      expect((r.captured.body as { message: string }).message, JSON.stringify(body)).not.toMatch(/reset/);
      expect(weeksOf("u1").get(WEEK)).toEqual(doc);
    }
  });
});

describe("하루 비우기 — PUT /v1/plans/{week} (op: clear_day · D76 · 061 N2)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-24";
  const put = async (payload: unknown, key = WEEK, headers = AUTH) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", body: payload, query: {}, path: `/v1/plans/${key}`, headers }, r);
    return r.captured;
  };
  type Plan = { week: Array<{ day_index: number; session_type: string; exercises: Array<{ exercise_id: string; modality?: string }> }> };
  const daysOf = (plan: Plan) => plan.week.map((d) => [d.day_index, d.session_type, d.exercises.length]);
  const performedTue = {
    schema_version: "1.0", session_id: "s-clear", plan_id: "p1", date: "2026-08-25", day_index: 1, completion: "completed",
    exercises: [{ exercise_id: "barbell_squat", modality: "strength", sets: [{ set_number: 1, set_kind: "working", actual_reps: 10, actual_load_kg: 60 }] }],
  };
  /** 근력 2 + 유산소 1 인 화요일과 근력 1 인 수요일. */
  const seed = async () => {
    await put({ op: "blank", profile: SAMPLE.profile });
    expect((await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" })).code).toBe(200);
    expect((await put({ op: "add", day_index: 1, to_exercise_id: "barbell_bench_press_medium_grip" })).code).toBe(200);
    expect((await put({ op: "add", day_index: 1, to_exercise_id: "bicycling_stationary" })).code).toBe(200);
    expect((await put({ op: "add", day_index: 2, to_exercise_id: "barbell_squat" })).code).toBe(200);
  };

  it("T2-1 그 날 종목·유산소가 전부 빠지고 휴식일이 된다 — 다른 날은 그대로 · 정본과 드래프트 둘 다", async () => {
    await seed();
    const out = await put({ op: "clear_day", day_index: 1 });
    expect(out.code).toBe(200);
    const plan = (out.body as { plan: Plan }).plan;
    expect(daysOf(plan)).toEqual([[2, "lift", 1]]);
    expect(checkWeeklyPlan(plan).ok).toBe(true);
    const stored = weeksOf("u1").get(WEEK) as { plan: Plan; draft: { week: Array<{ day_index: number; items: unknown[]; cardio_override?: unknown; session_type: string }> } };
    expect(daysOf(stored.plan)).toEqual([[2, "lift", 1]]);
    const tue = stored.draft.week.find((d) => d.day_index === 1)!;
    expect([tue.items, tue.cardio_override, tue.session_type]).toEqual([[], "none", "rest"]);
    expect(enqueued).toHaveLength(0);
    expect(store("rate_limits").size).toBe(0);
  });

  it("T2-2 이미 휴식일이면 200 · 그대로(멱등)", async () => {
    await seed();
    const before = (await put({ op: "clear_day", day_index: 4 })).body as { plan: Plan };
    const again = await put({ op: "clear_day", day_index: 4 });
    expect(again.code).toBe(200);
    expect(daysOf((again.body as { plan: Plan }).plan)).toEqual(daysOf(before.plan));
    expect(daysOf(before.plan)).toEqual([[1, "lift_plus_cardio", 3], [2, "lift", 1]]);
  });

  it("T2-3 day_index 밖·생략은 400", async () => {
    await seed();
    expect((await put({ op: "clear_day", day_index: 7 })).code).toBe(400);
    expect((await put({ op: "clear_day" })).code).toBe(400);
  });

  it("T2-4 저장된 플랜이 없으면 404 — 만드는 op 가 아니다", async () => {
    const out = await put({ op: "clear_day", day_index: 1 });
    expect(out.code).toBe(404);
    expect(weeksOf("u1").size).toBe(0);
  });

  it("T2-5 그 날 기록이 있어도 비운다 — 기록은 남는다(플랜만 비운다)", async () => {
    await seed();
    const r = res();
    await (plansGet as unknown as Handler)(
      { method: "PUT", body: performedTue, query: {}, path: `/v1/plans/${WEEK}/sessions/1`, headers: AUTH },
      r,
    );
    expect(r.captured.code).toBe(200);
    const out = await put({ op: "clear_day", day_index: 1 });
    expect(out.code).toBe(200);
    const stored = weeksOf("u1").get(WEEK) as { sessions?: Record<string, unknown> };
    expect(stored.sessions?.["1"]).toBeTruthy();
  });

  it("T2-6 비운 날에 다시 add 하면 근력일이 된다", async () => {
    await seed();
    await put({ op: "clear_day", day_index: 1 });
    const out = await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });
    expect(out.code).toBe(200);
    expect(daysOf((out.body as { plan: Plan }).plan)).toEqual([[1, "lift", 1], [2, "lift", 1]]);
  });
});

describe("빈 주에서 시작 — PUT /v1/plans/{week} (op: blank · D20-2 · 019 M10)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-24";

  const put = async (payload: unknown, key = WEEK, headers = AUTH) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", body: payload, query: {}, path: `/v1/plans/${key}`, headers }, r);
    return r.captured;
  };

  it("새 수동 주는 자기 이전 주 기록을 고정해 이어받고 재편집 때 바꾸지 않는다", async () => {
    const session = { exercises: [{ exercise_id: "barbell_squat", sets: [
      { set_number: 1, set_kind: "working", actual_reps: 9, actual_load_kg: 50 },
    ] }] };
    weeksOf("u1").set("2026-08-17", { plan: { plan_meta: { week_number: 4 } }, sessions: { 0: session } });
    weeksOf("u1").set("2026-08-31", { plan: { plan_meta: { week_number: 99 } }, sessions: { 0: { forged: true } } });
    weeksOf("u2").set("2026-08-17", { plan: { plan_meta: { week_number: 88 } }, sessions: { 0: { foreign: true } } });
    const blank = await put({ op: "blank", profile: SAMPLE.profile, prior_logs: [{ forged: true }], week_number: 80 });
    expect(blank.code).toBe(200);
    expect(weeksOf("u1").get(WEEK)).toMatchObject({
      plan: { plan_meta: { week_number: 5, source: "manual" } }, prior_logs: [session],
    });
    const added = await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });
    expect(added.code).toBe(200);
    const plan = (added.body as { plan: { week: Array<{ exercises: Array<{ sets: Array<{ set_kind: string; target_load_kg: number | null }> }> }> } }).plan;
    const working = plan.week.flatMap((d) => d.exercises).flatMap((e) => e.sets).filter((s) => s.set_kind === "working");
    expect(working.length).toBeGreaterThan(0);
    expect(working.every((s) => s.target_load_kg === 50)).toBe(true);
    weeksOf("u1").set("2026-08-17", { sessions: { 0: { changed: true } } });
    await put({ op: "blank", profile: SAMPLE.profile });
    expect(weeksOf("u1").get(WEEK)).toMatchObject({ plan: { plan_meta: { week_number: 5 } }, prior_logs: [session] });
  });

  it("직전 주에 빠진 운동도 4주 이력에서 찾고 수동 추가 시 증량을 보류한다", async () => {
    const session = { date: "2026-08-10", exercises: [{ exercise_id: "barbell_squat", sets: [
      { set_number: 1, set_kind: "working", actual_reps: 15, actual_load_kg: 50 },
    ] }] };
    weeksOf("u1").set("2026-08-10", { plan: { plan_meta: { week_number: 3 } }, sessions: { 0: session } });
    weeksOf("u1").set("2026-08-17", { plan: { plan_meta: { week_number: 4 } }, sessions: {} });
    expect((await put({ op: "blank", profile: SAMPLE.profile })).code).toBe(200);
    const added = await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });
    expect(added.code).toBe(200);
    const plan = (added.body as { plan: { week: Array<{ exercises: Array<{ exercise_id: string; progression_decision: unknown }> }> } }).plan;
    expect(plan.week.flatMap((d) => d.exercises).find((e) => e.exercise_id === "barbell_squat")?.progression_decision)
      .toMatchObject({ decision: "hold", reason_code: "history_gap", to_load_kg: 50, source_date: "2026-08-10" });
    expect(weeksOf("u1").get(WEEK)).toMatchObject({ plan: { plan_meta: { week_number: 5 } }, prior_logs: [session] });
  });

  it("저장된 플랜이 없어도 빈 주가 생긴다 — LLM 없이 플랜이 생기는 경로다", async () => {
    expect(weeksOf("u1").size).toBe(0);
    const out = await put({ op: "blank", profile: SAMPLE.profile });

    expect(out.code).toBe(200);
    // 다른 op 와 달리 404 가 아니다 — 이건 *만드는* 것이다.
    const plan = (out.body as { plan: { plan_meta: { source?: string }; week: Array<{ session_type: string; exercises: Array<{ modality: string }> }> } }).plan;
    // **근력도 유산소도 하나도 없다** — 그게 "빈 주"다(D75 · 백로그 069). 프로필 도스(`cardio_pref`)는
    // 「추천 플랜 생성」에만 쓰이고, 빈 주의 유산소는 요일 `add` 로만 들어온다.
    // 응답 `week` 는 희소 배열이라 휴식일은 아예 없다 — 유산소 줄이 있었다면 `cardio_only` 날로 남았을 것이다.
    expect(plan.week).toEqual([]);
    expect(plan.plan_meta.source).toBe("manual");
    expect(checkWeeklyPlan(plan).ok).toBe(true);
    // LLM 을 부르지 않고, 주간 생성 한도도 쓰지 않는다.
    expect(enqueued).toHaveLength(0);
    expect(store("rate_limits").size).toBe(0);
  });

  it("만든 빈 주는 정본에 남고 되찾을 수 있다", async () => {
    await put({ op: "blank", profile: SAMPLE.profile });
    const stored = weeksOf("u1").get(WEEK) as { week_start_date: string; draft: { week: unknown[] }; profile: unknown };
    expect(stored.week_start_date).toBe(WEEK);
    // 빈 드래프트가 정본에 남는다 — 다음 `add` 의 입력이 이것이다. 7일 전부 휴식 + 유산소 `"none"`(D75) —
    // 응답에서만 거르면 다음 재확장에서 도스 유산소가 되살아난다.
    expect(stored.draft.week).toHaveLength(7);
    expect(stored.draft.week.map((d) => (d as { cardio_override?: unknown }).cardio_override)).toEqual(Array(7).fill("none"));
    expect(stored.profile).toBeTruthy();

    const r = res();
    await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/current"), r);
    expect(r.captured.code).toBe(200);
  });

  it("빈 주를 기존 add 경로로 채운다 — 새 구조가 없다(D20-2)", async () => {
    await put({ op: "blank", profile: SAMPLE.profile });
    const out = await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });

    expect(out.code).toBe(200);
    const plan = (out.body as { plan: { week: Array<{ day_index: number; exercises: Array<{ exercise_id: string; sets: unknown[] }> }> } }).plan;
    const day = plan.week.find((d) => d.day_index === 1)!;
    expect(day.exercises.map((e) => e.exercise_id)).toContain("barbell_squat");
    // INV-1: 클라이언트가 수치를 보낸 적 없는데 세트가 붙어 있다.
    expect(day.exercises[0]!.sets.length).toBeGreaterThan(0);
    expect(checkWeeklyPlan(plan).ok).toBe(true);
    // 근력을 넣어도 다른 날에 유산소가 생기지 않는다(D75) — 드래프트에 "none" 이 남아 있어야 한다.
    expect(plan.week.flatMap((d) => d.exercises.filter((e) => (e as { modality?: string }).modality === "cardio"))).toEqual([]);
  });

  it("D75 이전 빈 주(week:[] · manual)를 편집하면 7일 「뺐다」로 채워져 도스 유산소가 붙지 않는다", async () => {
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1, source: "manual" }, week: [] },
      draft: { week: [] }, profile: SAMPLE.profile,
    });
    const out = await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });
    expect(out.code).toBe(200);
    const plan = (out.body as { plan: { week: Array<{ day_index: number; session_type: string; exercises: Array<{ modality: string }> }> } }).plan;
    expect(plan.week.map((d) => [d.day_index, d.session_type])).toEqual([[1, "lift"]]);
    expect(plan.week.flatMap((d) => d.exercises).filter((e) => e.modality === "cardio")).toEqual([]);
    const stored = weeksOf("u1").get(WEEK) as { draft: { week: Array<{ cardio_override?: unknown }> } };
    expect(stored.draft.week.map((d) => d.cardio_override)).toEqual(Array(7).fill("none"));
    // 정규화는 op 와 무관하게 편집 전에 한 번이다 — clear_day 로도 같은 모양(다른 날에 도스가 안 붙는다).
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1, source: "manual" }, week: [{ day_index: 3, session_type: "lift", focus: "", exercises: [] }] },
      draft: { week: [{ day_index: 3, session_type: "lift", focus: "", items: [{ kind: "strength", exercise_id: "barbell_squat", role: "accessory", order: 1, rep_intent: "hypertrophy" }] }] }, profile: SAMPLE.profile,
    });
    const cleared = await put({ op: "clear_day", day_index: 3 });
    expect(cleared.code).toBe(200);
    expect((cleared.body as { plan: { week: unknown[] } }).plan.week).toEqual([]);
    // AI 주(source: "ai")는 건드리지 않는다 — 도스 배치가 맞다.
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK,
      plan: { plan_meta: { week_number: 1, source: "ai" }, week: [] },
      draft: { week: [] }, profile: SAMPLE.profile,
    });
    const ai = await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });
    expect(ai.code).toBe(200);
    expect((ai.body as { plan: { week: Array<{ exercises: Array<{ modality: string }> }> } }).plan.week.flatMap((d) => d.exercises).some((e) => e.modality === "cardio")).toBe(true);
  });

  it("빈 주 휴식일에 유산소를 add 하면 그 날만 cardio_only 다 — \"none\" 이 add 를 막지 않는다(D75)", async () => {
    await put({ op: "blank", profile: SAMPLE.profile });
    const out = await put({ op: "add", day_index: 3, to_exercise_id: "bicycling_stationary" });

    expect(out.code).toBe(200);
    const plan = (out.body as { plan: { week: Array<{ day_index: number; session_type: string; exercises: Array<{ modality: string }> }> } }).plan;
    expect(plan.week.map((d) => [d.day_index, d.session_type])).toEqual([[3, "cardio_only"]]);
    expect(plan.week.flatMap((d) => d.exercises).filter((e) => e.modality === "cardio")).toHaveLength(1);
  });

  it("빈 주에서 merge 로 옮겨도 비운 날에 유산소가 되살아나지 않는다 — \"none\" 은 원래 날에 남는다(D75)", async () => {
    await put({ op: "blank", profile: SAMPLE.profile });
    await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });
    await put({ op: "add", day_index: 2, to_exercise_id: "barbell_bench_press_medium_grip" });
    const out = await put({ op: "move", day_index: 1, to_day_index: 2, mode: "merge" });

    expect(out.code).toBe(200);
    const plan = (out.body as { plan: { week: Array<{ day_index: number; session_type: string; exercises: Array<{ modality: string }> }> } }).plan;
    expect(plan.week.map((d) => [d.day_index, d.session_type])).toEqual([[2, "lift"]]);
    expect(plan.week.flatMap((d) => d.exercises).filter((e) => e.modality === "cardio")).toEqual([]);
    const stored = weeksOf("u1").get(WEEK) as { draft: { week: Array<{ cardio_override?: unknown }> } };
    expect(stored.draft.week.map((d) => d.cardio_override)).toEqual(Array(7).fill("none"));
  });

  it("빈 주에서 유산소를 넣은 날을 빈 날로 merge 하면 유산소가 따라간다 — \"none\" 뿐인 날은 빈 날이다(D75 · 계약 §2.2 swap 과 같다)", async () => {
    await put({ op: "blank", profile: SAMPLE.profile });
    await put({ op: "add", day_index: 3, to_exercise_id: "bicycling_stationary" });
    const out = await put({ op: "move", day_index: 3, to_day_index: 5, mode: "merge" });

    expect(out.code).toBe(200);
    const plan = (out.body as { plan: { week: Array<{ day_index: number; session_type: string; exercises: Array<{ modality: string }> }> } }).plan;
    expect(plan.week.map((d) => [d.day_index, d.session_type])).toEqual([[5, "cardio_only"]]);
    const stored = weeksOf("u1").get(WEEK) as { draft: { week: Array<{ day_index: number; cardio_override?: unknown }> } };
    expect(stored.draft.week.find((d) => d.day_index === 3)!.cardio_override).toBe("none");
    expect(stored.draft.week.find((d) => d.day_index === 5)!.cardio_override).toEqual({ exercise_id: "bicycling_stationary" });
  });

  it("근력이 있는 날로 merge 하면 원래 날의 유산소 결정은 「뺐다」로 남는다 — 도스 유산소가 그 자리에 되살아나지 않는다(D75)", async () => {
    await put({ op: "blank", profile: SAMPLE.profile });
    await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });
    await put({ op: "add", day_index: 1, to_exercise_id: "bicycling_stationary" });
    await put({ op: "add", day_index: 2, to_exercise_id: "barbell_bench_press_medium_grip" });
    const out = await put({ op: "move", day_index: 1, to_day_index: 2, mode: "merge" });

    expect(out.code).toBe(200);
    const plan = (out.body as { plan: { week: Array<{ day_index: number; session_type: string; exercises: Array<{ modality: string }> }> } }).plan;
    // 대상 날 결정(「뺐다」)이 이긴다 — 유산소는 안 따라가고, 원래 날은 「뺐다」로 남는다.
    expect(plan.week.map((d) => [d.day_index, d.session_type])).toEqual([[2, "lift"]]);
    const stored = weeksOf("u1").get(WEEK) as { draft: { week: Array<{ day_index: number; cardio_override?: unknown }> } };
    expect(stored.draft.week.find((d) => d.day_index === 1)!.cardio_override).toBe("none");
  });

  it("이미 있는 주를 비워도 주차 번호가 1로 되돌아가지 않는다", async () => {
    // 5주차를 비웠는데 1주차가 되면 plan_id 가 uid-w1 로 돌아가 기록 연결이 끊긴다.
    weeksOf("u1").set(WEEK, {
      user_id: "u1", week_start_date: WEEK,
      plan: { plan_meta: { week_number: 5 }, week: [] },
      draft: { week: [] }, profile: SAMPLE.profile,
    });
    const out = await put({ op: "blank", profile: SAMPLE.profile });

    expect(out.code).toBe(200);
    expect((out.body as { plan: { plan_meta: { week_number: number } } }).plan.plan_meta.week_number).toBe(5);
  });

  it("current 로는 만들 수 없다 — 어느 주인지 스스로 말해야 한다", async () => {
    const out = await put({ op: "blank", profile: SAMPLE.profile }, "current");
    expect(out.code).toBe(400);
    expect(weeksOf("u1").size).toBe(0);
  });

  it("프로필은 생성 경로와 같은 검증기를 지난다", async () => {
    const out = await put({ op: "blank", profile: { ...SAMPLE.profile, environment: "home_minimal" } });
    expect(out.code).toBe(400);
    expect(weeksOf("u1").size).toBe(0);
  });

  it("이미 있는 주를 빈 주로 만들면 그 주가 비워진다", async () => {
    // `blank` 는 아예 빈 상태로 간다. 계획만 건드린다.
    await put({ op: "blank", profile: SAMPLE.profile });
    await put({ op: "add", day_index: 1, to_exercise_id: "barbell_squat" });
    const out = await put({ op: "blank", profile: SAMPLE.profile });

    expect(out.code).toBe(200);
    const plan = (out.body as { plan: { week: Array<{ exercises: Array<{ modality: string; exercise_id: string }> }> } }).plan;
    expect(plan.week.flatMap((d) => d.exercises).filter((e) => e.modality !== "cardio")).toEqual([]);
  });
});

describe("plan_meta.source — 생성 ai · 빈 주 manual · 편집은 그대로 (D54 ① · 039 T2-4/T2-5)", () => {
  const weeksOf = (uid: string) => store(`weekly_plans/${uid}/weeks`);
  const WEEK = "2026-08-31";
  const DRAFT = CASES[SAMPLE.id]!.draft;
  const put = async (payload: unknown, key = WEEK) => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", body: payload, query: {}, path: `/v1/plans/${key}`, headers: AUTH }, r);
    return r.captured;
  };
  const metaOf = (doc: unknown) => (doc as { plan: { plan_meta: Record<string, unknown> } }).plan.plan_meta;
  function seed(source: unknown) {
    const { plan } = expandDraftToWeeklyPlan({
      draft: DRAFT, profile: SAMPLE.profile, userId: "u1", weekStartDate: WEEK, weekNumber: 1, priorLogs: [], disclaimer: "d",
    });
    if (source !== undefined) (plan as { plan_meta: Record<string, unknown> }).plan_meta.source = source;
    weeksOf("u1").set(WEEK, { user_id: "u1", week_start_date: WEEK, plan, draft: structuredClone(DRAFT), profile: SAMPLE.profile });
  }

  it("빈 주는 manual — 문서가 없을 때도, AI 주 위에 깊게 병합될 때도", async () => {
    const fresh = await put({ op: "blank", profile: SAMPLE.profile });
    expect(fresh.code).toBe(200);
    expect(metaOf(fresh.body).source).toBe("manual");
    expect(metaOf(weeksOf("u1").get(WEEK)).source).toBe("manual");

    seed("ai");
    expect((await put({ op: "blank", profile: SAMPLE.profile })).code).toBe(200);
    // 생략(「없으면 수동」)으로 구현하면 병합이 "ai" 를 남긴다 — 저장 문서를 본다.
    expect(metaOf(weeksOf("u1").get(WEEK)).source).toBe("manual");
  });

  it("편집은 저장된 출처를 그대로 넘긴다 — 없던 값은 키 없음 · 허용 밖 값은 manual(500 아님)", async () => {
    for (const [saved, expected] of [["ai", "ai"], ["manual", "manual"], [undefined, undefined], ["x", "manual"], [null, "manual"]] as const) {
      seed(saved);
      const out = await put({ op: "add", day_index: 2, to_exercise_id: "dumbbell_bicep_curl" }, "current");
      expect(out.code, String(saved)).toBe(200);
      // 응답만 보면 안 된다 — 저장이 깊은 병합이라 응답에서 뺀 키가 문서에는 남는다(codex R1).
      for (const meta of [metaOf(out.body), metaOf(weeksOf("u1").get(WEEK))]) {
        expect(meta.source, String(saved)).toBe(expected);
        if (expected === undefined) expect("source" in meta, String(saved)).toBe(false);
      }
    }
  });
});


describe("Toss account reset lifecycle", () => {
  const uid = "toss:12345";
  const secret = "fixture-session-secret";
  const headers = (version = "initial") => ({ authorization: `Bearer ${mintSession(uid, secret, Date.now(), version)}` });
  const withdraw = async () => {
    process.env.TOSS_WITHDRAW_BASIC = "id:pw";
    const r = res();
    await (tossWithdraw as unknown as Handler)({ method: "POST", headers: { authorization: "Basic id:pw" }, body: { userKey: 12345, referrer: "UNLINK" } }, r);
    expect(r.captured.code).toBe(200);
  };
  const read = async (auth: Record<string, string>) => {
    const r = res();
    await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/current", auth), r);
    return r.captured;
  };

  it("legacy and versioned tokens preserve uid and reject version tampering", () => {
    const now = Date.now();
    expect(verifySessionClaims(mintSession(uid, secret, now), secret, now)).toEqual({ uid, version: "0" });
    const token = mintSession(uid, secret, now, "new-version");
    expect(verifySessionClaims(token, secret, now)).toEqual({ uid, version: "new-version" });
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(Buffer.from(payload!, "base64url").toString().replace("new-version", "0")).toString("base64url");
    expect(verifySessionClaims(`${forged}.${signature}`, secret, now)).toBeNull();
  });

  it("404 alone is not unlink; unlink revokes old sessions and relogin changes the local data key", async () => {
    process.env.SESSION_SECRET = secret;
    store("account_lifecycle").set(accountKey(uid), { version: "initial" });
    const old = headers();
    expect((await read(old)).code).toBe(404);
    const before = await loginAccount(getFirestore(), uid, await readLoginRevision(getFirestore()));
    await withdraw();
    expect(await read(old)).toMatchObject({ code: 401, body: { code: "ACCOUNT_RESET" } });
    expect(store("account_lifecycle").has(accountKey(uid))).toBe(false);
    const next = await loginAccount(getFirestore(), uid, await readLoginRevision(getFirestore()));
    expect(next.localDataKey).not.toBe(before.localDataKey);
    expect((await read(headers(next.version))).code).toBe(404);
    expect((await read(old)).code).toBe(401);
  });

  it("first deployment preserves an existing plan; old unversioned sessions ask for login without declaring unlink", async () => {
    process.env.SESSION_SECRET = secret;
    store(`weekly_plans/${uid}/weeks`).set("2026-09-07", { plan: {} });
    const out = await loginAccount(getFirestore(), uid, await readLoginRevision(getFirestore()));
    expect(out.localDataKey).toBeTruthy();
    const legacy = { authorization: `Bearer ${mintSession(uid, secret, Date.now())}` };
    expect(await read(legacy)).toMatchObject({ code: 401, body: { code: "SESSION_REFRESH" } });
  });

  it("a login validated before deletion cannot recreate a connection after deletion", async () => {
    const pendingRevision = await readLoginRevision(getFirestore());
    await withdraw();
    await expect(loginAccount(getFirestore(), uid, pendingRevision)).rejects.toBeInstanceOf(LoginInterrupted);
    expect(store("account_lifecycle").has(accountKey(uid))).toBe(false);
    const fresh = await loginAccount(getFirestore(), uid, await readLoginRevision(getFirestore()));
    expect(fresh.localDataKey).toBeTruthy();
  });

  it("an old DELETE cannot delete the next connection's new records", async () => {
    process.env.SESSION_SECRET = secret;
    store("account_lifecycle").set(accountKey(uid), { version: "initial" });
    beforeTransaction = async () => {
      await withdraw();
      store("account_lifecycle").set(accountKey(uid), { version: "relinked" });
      store(`weekly_plans/${uid}/weeks`).set("2026-09-07", { plan: { source: "new connection" } });
    };
    const r = res();
    await (plansGet as unknown as Handler)({ method: "DELETE", path: "/v1/plans", query: {}, headers: headers() }, r);
    expect(r.captured).toMatchObject({ code: 401, body: { code: "ACCOUNT_RESET" } });
    expect(store(`weekly_plans/${uid}/weeks`).size).toBe(1);
    expect(store("account_lifecycle").get(accountKey(uid))?.version).toBe("relinked");
  });

  it("an old GET cannot return records fetched after a relink", async () => {
    process.env.SESSION_SECRET = secret;
    store("account_lifecycle").set(accountKey(uid), { version: "initial" });
    beforeQuery = async () => {
      await withdraw();
      store("account_lifecycle").set(accountKey(uid), { version: "relinked" });
      store(`weekly_plans/${uid}/weeks`).set("2026-09-07", { plan: { source: "new connection" } });
    };
    const out = await read(headers());
    expect(out).toMatchObject({ code: 401, body: { code: "ACCOUNT_RESET" } });
    expect(JSON.stringify(out)).not.toContain("new connection");
  });

  it("a pre-deployment job completes without getting stuck in running", async () => {
    docs.set("legacy-toss-job", { user_id: uid, status: "queued" });
    const llm = await startFakeLlm([CASES[SAMPLE.id]!.draft]);
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.LLM_PROVIDER = "minimax";
    process.env.LLM_API_KEY = "fake-key";
    process.env.LLM_BASE_URL = llm.baseUrl;
    process.env.LLM_MODEL = "fake-model";
    process.env.GENERATION_PIPELINE = "p0"; // 가짜 LLM 은 P0 드래프트 — 기본 auto 면 헬스장이 P1(D105 ①)
    const taskHeaders: Record<string, string> = { "content-type": "application/json", "x-cloudtasks-queuename": "plansWorker" };
    const r = res();
    try {
      await (plansWorker as unknown as Handler)({ method: "POST", headers: taskHeaders,
        body: { data: { jobId: "legacy-toss-job", req: { ...body(), user_id: uid } } },
        header: (name: string) => taskHeaders[name.toLowerCase()] }, r);
    } finally { await llm.close(); }
    expect(r.captured.code).toBe(204);
    expect(docs.get("legacy-toss-job")?.status).toBe("ok");
    expect(docs.get("legacy-toss-job")?.account_version).toBe(store("account_lifecycle").get(accountKey(uid))?.version);
    expect(store(`weekly_plans/${uid}/weeks`).size).toBe(1);
  });

  it.each([false, true])("worker persistence failure terminates safely (deleted=%s)", async (deleted) => {
    docs.set("save-failure", { user_id: uid, status: "queued", account_version: "initial" });
    store("account_lifecycle").set(accountKey(uid), { version: "initial" });
    beforeTransaction = async () => {
      // First transaction claims queued -> running; fail the subsequent result save.
      beforeTransaction = async () => {
        if (deleted) await withdraw();
        throw new Error("fixture result transaction failure");
      };
    };
    const llm = await startFakeLlm([CASES[SAMPLE.id]!.draft]);
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.LLM_PROVIDER = "minimax";
    process.env.LLM_API_KEY = "fake-key";
    process.env.LLM_BASE_URL = llm.baseUrl;
    process.env.LLM_MODEL = "fake-model";
    process.env.GENERATION_PIPELINE = "p0"; // 가짜 LLM 은 P0 드래프트 — 기본 auto 면 헬스장이 P1(D105 ①)
    const taskHeaders: Record<string, string> = { "content-type": "application/json", "x-cloudtasks-queuename": "plansWorker" };
    const r = res();
    try {
      await (plansWorker as unknown as Handler)({ method: "POST", headers: taskHeaders,
        body: { data: { jobId: "save-failure", req: { ...body(), user_id: uid } } },
        header: (name: string) => taskHeaders[name.toLowerCase()] }, r);
    } finally { await llm.close(); }
    expect(r.captured.code).toBe(204);
    if (deleted) expect(docs.has("save-failure")).toBe(false);
    else expect(docs.get("save-failure")).toMatchObject({ status: "error", message: expect.stringContaining("저장하지 못했어요") });
    expect(store(`weekly_plans/${uid}/weeks`).size).toBe(0);
  });

  it.each(["readLoginRevision", "loginAccount"] as const)("account database failure during %s is 503, preserving the client's cache", async (phase) => {
    const accountModule = await import("../src/auth/account");
    const tossModule = await import("../src/auth/toss");
    const database = vi.spyOn(accountModule, phase).mockRejectedValue(new Error("fixture database outage"));
    const exchange = vi.spyOn(tossModule, "loginWithToss").mockResolvedValue({ uid, sessionToken: "unused", expiresInSec: 3600 });
    const oldCert = process.env.TOSS_CLIENT_CERT, oldKey = process.env.TOSS_CLIENT_KEY;
    process.env.SESSION_SECRET = secret;
    process.env.TOSS_CLIENT_CERT = "fixture";
    process.env.TOSS_CLIENT_KEY = "fixture";
    const r = res();
    try {
      await (authToss as unknown as Handler)(post({ authorizationCode: "fixture", referrer: "fixture" }), r);
      expect(r.captured.code).toBe(503);
      expect(r.captured.body).not.toHaveProperty("code", "ACCOUNT_RESET");
    } finally {
      database.mockRestore(); exchange.mockRestore();
      if (oldCert === undefined) delete process.env.TOSS_CLIENT_CERT; else process.env.TOSS_CLIENT_CERT = oldCert;
      if (oldKey === undefined) delete process.env.TOSS_CLIENT_KEY; else process.env.TOSS_CLIENT_KEY = oldKey;
    }
  });

  it("an already-authorized edit cannot recreate data after unlink", async () => {
    process.env.SESSION_SECRET = secret;
    store("account_lifecycle").set(accountKey(uid), { version: "initial" });
    beforeTransaction = withdraw; // after authorization/plan read, immediately before the write transaction
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", path: "/v1/plans/2026-09-07", query: {}, headers: headers(), body: { op: "blank", profile: body().profile } }, r);
    expect(r.captured).toMatchObject({ code: 401, body: { code: "ACCOUNT_RESET" } });
    expect(store(`weekly_plans/${uid}/weeks`).size).toBe(0);
  });

  it("unlink during intake leaves neither quota nor a new job", async () => {
    process.env.SESSION_SECRET = secret;
    store("account_lifecycle").set(accountKey(uid), { version: "initial" });
    beforeTransaction = withdraw;
    const r = res();
    await (plansGenerate as unknown as Handler)(post(body(), headers()), r);
    expect(r.captured).toMatchObject({ code: 401, body: { code: "ACCOUNT_RESET" } });
    expect(store("rate_limits").has(uid)).toBe(false);
    expect([...docs.values()].some((job) => job.user_id === uid)).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});


describe("Toss rewarded generation — account separation and reservations (ADR-0013)", () => {
  const secret = "reward-fixture-secret";
  const account = (id = "a") => ({ uid: `toss:reward-${id}`, version: "v1" });
  const headers = (id = "a") => ({ authorization: `Bearer ${mintSession(account(id).uid, secret, Date.now(), "v1")}` });
  const accessStore = () => store("generation_access");
  const call = async (path: string, data?: object, id = "a") => {
    const r = res();
    await (plansGet as unknown as Handler)({
      method: data ? "POST" : "GET", path: `/v1/plans/${path}`, query: {}, body: data, headers: headers(id),
    }, r);
    return r.captured as { code: number; body: any };
  };
  const create = async (id = "a", extra = {}) => {
    const r = res();
    await (plansGenerate as unknown as Handler)(post({ ...bodyWithout("fcm_token"), ...extra }, headers(id)), r);
    return r.captured as { code: number; body: any };
  };
  const finish = async (jobId: string, success = true, id = "a") => getFirestore().runTransaction(async tx => {
    const result = await settleGeneration(getFirestore(), tx, account(id).uid, jobId, success);
    if (result) tx.update(getFirestore().collection("generation_jobs").doc(jobId), { status: success ? "ok" : "error" });
    return result;
  });
  beforeEach(() => {
    process.env.SESSION_SECRET = secret;
    process.env.TOSS_REWARDED_AD_GROUP_ID = "fixture-rewarded-group";
    process.env.TOSS_REWARDED_GENERATION_ENABLED = "true";
    for (const id of ["a", "b"]) store("account_lifecycle").set(accountKey(account(id).uid), { version: "v1" });
  });

  it("verified users own separate free allowances; a forged body uid cannot share or spend another account", async () => {
    store("rate_limits").set(account().uid, { count: 3, week_start: generationWeek(Date.now()).week });
    const a = await create("a", { user_id: account("b").uid });
    expect(a.code).toBe(202); // old exhausted counter does not carry over
    expect(docs.get(a.body.job_id)?.user_id).toBe(account().uid);
    await finish(a.body.job_id);
    expect((await call("generation-access")).body.free_available).toBe(false);
    expect((await call("generation-access", undefined, "b")).body.free_available).toBe(true);
    expect((await create()).body.code).toBe("AD_REQUIRED");
    expect((await create("b")).code).toBe(202);
    const foreign = res();
    await (plansGet as unknown as Handler)(get(a.body.job_id, "/", headers("b")), foreign);
    expect(foreign.captured.code).toBe(404);
  });

  it("concurrent intake reuses one job, one reservation, and one task", async () => {
    const results = await Promise.all([create(), create(), create()]);
    expect(results.map(r => r.code)).toEqual([202, 202, 202]);
    expect(new Set(results.map(r => r.body.job_id)).size).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it("changing request week cannot reset the free window; KST Monday midnight does", async () => {
    expect(generationWeek(Date.parse("2026-09-13T14:59:59Z")).week).toBe("2026-09-07");
    expect(generationWeek(Date.parse("2026-09-13T15:00:00Z"))).toEqual({ week: "2026-09-14", resets_at: "2026-09-20T15:00:00.000Z" });
    const a = await create(); await finish(a.body.job_id);
    expect((await create("a", { week_start_date: "2099-01-01" })).body.code).toBe("AD_REQUIRED");
  });

  it("missing ad configuration keeps existing clients usable without the old quota", async () => {
    delete process.env.TOSS_REWARDED_AD_GROUP_ID;
    const a = await create(); expect(a.code).toBe(202); await finish(a.body.job_id);
    expect(await call("reward-start", {})).toMatchObject({ code: 200, body: { reward_id: null } });
    expect((await call("generation-access")).body.ad_group_id).toBeNull();
    expect((await create()).code).toBe(202);
  });

  it("the rollout switch removes the old cap while waiting for the new live app", async () => {
    process.env.TOSS_REWARDED_GENERATION_ENABLED = "false";
    for (let i = 0; i < 5; i++) {
      const next = await create(); expect(next.code).toBe(202); await finish(next.body.job_id);
    }
    expect((await call("generation-access")).body.free_available).toBe(true);
    expect((await call("reward-start", {})).body.reward_id).toBeNull();
    process.env.TOSS_REWARDED_GENERATION_ENABLED = "true";
    expect((await create()).body.code).toBe("AD_REQUIRED");
  });

  it("tickets belong to one account; forged or foreign tickets never grant credit; duplicate claims grant once", async () => {
    const a = await create(); await finish(a.body.job_id);
    const ticket = (await call("reward-start", {})).body.reward_id;
    expect(typeof ticket).toBe("string");
    expect((await call("reward-start", {})).body.reward_id).toBe(ticket);
    expect((await call("reward-claim", { reward_id: "forged" })).code).toBe(409);
    expect((await call("reward-claim", { reward_id: ticket }, "b")).code).toBe(409);
    const claimed = await Promise.all([call("reward-claim", { reward_id: ticket }), call("reward-claim", { reward_id: ticket })]);
    expect(claimed.every(r => r.code === 200)).toBe(true);
    expect((await call("generation-access")).body.reward_credits).toBe(1);
    expect((await call("generation-access", undefined, "b")).body.reward_credits).toBe(0);
    expect((await call("reward-start", {})).body.reward_id).toBeNull();
    const next = await create(); expect(next.code).toBe(202); await finish(next.body.job_id);
    await call("reward-claim", { reward_id: ticket });
    expect((await create()).body.code).toBe("AD_REQUIRED");
  });

  it("rewarded creation has no three-generation weekly ceiling", async () => {
    const first = await create(); await finish(first.body.job_id);
    for (let i = 0; i < 4; i++) {
      const ticket = (await call("reward-start", {})).body.reward_id;
      expect((await call("reward-claim", { reward_id: ticket })).code).toBe(200);
      const next = await create(); expect(next.code).toBe(202); await finish(next.body.job_id);
    }
    expect(enqueued).toHaveLength(5);
  });

  it("queue failures refund free and reward reservations without granting twice", async () => {
    enqueueFails = true;
    expect((await create()).code).toBe(503);
    expect((await call("generation-access")).body.free_available).toBe(true);
    enqueueFails = false;
    const free = await create(); await finish(free.body.job_id);
    const ticket = (await call("reward-start", {})).body.reward_id;
    await call("reward-claim", { reward_id: ticket });
    enqueueFails = true;
    expect((await create()).code).toBe(503);
    expect((await call("generation-access")).body.reward_credits).toBe(1);
    const failed = [...docs.keys()].at(-1)!;
    expect(await finish(failed, false)).toBe(false);
    expect((await call("generation-access")).body.reward_credits).toBe(1);
  });

  it("stale jobs release the account and late workers cannot save or refund again", async () => {
    const first = await create();
    const out = await generationAccess(getFirestore(), account(), Date.now() + RESERVATION_MS + 1);
    expect(out.free_available).toBe(true);
    expect(docs.get(first.body.job_id)?.status).toBe("error");
    expect(await finish(first.body.job_id)).toBe(false);
    expect((await create()).code).toBe(202);
  });

  it("credits survive the weekly reset and are restored after failure", async () => {
    const first = await create(); await finish(first.body.job_id);
    const ticket = (await call("reward-start", {})).body.reward_id;
    await call("reward-claim", { reward_id: ticket });
    const paid = await create(); await finish(paid.body.job_id, false);
    const nextWeek = await generationAccess(getFirestore(), account(), Date.now() + 7 * 86400_000);
    expect(nextWeek.free_available).toBe(true);
    expect(nextWeek.reward_credits).toBe(1);
    expect(nextWeek.active_job_id).toBeNull();
  });

  it("expired tickets cannot grant a reward", async () => {
    const a = await create(); await finish(a.body.job_id);
    const ticket = (await call("reward-start", {})).body.reward_id;
    const state = accessStore().get(account().uid)!;
    state.reward = { ...(state.reward as object), expires_at: Date.now() - 1 };
    expect((await call("reward-claim", { reward_id: ticket })).body.code).toBe("REWARD_EXPIRED");
    expect((await call("generation-access")).body.reward_credits).toBe(0);
  });

  it("in-app deletion keeps the allowance and rejects old callbacks (backlog 037)", async () => {
    const a = await create(); await finish(a.body.job_id);
    const ticket = (await call("reward-start", {})).body.reward_id;
    await call("generation-access", undefined, "b");
    const r = res();
    await (plansGet as unknown as Handler)({ method: "DELETE", path: "/v1/plans", query: {}, headers: headers() }, r);
    expect(r.captured.code).toBe(200);
    // 초기화로 이번 주 무료 생성이 되살아나면 「생성 → 초기화 → 생성」이 비용 한도를 우회한다.
    expect(accessStore().get(account().uid)?.free_week).toBe(generationWeek(Date.now()).week);
    expect(accessStore().has(account("b").uid)).toBe(true);
    expect((await call("reward-claim", { reward_id: ticket })).body.code).toBe("ACCOUNT_RESET");
  });

  it("in-app deletion clears an in-flight reservation without refunding it (backlog 037)", async () => {
    const a = await create(); // 워커가 아직 안 돌았다 — 예약이 살아 있다
    expect(accessStore().get(account().uid)?.active).toBeTruthy();
    const r = res();
    await (plansGet as unknown as Handler)({ method: "DELETE", path: "/v1/plans", query: {}, headers: headers() }, r);
    expect(r.captured.code).toBe(200);
    const state = accessStore().get(account().uid)!;
    expect(state.active).toBeNull(); // 사라진 잡을 가리키면 다음 생성이 그 잡으로 붙는다
    expect(state.free_week).toBe(generationWeek(Date.now()).week); // 환불하지 않는다
    expect(docs.has(a.body.job_id)).toBe(false);
  });

  it("toss withdraw still deletes the allowance", async () => {
    await create();
    const uid = account().uid;
    store("rate_limits").set(uid, { uid, week_start: "2026-08-17", count: 2 });
    process.env.TOSS_WITHDRAW_BASIC = "id:pw";
    const r = res();
    await (tossWithdraw as unknown as Handler)({ method: "POST", headers: { authorization: "Basic id:pw" }, body: { userKey: "reward-a", referrer: "UNLINK" } }, r);
    delete process.env.TOSS_WITHDRAW_BASIC;
    expect(r.captured.code).toBe(200);
    expect(accessStore().has(uid)).toBe(false);
    expect(store("rate_limits").has(uid)).toBe(false);
  });

  it.each(["ok", "generation-error", "save-error"])("real worker settles or refunds reservations (%s)", async mode => {
    const failed = mode !== "ok";
    let first = await create();
    if (failed) {
      await finish(first.body.job_id);
      const ticket = (await call("reward-start", {})).body.reward_id;
      await call("reward-claim", { reward_id: ticket });
      first = await create();
    }
    if (mode === "save-error") beforeTransaction = async () => {
      beforeTransaction = async () => { throw new Error("fixture result storage failure"); };
    };
    const llm = await startFakeLlm([CASES[SAMPLE.id]!.draft], { failAll: mode === "generation-error" });
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.LLM_PROVIDER = "minimax";
    process.env.LLM_API_KEY = "fake-key";
    process.env.LLM_BASE_URL = llm.baseUrl;
    process.env.LLM_MODEL = "fake-model";
    process.env.GENERATION_PIPELINE = "p0"; // 가짜 LLM 은 P0 드래프트 — 기본 auto 면 헬스장이 P1(D105 ①)
    const h: Record<string, string> = { "content-type": "application/json", "x-cloudtasks-queuename": "plansWorker" };
    const run = async () => (plansWorker as unknown as Handler)({ method: "POST", headers: h,
      body: { data: enqueued.at(-1) }, header: (name: string) => h[name.toLowerCase()] }, res());
    try {
      await run();
      const requests = llm.requests.length;
      expect(requests).toBeGreaterThan(0);
      await run(); // duplicate queue delivery cannot execute a terminal job again
      expect(llm.requests).toHaveLength(requests);
    } finally { await llm.close(); }
    expect(docs.get(first.body.job_id)?.status).toBe(failed ? "error" : "ok");
    const access = (await call("generation-access")).body;
    expect(access.active_job_id).toBeNull();
    expect(access.free_available).toBe(false);
    expect(access.reward_credits).toBe(failed ? 1 : 0);
    if (!failed) {
      const saved = store(`weekly_plans/${account().uid}/weeks`).get("2026-08-17")!;
      expect(saved.user_id).toBe(account().uid);
      expect(checkWeeklyPlan(saved.plan).ok).toBe(true);
      const other = res();
      await (plansGet as unknown as Handler)(get(undefined, "/v1/plans/current", headers("b")), other);
      expect(other.captured.code).toBe(404);
    }
  });
});


describe("운동일 아침 알림 — 계약 §2.8 · D90 (T11–T13)", () => {
  const secret = "workout-push-secret";
  const account = (id = "a") => ({ uid: `toss:wp-${id}`, version: "v1" });
  const headers = (id = "a") => ({ authorization: `Bearer ${mintSession(account(id).uid, secret, Date.now(), "v1")}` });
  const call = async (method: "GET" | "PUT", body?: unknown, id = "a") => {
    const r = res();
    await (plansGet as unknown as Handler)({ method, path: "/v1/plans/workout-push", query: {}, body, headers: headers(id) }, r);
    return r.captured as { code: number; body: any };
  };
  beforeEach(() => {
    process.env.SESSION_SECRET = secret;
    for (const id of ["a", "b", "c"]) store("account_lifecycle").set(accountKey(account(id).uid), { version: "v1" });
  });

  it("T11 — 켜고 끄고 읽는다 · boolean 만 받는다", async () => {
    expect((await call("GET")).body).toEqual({ status: "ok", enabled: false });
    expect((await call("PUT", { enabled: true })).body).toEqual({ status: "ok", enabled: true });
    expect((await call("GET")).body).toEqual({ status: "ok", enabled: true });
    expect((await call("PUT", { enabled: "false" })).code).toBe(400);
    expect((await call("GET")).body.enabled).toBe(true);
    await call("PUT", { enabled: false });
    expect((await call("GET")).body.enabled).toBe(false);
  });

  it("T11 — 인증 없으면 401 · 저장 안 함", async () => {
    const r = res();
    await (plansGet as unknown as Handler)({ method: "PUT", path: "/v1/plans/workout-push", query: {}, body: { enabled: true }, headers: {} }, r);
    expect(r.captured.code).toBe(401);
    expect(store("push_subscriptions").size).toBe(0);
  });

  it("T12 — 탈퇴가 동의 문서를 지운다", async () => {
    await call("PUT", { enabled: true });
    process.env.TOSS_WITHDRAW_BASIC = "id:pw";
    const r = res();
    await (tossWithdraw as unknown as Handler)({ method: "POST", headers: { authorization: "Basic id:pw" }, body: { userKey: "wp-a", referrer: "UNLINK" } }, r);
    expect(r.captured.code).toBe(200);
    expect(store("push_subscriptions").has(account().uid)).toBe(false);
  });

  it("T13 — 동의한 사람 중 오늘 운동일인 사람에게만 · 한 사람 실패가 다음을 막지 않는다", async () => {
    const tossModule = await import("../src/auth/toss");
    const sent: Array<{ key: string; code: string; context: unknown }> = [];
    const spy = vi.spyOn(tossModule, "sendTossPush").mockImplementation(async (_cfg, key, code, context) => {
      if (key === "wp-a") throw new Error("send-message: FAIL");
      // 앞 사람을 보내는 사이 다른 사람이 끈다 — 처음 읽은 목록대로 보내면 안 된다.
      if (key === "wp-b") store("push_subscriptions").set(account("d").uid, { workout_day: false });
      sent.push({ key, code, context }); return { sentPushCount: 1 };
    });
    const day = (focus: string, type = "strength") => ({ day_index: 1, session_type: type, focus, exercises: type === "rest" ? [] : [{ exercise_id: "barbell_squat" }] });
    for (const [id, d] of [["a", day("가슴")], ["b", day("하체")], ["c", day("휴식", "rest")], ["d", day("어깨")]] as const) {
      store("push_subscriptions").set(account(id).uid, { workout_day: true });
      store(`weekly_plans/${account(id).uid}/weeks`).set("2026-10-05", { week_start_date: "2026-10-05", plan: { week: [d] } });
    }
    store("push_subscriptions").set("toss:wp-off", { workout_day: false });
    store("weekly_plans/toss:wp-off/weeks").set("2026-10-05", { week_start_date: "2026-10-05", plan: { week: [day("등")] } });
    const oldCert = process.env.TOSS_CLIENT_CERT, oldKey = process.env.TOSS_CLIENT_KEY;
    process.env.TOSS_CLIENT_CERT = "fixture"; process.env.TOSS_CLIENT_KEY = "fixture";
    try {
      // 2026-10-06(화) 08:00 KST = 2026-10-05T23:00Z — UTC 날짜로 계산하면 월요일(day 0)이 된다.
      expect(await sendWorkoutDayPushes(new Date("2026-10-05T23:00:00Z"))).toBe(1);
      expect(sent).toEqual([{ key: "wp-b", code: "burnweek-workout-day", context: { focus: "하체" } }]);
    } finally {
      spy.mockRestore();
      if (oldCert === undefined) delete process.env.TOSS_CLIENT_CERT; else process.env.TOSS_CLIENT_CERT = oldCert;
      if (oldKey === undefined) delete process.env.TOSS_CLIENT_KEY; else process.env.TOSS_CLIENT_KEY = oldKey;
    }
  });
});
