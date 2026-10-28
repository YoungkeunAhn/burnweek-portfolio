/**
 * 토스 로그인 — 서버측 코드 교환과 세션 발급.
 *
 * 왜 필요한가: 미니앱은 `User.getAnonymousKey()`로 신원을 얻지만 **서버가 그
 * 값을 검증할 수단이 없다.** 검증되지 않은 uid 를 믿으면 공격자가 매 요청 다른
 * uid 를 자칭해 주간 생성 한도를 무제한 우회하고, 새는 것은 LLM 실비다(D8).
 * 그래서 토스가 보증하는 `userKey` 를 서버가 직접 받아 온다.
 *
 * 흐름(research/04 §3):
 *   1. 클라이언트 `appLogin()` → authorizationCode(10분) + referrer
 *   2. 서버가 **mTLS** 로 generate-token → accessToken(1h)
 *   3. 서버가 login-me → userKey (토스가 보증하는 사용자 식별자)
 *   4. 서버가 자체 세션 토큰을 HMAC 서명해 발급 → 이후 요청은 이걸 Bearer 로
 *
 * 4번을 두는 이유: userKey 를 그대로 클라이언트가 보내게 하면 결국 다시
 * "검증되지 않은 문자열"이 된다. 서명이 있어야 서버가 자기가 발급한 것임을 안다.
 *
 * 의존성 없음 — mTLS 는 node:https, 서명은 node:crypto 로 끝난다.
 */
import { request as httpsRequest } from "node:https";
import { createHmac, timingSafeEqual } from "node:crypto";

const API_HOST = "apps-in-toss-api.toss.im";
const TOKEN_PATH = "/api-partner/v1/apps-in-toss/user/oauth2/generate-token";
const ME_PATH = "/api-partner/v1/apps-in-toss/user/oauth2/login-me";
/** 기능성 메시지(파트너 서버 발송). 콘솔에서 승인된 템플릿 코드로만 보낼 수 있다(5004 = 미승인). */
const SEND_MESSAGE_PATH = "/api-partner/v1/apps-in-toss/messenger/send-message";
/** 콘솔에 등록·승인된 「주간 플랜 완성」 서버 발송 템플릿 코드(2026-09-08 · 알림동의문 121169). */
export const PLAN_READY_TEMPLATE = "burnweek-plan-ready";
/** 「오늘의 운동」 서버 발송 템플릿(2026-10-06 승인 · 알림동의문 128076 · D90). 변수 `{{focus}}`. */
export const WORKOUT_DAY_TEMPLATE = "burnweek-workout-day";

/** 세션 수명. accessToken(1h)과 맞춘다 — 더 길게 잡을 근거가 없다. */
export const SESSION_TTL_SEC = 3600;

export interface TossConfig {
  /**
   * 콘솔 발급 클라이언트 인증서 — **PEM 문자열 그대로**. 파일시스템은 필요 없다.
   * PKCS#12 로 묶지 않는다: 콘솔이 주는 p12 는 legacy RC2-40 이라 Node(OpenSSL 3)가
   * `Unsupported PKCS12 PFX data` 로 거부해 로그인이 전부 401 이 됐다(2026-08-25).
   * PEM 을 쓰면 변환 단계가 없어 `probe:toss` 가 검증하는 경로와 런타임 경로가 같다.
   */
  clientCert?: string;
  clientKey?: string;
  /** 세션 서명 키. 없으면 토스 로그인 경로 전체가 비활성이다. */
  sessionSecret?: string;
  /** 테스트에서 로컬 mTLS 서버를 가리키기 위한 것. 프로덕션은 기본값을 쓴다. */
  apiOrigin?: { host: string; port?: number; ca?: string };
  /** 테스트에서 무응답 상한을 줄이기 위한 것. 프로덕션은 `MTLS_TIMEOUT_MS`. */
  timeoutMs?: number;
}

interface TossResult<T> {
  resultType: string;
  success?: T;
  error?: unknown;
}

/** mTLS POST/GET 한 번. undici 로는 클라이언트 인증서를 붙이기 번거로워 node:https 를 쓴다. */
/** 토스 API 무응답 상한 — 없으면 멈춘 연결 하나가 예약 발송 전체를 붙잡는다(사용률 N4 · codex). 소켓 유휴 기준. */
const MTLS_TIMEOUT_MS = 15_000;

function mtlsRequest(
  cfg: TossConfig,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string }> {
  const origin = cfg.apiOrigin ?? { host: API_HOST };
  const tls = { cert: cfg.clientCert, key: cfg.clientKey };

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: origin.host,
        port: origin.port ?? 443,
        path,
        method,
        headers: { "content-type": "application/json", ...headers },
        ...tls,
        ...(origin.ca ? { ca: origin.ca } : {}),
        timeout: cfg.timeoutMs ?? MTLS_TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    // 요청 자체를 끊는다 — 기다림만 그만두면 늦게 발송될 수 있다.
    req.on("timeout", () => req.destroy(new Error(`${path}: TIMEOUT`)));
    if (body) req.write(body);
    req.end();
  });
}

