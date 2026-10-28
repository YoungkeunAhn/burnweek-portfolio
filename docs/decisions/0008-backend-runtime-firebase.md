# ADR-0008: 백엔드 런타임 — Firebase Cloud Functions (Gen2)

- **Status:** Accepted (사용자 결정, 2026-08-16 인터뷰)
- **Date:** 2026-08-16
- **Supersedes:** [ADR-0002](./0002-backend-runtime-cloudflare-workers.md)
- **근거:** 백엔드 런타임 조사(2026) + 사용자 판단(콜드스타트 비문제·$0 쿼터 선호). 관련 D3·D8, [ADR-0005](./0005-thin-backend-llm-proxy.md).

## Context
[ADR-0002](./0002-backend-runtime-cloudflare-workers.md)는 Cloudflare Workers를 추천했다(콜드스타트·Java 에뮬레이터·컨테이너 배포를 Firebase의 단점으로 지목). 그러나 사용자가 **콜드스타트를 실질적 문제로 보지 않으며 Firebase로 진행**하기로 결정했다. Firebase Gen2는 **$0 쿼터 내 운영**이 가능하고, 조사에서도 장시간 호출(SSE/스트리밍)은 **동등(tie)** 으로 확인됐다.

## Decision
Phase 1 백엔드 런타임 = **Firebase Cloud Functions (Gen2, TypeScript)**. 얇은 LLM 프록시 역할(ADR-0005)은 동일.
- **비밀키:** `defineSecret`(Google Secret Manager), 핸들러/`onInit`에서 `.value()`. (`functions.config()`는 2027-03 폐기 — 미사용.)
- **타임아웃:** Gen2 HTTP 기본 60s → LLM 호출 여유 위해 **120s로 설정**(우리 p95 ≤60s, NFR-PERF-1). 초과 시 명확한 실패(001 S-GEN-7/13).
- **이식성:** 핸들러는 **config를 주입받도록** 작성(런타임 이식 유지). 라우터로 Hono(웹표준, Node에서도 동작) 선택 사용 가능.
- **provider-비종속 LLM 어댑터**(ADR-0006)는 런타임과 무관하게 유지.

## Consequences
- **긍정:** 인프라 $0(무료 쿼터 내). Google 생태계 친숙(단, Drive 접근은 여전히 클라이언트측이라 IAM 시너지는 제한적). 조사상 장시간 호출 동등.
- **부정/비용:** 콜드스타트 1–12s(사용자가 수용). 로컬 에뮬레이터 **Java JDK 11+** 필요·컨테이너 배포. `minInstances:1`로 콜드스타트 제거 시 idle ~$5–10/mo(옵션).
- **후속:** `backend/`를 Firebase Functions(Gen2)로 스캐폴드; 시크릿 `defineSecret`. ADR-0002는 Superseded. forward 참조(overview·PRD·guides·mvp-log)를 본 ADR로 갱신.

## 정정 (2026-08-18) — "$0"의 전제
본 ADR의 "인프라 $0(무료 쿼터 내)"는 **사용량 기준으로는 사실이지만, 전제가 빠져 있었다**: Gen2 함수·Cloud Tasks·Secret Manager는 모두 **Blaze(결제 수단 등록) 전용**이라 카드 없이는 배포 자체가 불가능하다. 배포 시도에서 드러났다(`functions:secrets:set` → "must be on the Blaze plan").

- **금액 재확인(실측·research/07):** 주 1회 생성 × 100명(월 400건)이면 함수 60,000 vCPU-초(무료 180,000) 등 모든 항목이 무료 한도 안 → **월 $0**. 단 **Artifact Registry 이미지 누적**만 유휴 비용으로 증가하므로 정리 정책이 필수다.
- **결정 유지(사용자, 2026-08-18):** 실제 청구액이 0원이고 전환 비용(런타임 이식)이 있으므로 **Firebase 유지 + Blaze 전환**. 카드 없는 대안(Cloudflare Workers 무료 + Queues + KV)은 research/07에 근거째로 보존한다 — 청구가 실제로 발생하면 `src/index.ts` 한 파일 문제다.
- **비용 통제(본 결정에 부수):** `maxInstances`(접수 10·워커 5·조회 10, 코드), spend cap budget(실차단), 예산 알림 월 5,000원, Artifact Registry 정리 정책. 남용으로 인한 **LLM 실비**를 막는 엔드포인트 인증은 미구현 → 001 T5.5.
