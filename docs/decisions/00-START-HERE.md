# 📍 START HERE — decisions/

> **목적:** 아키텍처·제품 결정 기록(ADR)과 결정 로그. "왜 이렇게 정했는가"의 단일 출처. 사람·AI가 안정적 ID로 인용한다.

## 규약 (ADR)
- **Nygard 포맷 5섹션:** Title · Status · Context · Decision · Consequences.
- 파일명 `NNNN-kebab-title.md` (**4자리 넘버링**, 예 `0001-`). 진입점만 `00-START-HERE.md`.
- 수락 후 **불변(immutable).** 바뀌면 새 ADR로 supersede하고 양방향 링크. 삭제 금지.
- 상태: `Proposed` → `Accepted` → (`Deprecated` | `Superseded by ADR-NNNN`).

## 파일 매니페스트

| 파일 | 내용 | 상태 |
|---|---|---|
| [mvp-decision-log.md](./mvp-decision-log.md) | **핵심 결정 로그 D1~**(상단 색인표가 목록·상태): D1–D11(인터뷰 확정) + D12–D15(온보딩·한글화·복원·인증) + **D16 미니앱 전환 · D17 기록 화면 주간 스트립 · D18 등록 선시도·의료 파기 · D19 저장 모델(서버 정본 Firestore)** | 확정 · 2026-09-12 [D44~D51 출시 후 피드백 인터뷰](./mvp-decision-log.md#d44)(온보딩 재구성 · 활동일 총수 · 요일 배치 · 밀당 분할 · 추천 · 주간 요구 · 실행 진입 · 동작 사진) · [D97](./mvp-decision-log.md#d97) 머신 58종 로컬 앱 연결·검증 완료(2026-10-13) · [D100](./mvp-decision-log.md#d100) 케이블 20종 로컬 앱 연결·검증 완료(2026-10-14) |
| [0001-docs-scaffolding-and-repo-structure.md](./0001-docs-scaffolding-and-repo-structure.md) | 문서 스캐폴딩·리포 구조 규약 | Accepted |
| [0002-backend-runtime-cloudflare-workers.md](./0002-backend-runtime-cloudflare-workers.md) | 백엔드 런타임(Cloudflare Workers) — 히스토리 | **Superseded → 0008** |
| [0008-backend-runtime-firebase.md](./0008-backend-runtime-firebase.md) | 백엔드 런타임 = **Firebase Cloud Functions (Gen2)** | Accepted |
| [0003-local-store-drift.md](./0003-local-store-drift.md) | Flutter 로컬 저장소 = Drift(SQLite) | Accepted |
| [0004-drive-file-scope-visible-folder.md](./0004-drive-file-scope-visible-folder.md) | Drive `drive.file` + 가시 폴더 (D3·D5) | Accepted |
| [0005-thin-backend-llm-proxy.md](./0005-thin-backend-llm-proxy.md) | 얇은 백엔드 LLM 프록시 + 클라이언트 Drive (D3) | Accepted |
| [0006-provider-agnostic-llm-adapter.md](./0006-provider-agnostic-llm-adapter.md) | provider-비종속 LLM 어댑터 + LLM/코드 분리 (D10·D11) | Accepted |
| [0007-storage-format-markdown-json.md](./0007-storage-format-markdown-json.md) | Drive 저장 포맷 MD+JSON (D6) | Accepted |
| [0009-state-management-riverpod.md](./0009-state-management-riverpod.md) | Flutter 상태관리 = **Riverpod** | Accepted |
| [0010-verification-tooling-stack.md](./0010-verification-tooling-stack.md) | 검증 도구 스택(Patrol/patrol_mcp·Vitest·ajv·alchemist) | Accepted |
| [0011-async-plan-generation.md](./0011-async-plan-generation.md) | 플랜 생성 = **비동기(백그라운드) + FCM 푸시** | Accepted · 300초 조항은 0016으로 대체 |
| [0012-exercise-search.md](./0012-exercise-search.md) | 운동 검색 시 부위 유지·한글/별칭 검색·후보 더 보기(D25 일부 대체) | Accepted |

| [0013-rewarded-plan-generation.md](./0013-rewarded-plan-generation.md) | 미니앱 주 1회 무료 + 추가 생성 보상형 광고(D8 일부 대체) | Accepted |
| [0014-per-project-harness-and-pnpm-workspace.md](./0014-per-project-harness-and-pnpm-workspace.md) | 프로젝트별 AGENTS.md/CLAUDE.md·훅·pnpm 워크스페이스(ADR-0001 §5 대체) | Accepted |
| [0015-rest-notifications.md](./0015-rest-notifications.md) | 운동 화면 유지·세션 전체 휴식 타이머·잠금 푸시 실험 | Accepted (2026-09-11) · 결정 3 일부 → [D71](./mvp-decision-log.md#d71) |
| [0016-generation-timeout-and-compact-draft.md](./0016-generation-timeout-and-compact-draft.md) | 생성 신뢰성 상한 540초 + 결과 경계 유지형 compact DraftPlan | Accepted (2026-09-23) · 0011 Decision 2 일부 대체 |
| [0017-miniapp-progress-cloud-drafts.md](./0017-miniapp-progress-cloud-drafts.md) | 진행 중 기록 Firestore 미러·충돌 보존·PITR/백업(D22-6 로컬 전용 부분 대체) | Accepted (2026-09-23) · 운동 중 편집만 이어 쓰던 범위는 0018 |
| [0018-same-device-plan-edit-progress.md](./0018-same-device-plan-edit-progress.md) | 같은 기기 플랜 편집 뒤 진행을 확인 화면 없이 이어 감(0017 결정 3 일부) | Accepted (2026-10-02) |
| [0019-youtube-reference-preview-on-entry.md](./0019-youtube-reference-preview-on-entry.md) | 운동 상세 진입 시 YouTube 참고 플레이어 표시(D94 최초 로딩 일부 대체) | Accepted (2026-10-08) · 별도 버튼/숨김 일부 → [0020](./0020-youtube-reference-player-controls.md) |
| [0020-youtube-reference-player-controls.md](./0020-youtube-reference-player-controls.md) | YouTube 별도 닫기·열기 제거, 실패 재시도만 제공 | Accepted (2026-10-08) |
| [0021-exercise-detail-page.md](./0021-exercise-detail-page.md) | 운동 상세를 독립 페이지로 전환, 출발 화면 상태·스크롤 복원(D95) | Accepted (2026-10-08) · 광고 제외 → [0022](./0022-exercise-detail-banner.md) |
| [0022-exercise-detail-banner.md](./0022-exercise-detail-banner.md) | 운동 상세 페이지 설명 뒤 배너 1개(D96, 0021 일부 대체) | Accepted (2026-10-08) · 배치 → [0028](./0028-banner-fixed-placement.md) |
| [0023-ui-input-and-information-hierarchy.md](./0023-ui-input-and-information-hierarchy.md) | 세트 입력 유지·오늘만 일괄적용·정보 위계와 기능 보존(D98) | Accepted (2026-10-13) |
| [0024-plan-and-session-prototype-parity.md](./0024-plan-and-session-prototype-parity.md) | 예정일·줄 전체 진입 복원과 기록 머리의 주동근·짧은 문구(D99) | Accepted (2026-10-13) |
| [0025-generation-pipeline-p1.md](./0025-generation-pipeline-p1.md) | 생성 파이프라인 P1 — 코드 골격 + 슬롯 채우기 + 이유(D103). ADR-0016 compact 초안을 전환 시 부분 대체 | Accepted (2026-10-14) |
| [0026-exercise-media-on-r2.md](./0026-exercise-media-on-r2.md) | 운동 미디어를 Cloudflare R2 커스텀 도메인에서 제공(D107, D83·D97 번들 동봉 부분 대체) | Accepted (2026-10-18) · 빌드 원본 의존 부분은 0027로 대체 |
| [0027-external-exercise-media-sources.md](./0027-external-exercise-media-sources.md) | 제작 원본 Drive 보관·한글 라이브러리·원본 없는 일반 빌드(0026 빌드 원본 의존 부분 대체) | Accepted (2026-10-19) |
| [0028-banner-fixed-placement.md](./0028-banner-fixed-placement.md) | 배너 광고 고정 — 탭·기록 화면 하단 바 아래 · 하위 화면 위 sticky · 상세 머리 묶음(D109, D91·0022·0023 광고 배치 대체) | Accepted (2026-10-21) |
| [0029-plan-exercise-picker-page.md](./0029-plan-exercise-picker-page.md) | 주간 플랜 운동 추가·변경을 독립 페이지로 전환 · 문서 전체 스크롤·출발 상태 복원 | Accepted (2026-10-23) · 실기기 확인 완료·검수 중(기록) |
| [0030-four-week-prescription-history.md](./0030-four-week-prescription-history.md) | 최근 4주 운동별 최근 수행·지난주 미수행 시 자동 상승 보류(D22-6·D57 A10 일부 대체) | Accepted (2026-10-26) |
| 0031-reviewed-external-exercise-notes.md | 푸시 프레스·사이드 브리지의 외부 출처·사진 대조와 설명 해시 검사(D29 두 ID 일부 대체) | Accepted (2026-10-27) |

## 읽기 순서
1. [mvp-decision-log.md](./mvp-decision-log.md) — 제품의 큰 결정 한눈에.
2. `0001-` 이후 ADR — 개별 아키텍처 결정 상세.

## 링크
- 상위: ../00-START-HERE.md · 근거: ../research/05-scaffolding-research.md
