# ADR-0004: Google Drive 저장 — `drive.file` 스코프 + 사용자 가시 폴더

- **Status:** Accepted
- **Date:** 2026-08-16
- **근거:** [D3·D5](./mvp-decision-log.md), research/02. 관련 INV-2, FR-SYNC-2.

## Context
데이터를 사용자 Drive에 저장하고 **다른 AI가 읽는 것**이 제품 핵심 가치. 저장 위치(가시 Drive vs 숨김 appDataFolder)와 OAuth 스코프를 정해야 함.

## Decision
사용자에게 **보이는 Drive**의 전용 폴더(`Workout Data/`)에 저장하고, OAuth 스코프는 **`drive.file`만** 사용한다.

## Consequences
- **긍정:** 파일이 가시·공유 가능(외부 AI 커넥터가 읽음) → 제품 가치 성립. `drive.file`은 비민감 → CASA·연간 재인증·100명 제한·주간 토큰 만료 회피.
- **부정:** 앱이 만든/사용자가 연 파일만 접근(다른 파일 접근 불가 — 본 설계엔 충분). 앱이 fileId 매핑을 관리해야 함.
- **배제:** appDataFolder(외부 AI 접근 불가·앱 삭제 시 소멸 → 가치 훼손), `drive`/`drive.readonly`(제한 스코프 심사).
