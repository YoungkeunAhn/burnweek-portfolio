# ADR-0006: provider-비종속 LLM 어댑터 + LLM/코드 책임 분리

- **Status:** Accepted
- **Date:** 2026-08-16
- **근거:** [D10·D11](./mvp-decision-log.md), research/03 §4, [03-llm-adapter](../architecture/03-llm-adapter.md). 관련 INV-1·4.

## Context
LLM provider가 열려 있고(테스트 MiniMax, 후보 Gemini/GPT, 향후 오픈모델) 교체 가능해야 한다. 또한 provider의 구조화출력은 값 범위(min/max)를 보장하지 못한다.

## Decision
LLM 접근을 **자체 `LLMProvider` 인터페이스(어댑터)** 뒤에 격리하고, provider는 설정으로 교체한다. **LLM은 `DraftPlan`(운동 선택·구성, 수치 없음)** 만 생성하고, **모든 수치·안전 검증은 코드**가 소유한다(확장 엔진 + 규칙엔진). MiniMax=OpenAI 호환이므로 OpenAI-호환 어댑터 1개로 MiniMax+GPT 커버 + Gemini 어댑터.

## Consequences
- **긍정:** provider 교체가 코드 변경 없이 설정으로 가능(오픈모델 이전 대비). 안전·정확성이 provider 품질과 무관(코드 소유). 어댑터 2개로 최소.
- **부정:** 어댑터별 회귀·평가 테스트 유지 필요(무검증 스왑 정확도 하락 위험). 코드 확장 엔진 구현 부담.
- **배제:** provider 직접 호출(종속), LLM이 최종 수치 생성(INV-1 위반·안전 불가).
