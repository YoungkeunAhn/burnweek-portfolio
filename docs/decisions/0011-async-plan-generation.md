# ADR-0011: 플랜 생성 = 비동기(백그라운드) + FCM 푸시 알림

- **Status:** Accepted · Decision 2의 300초 제한은 [ADR-0016](./0016-generation-timeout-and-compact-draft.md)으로 대체 (사용자 결정, 2026-09-23)
- **Date:** 2026-08-16
- **근거:** 생성 지연 실측(MiniMax-M3 추론 모델, 31–68s 편차 → 동기 p95 ≤ 60s 위태). 사용자가 "사용자가 화면을 보고 있을 필요 없이 백그라운드 생성 → 완료 시 알림"을 요구. 관련 [ADR-0005](./0005-thin-backend-llm-proxy.md)(얇은 프록시)·[ADR-0008](./0008-backend-runtime-firebase.md)(Firebase). NFR-PERF-1·PRIV-1, FR-GEN-1/7.

## Context
기존 설계는 **동기 생성**이었다: 앱이 `POST /v1/plans:generate`를 호출하고 응답으로 완성된 WeeklyPlan v1을 받으며, NFR-PERF-1은 **p95 ≤ 60초**를 요구했다.

POC(2026-08-16)에서 테스트 provider MiniMax-M2/M3가 **추론(reasoning) 모델**이라 생성이 31–68초로 편차가 크고 60초를 넘기는 경우가 확인됐다. 또한 모바일 OS는 앱이 백그라운드로 가면 수십 초~수 분 내 앱을 정지시켜, **앱이 직접 건 장시간 HTTP 요청은 중간에 끊긴다.** 따라서 "사용자가 안 보고 있어도 완성"을 보장하려면 생성이 **서버에서** 끝까지 돌아야 한다.

## Decision
플랜 생성을 **서버 비동기(백그라운드) 작업 + FCM 푸시 알림**으로 전환한다.

1. **접수(enqueue) 엔드포인트** `POST /v1/plans:generate`:
   - **하드 레드플래그 게이트는 동기**로 즉시 판정(LLM 호출 0). 하드=true면 `blocked_red_flag`를 **즉시** 반환(잡 생성 없음, FR-SAFE-3 불변).
   - 아니면 **생성 잡(GenerationJob)** 을 생성하고 `202 { job_id, status: "queued" }` 반환. 작업은 **Cloud Tasks**(`onTaskDispatched`)로 enqueue.
2. **워커(백그라운드 함수)** 가 생성 파이프라인(draft→확장→검증) 실행. **타임아웃 300초**(NFR-PERF-1 완화; Cloud Run 기반 Gen2는 최대 3600s 지원). — 이 조항은 [ADR-0008](./0008-backend-runtime-firebase.md)의 **HTTP 120s 타임아웃 가정("우리 p95 ≤ 60s")만 국소 대체**한다: 이제 **접수 HTTP 함수는 단발·짧게(≤2s)** 유지하고, **LLM 호출은 300s 워커**로 옮긴다. ADR-0008의 런타임(Firebase Gen2) 결정 자체는 유효. **이 항목의 300초 값은 ADR-0016이 540초로 대체한다.**
3. **완료 시 FCM 푸시**를 사용자 기기로 발송. 앱은 `GET /v1/plans/{job_id}`로 완성 플랜을 가져와 **로컬(Drift)에 저장**한다. 실패도 잡 상태 `error` + 푸시로 통지(FR-GEN-7: 앱이 직전 플랜 재사용/오류+수동 재시도).
4. **기기 토큰 등록:** 앱은 FCM 등록 토큰을 접수 요청(`fcm_token`)으로 백엔드에 전달한다.

**프라이버시(NFR-PRIV-1 유지):** GenerationJob 저장소(Firestore)는 **일시적(ephemeral)** 이다 — 완성 플랜은 앱이 가져갈 때까지만 보관하고 **짧은 TTL로 자동 삭제**(권장 24h). 영구 사용자 이력 DB는 여전히 없으며 **원본은 사용자 Drive**다.

## Consequences
- **긍정:** 생성 지연이 UX를 막지 않음(사용자는 앱을 닫아도 됨). 추론 모델의 지연 편차·60초 초과가 더 이상 실패가 아님. 주 1회 생성이라 잡 볼륨·비용 미미(NFR-COST-1).
- **부정/비용:** 인프라 증가 — **Cloud Tasks + Firestore(ephemeral, TTL) + FCM**. 앱에 **`firebase_core` + `firebase_messaging`** 추가 필요(기존 "앱은 Firebase SDK 미사용"은 불변식이 아닌 *결과*였고, 본 ADR에서 그 범위를 좁힘 — 푸시 한정). 잡 상태 폴링 폴백(푸시 미수신 대비) 필요.
- **불변식:** INV-1~6 불위반(수치·안전은 코드 소유, Drive 원본, 로컬 우선 유지). NFR-PRIV-1은 *ephemeral+TTL*로 유지.
- **갱신 대상:** **NFR-PERF-1**(60s→300s), **FR-GEN-1**(동기 p95→비동기 접수+푸시), **G1**(1분→5분·알림), generation-api 계약(동기→비동기), [01-overview](../architecture/01-overview.md)(컨테이너/흐름). GenerationJob 스키마는 [02-data-model](../architecture/02-data-model.md)에 추가.
- **후속:** ADR-0008 배포에 Cloud Tasks/Firestore(TTL 규칙)/FCM 설정 추가. 스트리밍은 여전히 불필요(비동기라 무의미).
