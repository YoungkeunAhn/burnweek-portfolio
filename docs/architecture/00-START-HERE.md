# 📍 START HERE — architecture/

> **목적:** 시스템이 **어떻게** 동작하는가. arc42-lite 섹션 + C4(Context/Container) 다이어그램 + 데이터 모델 + LLM 어댑터. 개별 결정 "왜"는 [../decisions/](../decisions/00-START-HERE.md).

## 파일 매니페스트

| 파일 | 내용 | 상태 |
|---|---|---|
| [01-overview.md](./01-overview.md) | 시스템 컨텍스트/컨테이너(C4), v1 데이터 흐름, 생성 게이트 | ✅ 승인됨 |
| [02-data-model.md](./02-data-model.md) | **DraftPlan/WeeklyPlan v1 분리**, PerformedSession v1, 미니앱 연결 버전과 삭제, Adjustment, 레드플래그 택소노미, Drive 포맷 | ✅ 승인됨(스키마 검증) |
| [03-llm-adapter.md](./03-llm-adapter.md) | provider-비종속 `generateDraft`, OpenAI-호환(MiniMax+GPT)·Gemini, 신뢰성 전략 | ✅ 승인됨 |
| [constitution.md](./constitution.md) | 불변 원칙(INV-1~6) — AI 에이전트 가드레일 | ✅ 작성됨 |
| `diagrams/` | C4 다이어그램 소스 | ⏭ |

## 타깃 코드 구조 (요약 — 상세는 [ADR-0001](../decisions/0001-docs-scaffolding-and-repo-structure.md))
```
repo/
├── app/       # Flutter (feature-first MVVM: ui/ · domain/ · data/{repositories,services,model})
├── backend/   # TS 얇은 LLM 프록시(BFF): src/{routes,services,llm/,middleware,config}
└── docs/
```
- **LLM:** `src/llm/`에 `LLMProvider` 인터페이스 + `providers/openai-compatible.ts`(MiniMax+GPT)·`gemini.ts`. Vercel AI SDK 후보.
- **백엔드:** 앱은 LLM 키 미보유, 서버가 인증·키주입·레이트리밋. **Firebase Cloud Functions Gen2**([ADR-0008](../decisions/0008-backend-runtime-firebase.md)), 비밀키는 `defineSecret`(Secret Manager).

> 미니앱 생성 사용 기회·보상 저장은 [ADR-0013](../decisions/0013-rewarded-plan-generation.md)과 [데이터 모델](02-data-model.md)의 GenerationAccess를 따른다.

## v1 데이터 흐름 (요약) — **제품이 둘이다**

- **미니앱(진행선, [D16](../decisions/mvp-decision-log.md)·[D19](../decisions/mvp-decision-log.md)):** 온보딩 → 백엔드 접수(202 queued) → 워커[LLM 운동선택 + 코드 수치·안전] → **클라이언트 폴링**(토스가 알림을 소유해 FCM 미사용) → **Firestore 정본** → 사용자가 원할 때 주간 `.md`/`.json` **내려받기**.
- **Flutter 앱(⏸ 동결):** 위와 같되 FCM 푸시 → 로컬(Drift) 기록 → **완료 시 Drive 쓰기**(`drive.file`, Markdown+JSON) → 외부 AI에 Drive 연결.

상세: [../decisions/mvp-decision-log.md](../decisions/mvp-decision-log.md) §확정된 v1 데이터 흐름.

## 링크
- 상위: ../00-START-HERE.md · 근거: ../research/02-google-drive-as-database.md, ../research/05-scaffolding-research.md
