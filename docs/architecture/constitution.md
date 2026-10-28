# Constitution — 불변 원칙 (AI 가드레일)

- **Status:** Accepted
- **Date:** 2026-08-16
- 이 문서는 구현 내내 **위반 불가**한 원칙이다. AI 에이전트에 항상 주입한다. 근거: PRD §12 보호 불변식, 결정 D3·D5·D10·D11.
- **적용 범위 (2026-08-20 [D16](../decisions/mvp-decision-log.md) 이후 제품이 둘이다).** 아래 표가 어느 불변식이 어느 제품에 적용되는지를 정한다. **미니앱이 현재 진행선이고 Flutter 앱은 동결**이다 — 동결된 코드는 손대지 않으므로 Flutter 열은 그대로 유효하다.

| | 미니앱(진행) | Flutter 앱(동결) | 근거 |
|---|---|---|---|
| INV-1 · INV-3 · INV-4 | ✅ | ✅ | 백엔드 소유, 클라이언트와 무관 |
| **INV-2**(`drive.file`) | **적용 대상 없음** — 미니앱은 Drive를 쓰지 않는다 | ✅ | [D19](../decisions/mvp-decision-log.md) |
| **INV-5**(로컬 우선) | **재정의: 서버 정본(Firestore) 우선.** 계획/실측 분리·`adjustments[]` 소유는 그대로 | ✅ 원문대로 | [D19](../decisions/mvp-decision-log.md) |
| **INV-6**(안전 표시) | **절반 적용 + 자리 재정의** — 의료 면책 전문은 유지하되 **화면마다가 아니라 앱에 한 벌**(설정 최하단), **하드 레드플래그 차단은 미적용**(문진을 파기했다) | ✅ 원문대로 | [D18](../decisions/mvp-decision-log.md) · [D40](../decisions/mvp-decision-log.md) |

## 절대 불변식 (INV)
1. **INV-1 — 수치·안전은 코드 소유.** LLM은 운동 선택·구성(`DraftPlan`, 수치 없음)만 생성한다. 세트 수·무게·%1RM·휴식·증량·볼륨·금기·상한은 **코드**가 계산·검증해 `WeeklyPlan v1`로 확장한다. LLM 출력에서 수치를 받지 않는다.
2. **INV-2 — `drive.file` 고정.** Google Drive 접근은 `drive.file` 스코프만. `drive`/`drive.readonly` 요청 금지.
3. **INV-3 — LLM 키는 백엔드에만.** 클라이언트(앱)에 LLM 키 저장/번들 금지. 백엔드가 주입.
4. **INV-4 — provider-비종속 어댑터.** LLM은 `LLMProvider` 인터페이스로만 호출. 벤더 SDK는 어댑터 내부에만.
5. **INV-5 — 로컬 우선·계획/실측 분리.** 기록은 로컬(Drift) 먼저, 완료 시 Drive 쓰기. `target_*`(처방)와 `actual_*`(실측)를 섞지 않는다. 사용자 조정 이력은 `adjustments[]`가 소유.
6. **INV-6 — 안전 표시.** 모든 플랜에 의료 면책 + 통증 시 중단 안내. 하드 레드플래그는 생성 **비가역 차단**(우회 불가).

## 구현 원칙
- **스펙 주도:** 기능 구현 전 `docs/specs/features/NNN-*/`의 spec→design→contracts를 따른다. 계약(스키마·enum)을 임의 변경하지 않는다 — 변경 시 계약 문서·[02-data-model](./02-data-model.md) 먼저 갱신.
- **결정 불변:** 확정 ADR은 불변. 변경은 새 ADR로 supersede(양방향 링크).
- **교차검증:** 스펙/스키마 변경은 Codex 교차검증 + `jsonschema` 인스턴스 검증으로 확인.
- **소유권:** 각 FR/INV는 한 기능이 소유(PRD §12 매트릭스), 나머지는 준수(참조).
- **프라이버시:** 의료·통증 원문 로깅 금지. 나머지는 제품별로 갈린다 — **Flutter**: 데이터 원본=사용자 Drive, 백엔드에 영구 사용자 이력 DB 없음. **미니앱**: 원본이 백엔드(Firestore)이므로 이 문장이 성립하지 않는다 — 대체 조항은 **NFR-PRIV-2**(보관 범위·보존 기간·삭제 의무)이며 [D19](../decisions/mvp-decision-log.md)·[D22-6](../decisions/mvp-decision-log.md) 이 근거다.
