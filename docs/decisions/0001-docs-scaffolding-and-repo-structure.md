# ADR-0001: 문서 스캐폴딩 및 리포 구조 규약

- **Status:** Accepted — §5(타깃 코드 구조·모노레포 툴 미도입)는 [ADR-0014](./0014-per-project-harness-and-pnpm-workspace.md)로 대체
- **Date:** 2026-08-16
- **Deciders:** 사용자, Claude
- **근거 조사:** research/05-scaffolding-research.md

## Context

상세 스펙 문서화에 앞서 `docs/` 구조와 진입점 규약을 확정해야 한다. 제약·요구:
- 사용자 요구: **진입점을 `00-START-HERE.md`로, 각 폴더마다** 둔다.
- 문서는 사람과 **AI 에이전트 둘 다**가 탐색한다(이 제품은 AI 보조로 개발되며, LLM은 provider-비종속).
- 리포는 GitHub(git) 위에 있고, 향후 Flutter 앱 + 서버리스 백엔드 코드가 같은 리포에 들어온다.
- 이미 `docs/research/`(조사 5건), `docs/spec/01-mvp-decisions.md`(결정 로그)가 존재한다.

3개 영역(문서 아키텍처 / SDD·ADR / 리포 스캐폴딩)을 병렬 웹조사해 교차검증했고 결론이 수렴했다.

## Decision

### 1. 진입점 규약
- **모든 docs 폴더에 `00-START-HERE.md`를 진입점으로 둔다.** `00-` 접두사가 모든 파일 목록에서 최상단 정렬을 보장해 사람·AI가 즉시 진입점을 인식한다.
- 각 `00-START-HERE.md`는 **①목적 1문장 ②파일 매니페스트 표(파일명+1줄 설명) ③읽기 순서 ④상위/형제 링크 ⑤상태**를 담는다.
- 루트 리포에는 표준대로 `README.md`를 두고 `docs/00-START-HERE.md`로 링크한다(GitHub 자동 렌더용). SSG 도입 시 `_category_.json`의 `link` 또는 얇은 `README.md` shim으로 브리지한다.

### 2. `docs/` 택소노미 (목적 기반 상위, Diátaxis는 하위 콘텐츠에 적용)
```
docs/
├── 00-START-HERE.md        # 전체 문서 지도
├── product/                # WHAT & WHY (PRD, 비전)
├── architecture/           # HOW 시스템 (arc42-lite + C4 context/container, 데이터모델, LLM어댑터)
├── decisions/              # ADR (Nygard 포맷) + 결정 로그
├── specs/                  # 기능 스펙 (SDD)
│   └── features/NNN-name/  #   spec.md · design.md · tasks.md · contracts/
├── research/               # 조사·근거 (기존 유지)
└── guides/                 # how-to · 런북 (Diátaxis how-to)
```

### 3. 네이밍·정렬
- kebab-case 소문자, 2자리 숫자 접두사(`00-`=START-HERE)로 순서. ADR만 4자리(`0001-`).
- 접두사는 정렬용, **슬러그는 식별용 → 함부로 리네임 금지**(링크 깨짐). 번호 사이 여유를 둔다.
- 문서 간 **상대 Markdown 링크**. 1파일 1개념·1 Diátaxis 유형.

### 4. ADR 규약
- **Nygard 5섹션**(Title·Status·Context·Decision·Consequences), `docs/decisions/`에 `0001-` 4자리 넘버링. 수락 후 **불변**, 변경은 새 ADR로 supersede(양방향 링크). 상태: Proposed→Accepted→(Deprecated|Superseded).
- 기존 `spec/01-mvp-decisions.md`(D1–D11)를 `decisions/mvp-decision-log.md`로 **이관**(결정 로그). 대형 아키텍처 결정은 상세 스펙 단계에서 개별 ADR로 분화한다.

### 5. 타깃 코드 구조 (문서가 참조할 대상)
- 단일 리포: **`app/`**(Flutter, feature-first MVVM: `ui/`·`domain/`·`data/`) + **`backend/`**(TS 얇은 LLM 프록시/BFF, `src/llm/` 어댑터 모듈) + **`docs/`**. 모노레포 툴은 도입하지 않는다.
- **LLM 어댑터:** 자체 `LLMProvider` 인터페이스 뒤에 벤더 SDK 격리. **OpenAI-호환 어댑터 1개로 MiniMax+GPT** 커버 + Gemini 어댑터. TS는 Vercel AI SDK 후보. 어댑터별 회귀·평가 테스트 유지(무검증 스왑 정확도 하락 위험).

## Consequences

**긍정:**
- 사람·AI 모두 어느 폴더에서든 `00-START-HERE.md`로 방향을 잡는다(에이전트 친화 = `llms.txt` 철학과 정렬).
- 관심사 분리(product/architecture/decisions/specs)로 상세 스펙 작성이 각 폴더에 자연스럽게 안착.
- ADR 불변·안정 ID로 커밋·PR·AI가 결정을 인용 가능. 향후 Spec Kit `specs/NNN/`에 1:1 매핑되어 툴 도입이 매끄럽다.

**부정/비용:**
- `00-START-HERE.md`는 GitHub/SSG 자동 홈페이지가 아니라, 추후 SSG 도입 시 브리지(README shim/`_category_.json`)가 필요.
- 숫자 접두사 리넘버링이 링크를 깨뜨릴 수 있음 → 접두사는 정렬 전용, 슬러그 안정 유지로 완화.
- 결정 로그 이관으로 기존 `docs/spec/` 경로를 참조하던 링크(research 요약·메모리)를 갱신해야 함(본 변경에서 처리).

**후속:**
- 상세 스펙 단계: `product/01-prd.md`, `architecture/*`, `specs/features/001-weekly-plan-generation/*` 작성.
- 코드 착수 시: 루트 `AGENTS.md` + 얇은 `CLAUDE.md` + `architecture/constitution.md` 생성.
