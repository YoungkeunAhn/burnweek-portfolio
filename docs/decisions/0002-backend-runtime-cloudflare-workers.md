# ADR-0002: 백엔드 런타임 — Cloudflare Workers + Hono

- **Status:** **Superseded by [ADR-0008](./0008-backend-runtime-firebase.md)** (2026-08-16 인터뷰 — 사용자가 Firebase 선택, 콜드스타트 비문제로 판단). 아래 내용은 히스토리로 보존.
- **Date:** 2026-08-16
- **근거 조사:** 백엔드 런타임 비교 조사(2026). 관련: [architecture/01-overview §7](../architecture/01-overview.md), PRD §13 오픈이슈, 결정 D3(얇은 프록시)·D8(무료·비용통제)·D10(provider 비종속).

## Context
얇은 서버리스 백엔드가 **LLM 프록시 역할만** 한다(키 주입·호출·코드 확장/검증, TS). 영구 사용자 DB 없음(데이터=사용자 Drive, 접근은 **클라이언트측** `drive.file` OAuth). Phase 1 무료·비용통제. LLM 호출은 수 초~최대 ~60초(NFR-PERF-1). 후보: Cloudflare Workers vs Firebase Cloud Functions(Gen2) (그 외 Deno Deploy/AWS Lambda 참고).

조사 요지:
- **비용/저스케일:** Workers Paid $5/mo(넉넉). Firebase Gen2 $0 쿼터 내 가능하나 `minInstances:1`로 콜드스타트 제거 시 idle ~$5–10/mo.
- **장시간 호출:** Workers는 LLM 대기가 **I/O wait라 CPU-time 제한과 무관**(과금·제한에 유리). Firebase Gen2도 Cloud Run 기반 SSE/스트리밍 지원 → **capability는 타이**. Lambda는 대기 wall-clock 전체 과금(불리).
- **콜드스타트/DX:** Workers 무콜드스타트급·JDK 불필요. Firebase 에뮬레이터는 **Java JDK 11+ 필요**, 컨테이너 배포·콜드스타트 1–12s.
- **Google 시너지:** Drive 접근이 **클라이언트측**이라 서버 ADC는 사용자 Drive 접근 0 → **Firebase의 Google 시너지 이점 무의미**(리포로 검증).
- **이식성:** **Hono**(웹표준 `Request`/`Response`) 핸들러는 Workers/Deno/Lambda/Node/Vercel 공통 → D10/이식성 요구 충족.
- **리스크:** 중간 프록시의 장시간 응답 끊김 임계 ~100–180s → 단일 LLM 호출 ~90s 미만 유지 또는 SSE/async. (우리 p95 ≤60s라 여유.)

## Decision
Phase 1 백엔드 런타임 = **Cloudflare Workers(Paid, $5/mo)**, 핸들러는 **Hono**로 작성해 이식성 확보. 비밀키(LLM)는 `wrangler secret`(암호화), config는 `env`로 주입(핸들러가 config를 주입받도록 작성 — 런타임 이식). **Firebase Cloud Functions(Gen2)를 동등 폴백**으로 명시(스트리밍 타이·$0 쿼터). 단일 LLM 호출·응답은 **≤60s(NFR-PERF-1 p95) 타임아웃 정책**을 두고 초과 시 명확한 실패로 전환한다(001 S-GEN-7/13). 60s는 프록시 응답 임계(~100–180s)보다 충분히 낮아 여유.

## Consequences
**긍정:** LLM I/O 대기 무료·무콜드스타트·경량 DX(Java 불필요)·Hono로 provider/런타임 이식성. p95 60s 요건과 정합.
**부정/비용:** Paid $5/mo(사용자 무료와 무관한 인프라 비용). Workers 생태계 특유 제약(장시간 응답 임계) 준수 필요. Firebase 대비 Google IAM 통합은 없음(본 설계엔 불필요).
**후속:** `backend/`를 Hono+Workers로 스캐폴드; `wrangler.jsonc`·`.dev.vars`(git-ignore). architecture/01-overview §7·PRD §13에서 "런타임 미확정" → 본 ADR로 갱신. 폴백 전환 시 Hono 핸들러 재사용.
