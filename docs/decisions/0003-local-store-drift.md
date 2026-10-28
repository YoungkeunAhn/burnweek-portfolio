# ADR-0003: Flutter 로컬 저장소 — Drift (SQLite)

- **Status:** Accepted (조사 근거; 사용자 veto 가능 — 최종 요약에서 안내)
- **Date:** 2026-08-16
- **근거 조사:** Flutter 로컬 저장소 비교(2026). 관련: [architecture/02-data-model](../architecture/02-data-model.md)(로컬↔Drive), PRD §13 오픈이슈, 결정 D5(로컬 우선).

## Context
오프라인 우선 로컬 저장소 필요: 진행 중 세션 기록(세트: 렙·무게·통증), 체중, 현재 주간 플랜을 **로컬에 먼저** 저장하고 완료 시 Drive 동기화(003). 데이터는 **관계형**(session→exercise→set) + **날짜/주/운동 쿼리** + 일부 문서형(WeeklyPlan). 건강 데이터라 **암호화** 필요. 스키마는 진화(마이그레이션). 상태관리 Riverpod/Bloc. 후보: Drift·sqflite·Isar·Hive(hive_ce)·ObjectBox.

조사 요지:
- **유지보수(최우선 기준):** **Isar 사실상 미유지**(stable 3.1.0+1 2022 이후 없음, v4 beta 정체, main 커밋 ~2025 중반 이후 없음, 이슈 #1739 "dead"). Hive 원본 방치(→hive_ce). **Drift 활발**(2.34.x, 월간, Stream/PowerSync 스폰서). ObjectBox 회사 지원. sqflite 유지되나 저수준·느린 cadence.
- **관계형+쿼리:** Drift 타입안전 join·FK·날짜범위, ObjectBox 객체 관계, sqflite 수작업, Hive 관계/쿼리 약함.
- **reactive:** Drift/ObjectBox per-query `.watch()`, Hive per-box만, sqflite 없음.
- **암호화(건강):** Drift **SQLite3MultipleCiphers**(AES, 무료·1st-party, 2.32.0부터). ObjectBox 암호화 **불확실**(issue #221 open, 릴리스노트 부재). sqflite는 3rd-party fork.
- **문서+정규화 공존:** Drift TypeConverter/JSONB로 WeeklyPlan(문서) + 세션/세트(정규화) 동시.
- **마이그레이션:** Drift 단계별+테스트 도구 최강.

## Decision
Phase 1 로컬 저장소 = **Drift(SQLite)**. 세션/세트/BodyMetric은 정규화 테이블, WeeklyPlan(및 진행 중 세션 draft)은 **TypeConverter/JSON** 컬럼. UI 반응성은 `.watch()`→Riverpod `StreamProvider`. **SQLite3MultipleCiphers AES 암호화**(키는 `flutter_secure_storage`). 마이그레이션 테스트 유지. **Isar 배제**(미유지). 차점 ObjectBox(암호화·web 미지원으로 미채택).

로컬 = 앱의 작업 source of truth. **Drive에는 DB blob이 아니라 MD+JSON 아티팩트**를 쓴다(003, `drive.file` 가시 폴더 — appDataFolder 아님).

## Consequences
**긍정:** 유지보수 건전성 최상(bus-factor)·관계형+쿼리+reactive·무료 1st-party 암호화·문서/정규화 공존·최고 마이그레이션·Riverpod 정합.
**부정/리스크:** 단일 메인테이너(Simon Binder) 의존 — 스폰서십·정기 릴리스로 완화. 코드젠 빌드 스텝 필요.
**후속:** `app/`에 Drift 스키마(세션/세트/메트릭/플랜) 정의; 로컬 스키마는 [02-data-model](../architecture/02-data-model.md) 계약과 정합. PRD §13·02-data-model 오픈이슈 "로컬 저장소 기술" → 본 ADR로 해소.
