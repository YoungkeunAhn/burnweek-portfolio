/**
 * Config assembly (ADR-0008 portability): handlers receive config by INJECTION,
 * never by reading globals. This module maps env/secrets → a plain object so the
 * same handler runs under Firebase, a local emulator, or any other runtime.
 */
import type { LLMConfig } from "./llm";
import type { TossConfig } from "./auth/toss";

export interface AppConfig {
  llm: LLMConfig;
  /** Async worker hard limit (ADR-0016: 540s). The speed SLO remains p90 ≤ 60s. */
  workerTimeoutSec: number;
  /** Max DraftPlan repair retries on schema failure (architecture/03 §신뢰성). */
  maxRepairRetries: number;
  /** 토스 로그인. 인증서·서명키가 없으면 그 경로만 비활성이고 나머지는 그대로 돈다. */
  toss: TossConfig;
  /**
   * 생성 파이프라인([ADR-0025]). `p0` = 운영 프롬프트(LLM 이 종목·구성), `p1` = 코드 골격 + 슬롯 채우기.
   * 기본 `auto` = 헬스장만 `p1`, 그 밖은 `p0`(D105 ① · `pipelineFor`). `p0`·`p1` 은 실측용 강제값이다.
   */
  pipeline: "auto" | "p0" | "p1";
  /** 맨몸 서킷 생성(D102 · 실행 그래프 N7a↔N7b 짝). 화면(N7b)이 서킷을 그리므로 기본 켬 — `CIRCUIT_GENERATION=off` 로 끈다. */
  circuits: boolean;
}

export interface RawEnv {
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  /** `adaptive` keeps the provider default; `disabled` requests a direct answer where supported. */
  LLM_REASONING_MODE?: string;
  LLM_MAX_COMPLETION_TOKENS?: string;
  /** Worker timeout in seconds. Must match the deployed `timeoutSeconds`. */
  WORKER_TIMEOUT_SEC?: string;
  /** `auto`(기본 · 헬스장만 p1) | `p0` | `p1` — ADR-0025 · D105. */
  GENERATION_PIPELINE?: string;
  /** `off` 면 맨몸 감량 사용자의 유산소 자리에 서킷을 넣지 않는다(D101 ④). 기본 켬(N7b). */
  CIRCUIT_GENERATION?: string;
  /** 토스 파트너 API 클라이언트 인증서(콘솔 발급). PEM 문자열 — PKCS#12 는 쓰지 않는다. */
  TOSS_CLIENT_CERT?: string;
  TOSS_CLIENT_KEY?: string;
  /** 세션 토큰 서명키. 없으면 토스 로그인 엔드포인트가 503 을 낸다. */
  SESSION_SECRET?: string;
}

/** D105 ①: 헬스장 3 프로필만 P1 이 이겼다(2차 실측 6-0-3). 그 밖 환경은 근거가 없어 P0 다. */
export function pipelineFor(pipeline: AppConfig["pipeline"], environment: string): "p0" | "p1" {
  if (pipeline !== "auto") return pipeline;
  return environment === "full_gym" ? "p1" : "p0";
}

export function buildConfig(env: RawEnv): AppConfig {
  const provider = env.LLM_PROVIDER?.trim() || "minimax";
  const apiKey = env.LLM_API_KEY?.trim() || "";
  const baseUrl = env.LLM_BASE_URL?.trim() || "https://api.minimax.io/v1";
  const model = env.LLM_MODEL?.trim() || "MiniMax-M3";
  const reasoningMode = env.LLM_REASONING_MODE?.trim() || "adaptive";

  if (reasoningMode !== "adaptive" && reasoningMode !== "disabled") {
    throw new Error("LLM_REASONING_MODE must be 'adaptive' or 'disabled'.");
  }

  const rawMaxCompletionTokens = env.LLM_MAX_COMPLETION_TOKENS?.trim();
  const parsedMaxCompletionTokens = rawMaxCompletionTokens ? Number(rawMaxCompletionTokens) : undefined;
  if (
    parsedMaxCompletionTokens !== undefined &&
    (!Number.isInteger(parsedMaxCompletionTokens) || parsedMaxCompletionTokens <= 0)
  ) {
    throw new Error("LLM_MAX_COMPLETION_TOKENS must be a positive integer when set.");
  }

  const pipeline = env.GENERATION_PIPELINE?.trim() || "auto";
  if (pipeline !== "auto" && pipeline !== "p0" && pipeline !== "p1") {
    throw new Error("GENERATION_PIPELINE must be 'auto', 'p0' or 'p1'.");
  }

  if (!apiKey) {
    throw new Error("LLM_API_KEY is empty. Set it in backend/.env (dev) or Secret Manager (prod).");
  }

  // A misconfigured value (0, negative, non-numeric) would shorten the worker's
  // self-deadline instead of failing loudly, so only a positive number counts.
  const configuredTimeout = Number(env.WORKER_TIMEOUT_SEC);
  const workerTimeoutSec = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 540;

  return {
    llm: {
      provider,
      apiKey,
      baseUrl,
      model,
      reasoningMode,
      ...(parsedMaxCompletionTokens !== undefined
        ? { maxCompletionTokens: parsedMaxCompletionTokens }
        : {}),
    },
    workerTimeoutSec,
    maxRepairRetries: 2,
    pipeline,
    circuits: env.CIRCUIT_GENERATION?.trim() !== "off",
    toss: {
      clientCert: env.TOSS_CLIENT_CERT?.trim() || undefined,
      clientKey: env.TOSS_CLIENT_KEY?.trim() || undefined,
      sessionSecret: env.SESSION_SECRET?.trim() || undefined,
    },
  };
}