function unwrap<T>(raw: string, what: string): T {
  let parsed: TossResult<T>;
  try {
    parsed = JSON.parse(raw) as TossResult<T>;
  } catch {
    throw new Error(`${what}: 응답이 JSON 이 아닙니다`);
  }
  if (parsed.resultType !== "SUCCESS" || !parsed.success) {
    // 서버 API 공통 규격: 실패는 { resultType:"FAIL", error:{ errorCode, reason } }.
    const e = parsed.error as { errorCode?: string; reason?: string } | undefined;
    throw new Error(`${what}: ${e?.errorCode ?? parsed.resultType}${e?.reason ? ` — ${e.reason}` : ""}`);
  }
  return parsed.success;
}

/** 1회용 authorizationCode(10분) → accessToken(1h). */
export async function exchangeCode(
  cfg: TossConfig,
  authorizationCode: string,
  referrer: string,
): Promise<string> {
  const { status, text } = await mtlsRequest(
    cfg,
    "POST",
    TOKEN_PATH,
    {},
    JSON.stringify({ authorizationCode, referrer }),
  );
  if (status !== 200) throw new Error(`generate-token: HTTP ${status}`);
  return unwrap<{ accessToken: string }>(text, "generate-token").accessToken;
}

/**
 * accessToken → userKey. 이름·전화·생일 등은 암호화되어 오지만 **읽지 않는다** —
 * 우리에게 필요한 건 안정적인 식별자 하나뿐이고, 나머지는 받는 순간
 * 프라이버시 부담만 는다(constitution 프라이버시 조항).
 */
export async function fetchUserKey(cfg: TossConfig, accessToken: string): Promise<string> {
  const { status, text } = await mtlsRequest(cfg, "GET", ME_PATH, {
    authorization: `Bearer ${accessToken}`,
  });
  if (status !== 200) throw new Error(`login-me: HTTP ${status}`);
  const me = unwrap<{ userKey: number | string }>(text, "login-me");
  if (me.userKey === undefined || me.userKey === null) throw new Error("login-me: userKey 없음");
  return String(me.userKey);
}

// ── 세션 토큰 ────────────────────────────────────────────────────────────────
// `<base64url(uid.expEpochSec)>.<base64url(hmac)>` — JWT 를 쓸 만큼 복잡하지 않다.
// ponytail: 회전 없는 단일 서명키. 키 회전이 필요해지면 payload 에 kid 를 넣는다.

const b64u = (b: Buffer) => b.toString("base64url");

function sign(payload: string, secret: string): string {
  return b64u(createHmac("sha256", secret).update(payload).digest());
}

export function mintSession(uid: string, secret: string, nowMs: number, version?: string): string {
  if (uid.includes(".")) throw new Error("uid 에 '.' 을 쓸 수 없습니다");
  if (version !== undefined && !/^[a-zA-Z0-9-]+$/.test(version)) throw new Error("Invalid account version");
  const payload = `${uid}.${version === undefined ? "" : `${version}.`}${Math.floor(nowMs / 1000) + SESSION_TTL_SEC}`;
  const encoded = b64u(Buffer.from(payload, "utf8"));
  return `${encoded}.${sign(encoded, secret)}`;
}

/** 유효하면 uid, 아니면 null. 서명 → 만료 순으로 본다. */
export function verifySession(token: string, secret: string, nowMs: number): string | null {
  return verifySessionClaims(token, secret, nowMs)?.uid ?? null;
}

export function verifySessionClaims(token: string, secret: string, nowMs: number): { uid: string; version: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(encoded, secret));
  // 길이가 다르면 timingSafeEqual 이 던진다 — 먼저 거른다.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const sep = payload.lastIndexOf(".");
  if (sep <= 0) return null;
  const exp = Number(payload.slice(sep + 1));
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return null;
  const parts = payload.slice(0, sep).split(".");
  if (parts.length > 2 || !parts[0] || (parts.length === 2 && !/^[a-zA-Z0-9-]+$/.test(parts[1]!))) return null;
  return { uid: parts[0], version: parts[1] ?? "0" };
}

/** 전체 흐름. 실패는 던진다 — 호출부가 401 로 바꾼다. */
export async function loginWithToss(
  cfg: TossConfig,
  authorizationCode: string,
  referrer: string,
  nowMs: number,
): Promise<{ uid: string; sessionToken: string; expiresInSec: number }> {
  if (!cfg.sessionSecret) throw new Error("SESSION_SECRET 미설정 — 토스 로그인 비활성");
  const accessToken = await exchangeCode(cfg, authorizationCode, referrer);
  const userKey = await fetchUserKey(cfg, accessToken);
  return {
    uid: tossUid(userKey),
    sessionToken: mintSession(tossUid(userKey), cfg.sessionSecret, nowMs),
    expiresInSec: SESSION_TTL_SEC,
  };
}

