# ADR-0005: 얇은 백엔드 = LLM 프록시 + 클라이언트측 Drive 쓰기

- **Status:** Accepted
- **Date:** 2026-08-16
- **근거:** [D3](./mvp-decision-log.md), research/02 §6. 관련 INV-3, NFR-SEC-1·PRIV-1. 런타임은 [ADR-0008](./0008-backend-runtime-firebase.md)(Firebase; ADR-0002 supersede).

## Context
LLM 호출에는 API 키가 필요하나 앱에 번들하면 추출된다. Drive 쓰기는 사용자 토큰이 필요하다. 백엔드 책임 경계를 정해야 함.

## Decision
백엔드는 **LLM 프록시 역할만**(키 주입·호출·코드 확장/검증). **Google Drive 읽기/쓰기는 Flutter 앱이 `drive.file`로 직접** 수행한다. 백엔드는 영구 사용자 이력 DB를 두지 않는다.

## Consequences
- **긍정:** LLM 키 노출 0(서버 전용). 서버가 사용자 Drive 토큰을 보관하지 않음(프라이버시·공격면 축소). 데이터 원본=사용자 Drive.
- **부정:** 직전 플랜 재사용·오프라인 캐시는 **클라이언트 책임**(서버 이력 없음). 앱이 동기화·충돌을 다룸(003).
- **배제:** 서버가 Drive까지 소유(토큰 보관 부담·D3 위반), 앱이 LLM 직접 호출(키 노출).
