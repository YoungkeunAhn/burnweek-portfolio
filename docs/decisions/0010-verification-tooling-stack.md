# ADR-0010: 검증 도구 스택 (Verification Tooling)

- **Status:** Accepted (2026-08-16, 사용자 승인 — **patrol_mcp 파일럿으로 진행**)
- **Date:** 2026-08-16
- **근거:** research/06-verification-tooling.md (codex + sonnet 병렬 웹조사, 교차검증). 관련 ADR-0003(Drift)·0008(Firebase)·0006(LLM 어댑터), INV-1(코드 불변식).

## Context
개발·CI 검증 도구가 필요하다 — 웹의 Playwright에 해당하는 **모바일 UI 검증 + 백엔드/계약 검증**. 대상: Flutter 앱 + Firebase Functions(TS). AI 에이전트가 구동·검증하는 워크플로. (배포용 아님, 개발/CI용.)

## Decision
계층별 스택을 채택한다:
- **단위/위젯:** `flutter_test`(SDK).
- **골든:** **alchemist**(CI 모드) — golden_toolkit는 유지중단이라 배제.
- **통합/네이티브 E2E:** `integration_test` + **Patrol**.
- **에이전트 구동 UI(Playwright 대응):** **`patrol_mcp` 주** (Patrol 하네스 재사용, Dart, hot-restart, `native-tree`/`screenshot`), **Maestro + MCP 보조**(블랙박스/릴리스 빌드). `patrol_mcp`는 **WIP → 파일럿 후 채택, 초기 CI 게이트 아님**; 버전(`patrol`/`patrol_cli`/`patrol_mcp`) 정확 일치.
- **백엔드:** **Vitest** + `firebase-functions-test` v3.5 + **Firebase Emulator Suite**(`emulators:exec`).
- **계약/스키마:** **ajv v8**(2020-12)로 LLM 산출 JSON 검증(타입가드) + **도메인 불변식은 코드 테스트**(INV-1: 볼륨캡·금기·days_per_week는 스키마로 강제 불가) + Vitest `toMatchFileSnapshot`으로 렌더 MD/JSON 골든.
- **CI 티어:** PR=헤드리스(analyze/test/golden/vitest/tsc/ajv/snapshot), 야간=에뮬레이터(Patrol/Maestro/Emulator), 릴리스=기기 팜(Firebase Test Lab/Maestro Cloud).

## Consequences
- **긍정:** 계층별 명확·대부분 헤드리스(에이전트 pass/fail 소비). Patrol 하네스 1개로 통합+에이전트 구동 통일. 계약+불변식 이중 검증으로 INV-1 준수.
- **부정/리스크:** `patrol_mcp` 미성숙(파일럿 필요). Android 에뮬 CI 느림·플레이키(큰 러너/emulator.wtf). alchemist 픽셀 드리프트(CI 모드로 완화). ajv ReDoS CVE는 8.18+ 유지. Maestro는 Flutter 버전 회귀 확인.
- **후속:** 코드 착수 시 `app/`(flutter_test·alchemist·integration_test·Patrol)·`backend/`(Vitest·emulator·ajv) 설정. 버전은 핀 전 재확인(research/06 미검증 목록). 개발 문서 탐색용 python 도구는 `tools/`(별도).
