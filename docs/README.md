# 문서 읽는 순서

이 폴더는 운영 저장소의 결정 기록 일부를 옮긴 것입니다. 처음 보신다면 아래 순서를 권합니다.

1. [트러블슈팅](troubleshooting.md) — 운영 중 겪은 장애 5건의 원인과 해결
2. 핵심 결정
   - [ADR-0011 비동기 생성](decisions/0011-async-plan-generation.md) — 접수와 생성을 큐로 나눈 이유
   - [ADR-0016 생성 시간 제한](decisions/0016-generation-timeout-and-compact-draft.md) — 추론을 끄지 않고 시간을 늘린 근거(A/B 수치)
   - [ADR-0025 생성 파이프라인 P1](decisions/0025-generation-pipeline-p1.md) — 코드 골격 + 슬롯 선택, 헬스장만 적용한 이유
   - [ADR-0013 보상형 생성 한도](decisions/0013-rewarded-plan-generation.md) — 한도 예약·정산·환불 트랜잭션
   - [ADR-0006 공급자 비종속 LLM 어댑터](decisions/0006-provider-agnostic-llm-adapter.md)
   - [ADR-0008 런타임 Firebase](decisions/0008-backend-runtime-firebase.md) — 조사 추천안을 뒤집은 결정과 비용 정정
3. 데이터와 어댑터
   - [데이터 모델](architecture/02-data-model.md) — DraftPlan·WeeklyPlan 스키마 원본
   - [LLM 어댑터](architecture/03-llm-adapter.md)

## 함께 알아 둘 것

- `decisions/`에는 ADR 30건 전체와 [결정 로그](decisions/mvp-decision-log.md)(D1~)가 있습니다. 미니앱 화면·디자인에 관한 ADR도 섞여 있습니다.
- [`architecture/01-overview.md`](architecture/01-overview.md)와 [`constitution.md`](architecture/constitution.md)는 토스 미니앱 이전, Flutter 앱 시절의 초기 설계입니다(문서 첫머리에 동결 표시). 지금 구조는 저장소 [README](../README.md)의 구조도를 보세요.
- 문서 안에서 공개본에 없는 문서(제품 요구사항, 작업 계획, 조사 메모 등)를 가리키던 링크는 일반 텍스트로 바꿔 두었습니다.
