# LLM 어댑터 (Provider-비종속 계층)

- **Status:** Draft (Phase 1)
- **Date:** 2026-08-16
- **근거:** 결정 D10(provider-비종속)·D11(LLM+코드 분리). research/03 §4(LLM 설계), research/05(어댑터·MiniMax=OpenAI 호환). PRD NFR-LLM-1·INV-4.

## 목적
LLM을 **하나의 좁은 인터페이스 뒤에 격리**해 provider(MiniMax/Gemini/GPT/오픈모델)를 **설정으로 교체**한다. 특정 벤더 구조화출력 보장에 의존하지 않고, **JSON 스키마 프롬프트 + 코드 검증 + 재시도**로 신뢰성을 확보(D10/D11).

## 핵심 발견 (어댑터 수 최소화)
- **MiniMax는 OpenAI 호환 엔드포인트** 제공(`https://api.minimax.io/v1`) → **OpenAI-호환 어댑터 1개로 MiniMax + GPT 커버.** Gemini만 별도 어댑터.
- 즉 Phase 1은 어댑터 **2개**면 충분: `openai-compatible`, `gemini`.
- TS 통합 라이브러리 후보: **Vercel AI SDK**(`@ai-sdk/openai-compatible`, `@ai-sdk/google`).

## 인터페이스 (포트)
```ts
export interface LLMProvider {
  readonly name: string;                    // 'minimax' | 'gpt' | 'gemini'
  readonly capabilities: {
    streaming: boolean;
    jsonSchema: boolean;                     // 네이티브 구조화출력 지원 여부
    maxContextTokens?: number;
  };
  generateDraft(req: DraftRequest): Promise<DraftRaw>;  // DraftPlan(수치 없음)만
}
// DraftRequest: { systemPrefix, userContext, draftSchema }  (systemPrefix = 캐시 대상)
// DraftRaw:     { draft: unknown, model, usage, raw }
//   ← 코드가 DraftPlan 스키마 검증 → 확장 엔진 → WeeklyPlan v1 → 최종 검증
```
- 벤더 SDK는 `providers/openai-compatible.ts`·`providers/gemini.ts` **안에서만** import.
- `registry.ts`가 설정값(`LLM_PROVIDER`)으로 구현 선택 + 폴백.

## 배치 (백엔드 내)
```
backend/src/llm/
├── types.ts            # LLMProvider, PlanRequest, PlanRaw
├── registry.ts         # provider 선택/폴백 (env: LLM_PROVIDER)
├── providers/
│   ├── openai-compatible.ts   # MiniMax + GPT (baseURL 설정)
│   └── gemini.ts
└── index.ts            # 팩토리
```

## 신뢰성 전략 (provider 무관)
1. **스키마 프롬프트:** LLM에는 [DraftPlan 호환성 스키마](./02-data-model.md#b1-draftplan-llm-출력--numeric-light)에서 확장 엔진이 쓰지 않는 필드를 제거한 **compact projection**만 포함한다([ADR-0016](../decisions/0016-generation-timeout-and-compact-draft.md)). 무게·세트 수·휴식·증량·유산소 처방은 LLM이 생성하지 않는다(INV-1). 네이티브 구조화출력 지원 시(`capabilities.jsonSchema`) 사용, 아니면 프리필/지시로 유도.
2. **코드 확장·검증(필수):** DraftPlan을 스키마 검증 → **코드 확장 엔진이 수치(세트·무게·휴식·증량·유산소 지속/강도)를 계산·주입** → 최종 [WeeklyPlan v1](./02-data-model.md)을 스키마 + 값 규칙(범위·금기·볼륨 상한)으로 검증(D11).
3. **수정-재시도 ≤2:** DraftPlan 검증 실패 시 오류를 피드백해 **DraftPlan 재생성**(최종 스키마를 LLM에 재요구하지 않음). 그래도 실패면 FR-GEN-7(직전 플랜 재사용/오류).
4. **역할 경계:** LLM=운동 선택·구성(DraftPlan), 코드=수치·안전(WeeklyPlan v1). 재시도는 **DraftPlan 재생성으로만** 한다(최종 검증 실패도 draft를 다시 받는다 — 최종 스키마를 LLM에 재요구하지 않는다). 단계별 예산 ≤2(S-GEN-8).

## 프롬프트 구조 (비용 — NFR-COST-1)
- **시스템 프리픽스(캐시 대상):** 프로그래밍 규칙 + **compact DraftPlan 스키마** + 안전 가드 → 프롬프트 캐싱으로 재사용. 전체 호환성 스키마는 응답 수용 단계에서만 쓴다.
  - 프로그래밍 규칙에는 **세션 구성 규칙**이 포함된다(research/03 §훈련 분할 + NSCA 운동 순서): 복합→고립 순서(뒤로 갈수록 수행력 10–30%↓), 세션당 4–6종목(`session_len_min` 기준 가감), 한 세션 안 동작 패턴 중복 금지(수평/수직 당기기·무릎/고관절 주도 둘 다), 같은 부위를 주 2회 도는 경우 두 번째 날은 다른 종목·각도. 순서(`order`)는 모델이 정하고 코드는 그대로 정렬만 하므로, 이 규칙이 없으면 고립운동이 세션 앞에 오는 플랜이 나온다.
- **생성 게이트(LLM 호출 이전):** 백엔드는 하드 레드플래그를 먼저 판정해 true면 LLM 호출 없이 차단(FR-SAFE-3). [01-overview §8](./01-overview.md).
- **사용자 턴(변동):** 프로필 + **직전 주 로그**(같은 운동/근육군, 압축 구조화). XML 태그 구획.
- **생성 빈도:** 정규 주 1회/사용자(수동 재생성은 예외).

## 테스트 & 품질
- **어댑터별 회귀·평가 테스트 유지:** 무검증 provider 스왑은 정확도 하락 위험(research/05, 22% 사례) → provider 교체 시 골든셋 회귀 필수.
- **Phase 1 테스트 provider = MiniMax.** POC로 MiniMax의 구조화출력/함수호출 실제 동작 검증(오픈이슈).
- 골든셋: 대표 프로필 N개 → 생성 플랜이 스키마·안전 규칙 통과율 100%.

## 오픈이슈
- MiniMax 네이티브 JSON 스키마 지원 수준(프롬프트 유도 vs 강제) POC.
- Vercel AI SDK 채택 확정 및 MiniMax baseURL/모델명(`MiniMax-M2.1` 등) 확인.
- 스트리밍 필요 여부(플랜 생성은 단발이라 Phase 1 불필요할 수 있음).
