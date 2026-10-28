# ADR-0009: Flutter 상태관리 — Riverpod

- **Status:** Accepted (사용자 결정, 2026-08-16 인터뷰)
- **Date:** 2026-08-16
- **근거:** [ADR-0003 Drift](./0003-local-store-drift.md)(로컬 저장소 조사에서 Riverpod 정합 언급), 기능 002 UI 바인딩. 관련 D5.

## Context
로컬 저장소 Drift의 reactive `.watch()` 스트림을 UI에 바인딩해야 한다. ADR-0003은 Riverpod/Bloc를 열어뒀다. 단일 개발자·중소 규모 앱.

## Decision
상태관리 = **Riverpod**. Drift `.watch()` → **`StreamProvider`(AsyncValue)** 로 직결한다. 기능별 `controllers/`(AsyncNotifier)로 구성, Page/View 강제 분리 없음.

## Consequences
- **긍정:** Drift 스트림과 관용적 결합(ADR-0003 조사), 보일러플레이트 적음, 단일 개발자 생산성.
- **부정:** 팀 확장 시 Bloc식 엄격한 이벤트/상태 규율은 별도 컨벤션으로 보완 필요.
- **후속:** `app/lib/**/controllers/`에 Riverpod notifier 배치. 002 design의 "`.watch()`→Riverpod"과 정합.