/**
 * 「플랜이 완성됐어요」 푸시 한 통 — 파트너 서버 발송(기능성 메시지). 동의하지 않은 사용자에게는 토스가 안 보내고
 * FAIL 로 답한다 — 그건 오류가 아니라 정상이라 로그만 남긴다(호출부). 사용자당 분당 10회 상한.
 */
export function sendPlanReadyPush(cfg: TossConfig, userKey: string): Promise<{ sentPushCount: number }> {
  return sendTossPush(cfg, userKey, PLAN_READY_TEMPLATE, {});
}

/** 기능성 메시지 한 통(템플릿 코드 + 변수). 미동의 FAIL 도 여기서 던진다 — 호출부가 로그만 남긴다. */
export async function sendTossPush(cfg: TossConfig, userKey: string, templateSetCode: string, context: Record<string, string>): Promise<{ sentPushCount: number }> {
  const { status, text } = await mtlsRequest(cfg, "POST", SEND_MESSAGE_PATH, { "x-toss-user-key": userKey },
    JSON.stringify({ templateSetCode, context }));
  if (status !== 200) throw new Error(`send-message: HTTP ${status}`);
  const ok = unwrap<{ sentPushCount?: number }>(text, "send-message");
  return { sentPushCount: ok.sentPushCount ?? 0 };
}

/** 우리 uid → 토스 `userKey`. 토스 로그인이 아닌 신원(익명 dev 키 등)이면 `null` — 보낼 곳이 없다. */
export function userKeyOf(uid: string): string | null {
  return uid.startsWith("toss:") ? uid.slice(5) : null;
}

/** 토스 `userKey` → 우리 uid. 접두사를 붙여 다른 신원 체계(Firebase uid)와 절대 겹치지 않게 한다. */
export function tossUid(userKey: string | number): string {
  return `toss:${userKey}`;
}

/**
 * 탈퇴 콜백 본문 → 지울 uid. 규격은 계약 §2.5.1 — 콘솔 `테스트하기` 로 캡처했다
 * (2026-08-24): `{"userKey": 0, "referrer": "UNLINK"}`.
 *
 * **모르는 모양이면 `null` 이고 호출부는 아무것도 지우지 않는다.** 플랫폼이 규격을
 * 공개하지 않아 다른 이벤트가 같은 주소로 올 가능성을 배제할 수 없고, 삭제는
 * 되돌릴 수 없다 — 모호하면 안 지우는 쪽이 옳다.
 */
export function withdrawUid(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { userKey, referrer } = body as { userKey?: unknown; referrer?: unknown };
  if (referrer !== "UNLINK") return null;
  if (typeof userKey !== "string" && typeof userKey !== "number") return null;
  // 캡처된 `0` 은 콘솔 테스트의 더미다 — 타입만 취하고 값은 믿지 않는다.
  const key = String(userKey).trim();
  return key === "" ? null : tossUid(key);
}

/**
 * 탈퇴 콜백의 Basic 인증. 콘솔(유저정보 불러오기 → 콜백 설정하기)에 넣은 값과
 * 같은 `id:pw` 원문을 `expected` 로 받는다.
 *
 * 토스 로그인과 같은 파일에 두는 이유: 둘 다 **플랫폼이 우리를 부를 때 쓰는 인증**
 * 이고, 여기엔 부수효과가 없어 그대로 테스트된다.
 */
export function basicAuthOk(header: string, expected: string): boolean {
  // 콘솔 입력칸이 `Basic ` 접두사를 붙이는지, base64 를 씌우는지, **이미 base64 인
  // 입력을 한 번 더 씌우는지** 문서에 없다(실측: 붙여넣은 base64 를 다시 감쌌다).
  // 그래서 **우리 자격증명의 허용 형태를 늘려** 어느 쪽이 오든 받는다 — 입력을
  // 디코딩하지 않으므로 신원 강도는 그대로다: `id:pw` 원문을 모르면 어느 형태도
  // 만들 수 없다. 틀린 조합 하나를 알아내려고 `테스트하기` 를 왕복하는 비용이
  // 허용 형태를 늘리는 비용보다 크다.
  const credential = header.replace(/^Basic /i, "");
  const once = Buffer.from(expected).toString("base64");
  const twice = Buffer.from(once).toString("base64");
  return eq(credential, expected) || eq(credential, once) || eq(credential, twice);
}

/** 상수시간 비교. 길이가 다르면 timingSafeEqual 이 던지므로 먼저 거른다. */
function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
