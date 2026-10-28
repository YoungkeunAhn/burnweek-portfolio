# 데이터 모델 & 저장 포맷 (Data Model & Storage)

- **Status:** Draft v2 (Codex 검증 반영 — LLM draft / 최종 plan 분리)
- **Date:** 2026-08-16
- **근거:** PRD FR-GEN/LOG/SYNC/ADJ/FB/SAFE, research/01, research/03, research/02. 결정 D5·D6·D11.
- **schema_version:** `1.0` — Phase 1 **고정 계약**(PRD FR-GEN-1 참조).

정의 대상: **(A) 개념 엔티티 + 레드플래그 택소노미**, **(B) 두 스키마 — LLM용 `DraftPlan`(수치 없음) / 최종 `WeeklyPlan v1`(코드 생성)**, **(B3) 실측 세션 스키마**, **(C) Drive 저장 포맷·조정 로그**. 로컬 저장소 기술은 **Drift(SQLite)로 결정**([ADR-0003](../decisions/0003-local-store-drift.md)); 저장 **포맷/스키마**도 여기서 고정(테이블↔JSON 컬럼 경계 세부만 잔여).

---

## A. 개념 엔티티 (계획 vs 실측 분리 — D5/D11)

```
UserProfile            프로필·온보딩(목표·경력·장비·부상·레드플래그)
ExerciseTemplate       운동 정의(근육군·장비·modality) — free-exercise-db
──── PLAN ────  DraftPlan(LLM, 수치 없음) ──코드 확장──▶ WeeklyPlan v1(최종, 수치 포함)
                WeeklyPlan → PlannedDay → PlannedExercise → PlannedSet  (target_*)
──── PERFORMED ──── WorkoutSession → SessionExercise → SetLog          (actual_*, completion)
Adjustment             사용자 수동 조정 기록(대체·목표 수정) — FR-ADJ
BodyMetric             체중·치수(선택)
```

**원칙:** ① target_*(처방)와 actual_*(실측) 필드 분리. ② 유산소는 별도 modality(근력 필드와 상호배타). ③ **모든 수치(세트 수·무게·볼륨·휴식·증량)와 안전 검증은 코드 소유(INV-1)** — LLM은 §B의 DraftPlan(운동 선택·구성)만 산출.

### UserProfile (온보딩 산출)
| 필드 | 타입 | 비고 |
|---|---|---|
| `user_id` | uuid | |
| `goals` | enum[] | **1–3개 다중 선택.** build_muscle/gain_strength/lose_fat/endurance/mobility/general_fitness. 동결된 Flutter 앱이 보내는 단수 `goal` 은 검증기가 `[goal]` 로 접는다 |
| `experience_level` | enum | `beginner`\|`novice_intermediate` |
| `days_per_week` | int | 2–6 |
| `available_days` | int[] (선택) | 운동할 수 있는 요일 0=월…6=일. 중복은 접고 오름차순. 개수 ≥ `days_per_week`(아니면 400). **없으면 7일 전부.** 근력 요일은 생성 때 코드가 이 안에서 고른다(D46·D56) |
| `focus_area` | enum (선택) | `lower`\|`upper`\|`balanced`(D55 ④). 세트 배분(중점 쪽 상한 · 반대쪽 MEV)과 프롬프트 종목 수. 없으면 `balanced`. 기본값은 기기의 성별로 클라이언트가 채운다 — 성별은 서버에 오지 않는다(D55 ③ 철회) |
| `session_len_min` | enum | 30/45/60/75/90 |
| `environment` | enum | full_gym/home_gym/minimal/bodyweight_only |
| `equipment[]` | string[] | free-exercise-db equipment enum |
| `cardio_pref` | enum | none/maintain_health/fat_loss/conditioning |
| `cardio_modalities[]` | string[] | canonical: cycling/rowing/elliptical/incline_walk/running/stairs (플랜 `cardio_detail.modality`와 동일 enum) |
| `injuries[]` | {region, note}[] | 부위 금기 |
| `red_flags` | {hard[], low_risk[]} | ↓ 택소노미 |
| `medical_disclaimer_consent` | {accepted_at, text_version} | FR-SAFE-1 최초 온보딩 동의 기록 |

### 레드플래그 택소노미 (FR-ON-4 / FR-SAFE-3·4 — 코드가 소유하는 고정 목록)
- **하드(hard) = 자동 생성 비가역 차단(우회 불가, FR-SAFE-3):** `pregnancy`, `cardiac_condition`, `recent_surgery`(최근 12주), `acute_injury`(급성/중대 부상), `chest_pain_on_exertion`.
- **저위험(low_risk) = 경고 + 부위 금기 반영 생성(FR-SAFE-4):** `mild_joint_discomfort`, `managed_hypertension`, `general_soreness`.
- **게이트:** 하드 플래그 판정은 **백엔드가 LLM 호출 이전에** 수행(§[01-overview §8](./01-overview.md) 생성 게이트). 하드=true면 LLM 호출 없이 차단 응답.

### ExerciseTemplate
`yuhonas/free-exercise-db`(퍼블릭도메인). `id, name, name_ko, primary_muscles[], secondary_muscles[], equipment, modality(strength|cardio|bodyweight), mechanic(compound|isolation), default_metric(reps|duration|distance), contraindication_tags[], is_custom, requires[]?, bodyweight_pool?, retagged_from?`. 근육 17-값 평면 taxonomy.
- `id`는 **소문자 slug 정본**(`/^[a-z0-9_]{1,64}$/`) — 업스트림 `3_4_Sit-Up` → `3_4_sit_up`. 플랜·로그·프롬프트가 같은 형식을 쓴다.
- `name_ko`는 시드 카탈로그에서 **필수**([D13](../decisions/mvp-decision-log.md): 873종 전수). `backend/src/data/exercise-labels.json`의 개별 교정 이름을 우선하고, 나머지는 용어 사전(`backend/scripts/name-ko-glossary.cjs`)으로 조합한다. 교정 원천의 `aliases`는 종목 ID별 통용명·이전 이름 검색용이며 ExerciseTemplate이나 저장 플랜의 새 필드가 아니다. 이름 교정은 ID·장비·근육·기록을 변경하지 않는다. 미등록 ID의 저장 이름은 그대로 표시한다.
- `is_custom` — 사용자 커스텀 운동 허용 여부는 **미결**이다. upstream 에 없는 기구를 앱이 넣은 종목만 `true` 다([D57](../decisions/mvp-decision-log.md#d57) A15 마이마운틴): 원천은 `backend/scripts/custom-exercises.json` 이고 빌드(`build-exercise-db.cjs` `mergeCustom`)가 병합한다. 이름은 사전 조합이 아니라 원천의 `name_ko` 이고, 동작 사진이 없으며, 설명 출처는 `miniapp/data/sources/notes.src.json` `custom` 의 URL 이다.
- `requires` — 필요한 도구(`pull_up_bar | dip_bars | bench | sturdy_chair | box_or_step | partner | wall | dumbbell | exercise_ball`). 없으면 도구가 필요 없다. `equipment:"body only"`는 외부 하중이 없다는 뜻이라 철봉 운동도 들어 있다. 원천은 `backend/scripts/catalog-overrides.json`(upstream)과 `custom-exercises.json`(커스텀)이고, 빌드가 enum 밖 값이면 멈춘다. `bodyweight_only` 프로필은 보유 도구(`equipment[]`)에 없는 `requires` 종목을 생성·편집 후보에서 뺀다([D102](../decisions/mvp-decision-log.md#d102) · 백로그 운동목록 02).
- `bodyweight_pool` — 맨몸 사용자를 위해 넣은 커스텀 종목(맨몸 당기기·서킷 동작). `full_gym` 생성 후보에는 넣지 않는다.
- `retagged_from` — upstream 태그를 고친 종목(`other`→`body only`, `stretching` 오분류)의 옛 `{equipment, category}`. `full_gym` 생성 후보는 옛 값으로 계산해 N1 이전 목록과 같게 둔다(그룹당 10개 컷이라 종목 하나만 늘어도 다른 종목이 밀려난다).

### BodyMetric (체중 — FR-LOG-4)
날짜별 체중 시계열(치수·체지방은 Phase 2). 선택 입력.
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BodyMetric v1",
  "type": "object", "additionalProperties": false,
  "required": ["schema_version","user_id","date","bodyweight_kg"],
  "properties": {
    "schema_version": { "const": "1.0" },
    "user_id": { "type": "string" },
    "date": { "type": "string", "format": "date" },
    "bodyweight_kg": { "type": "number", "exclusiveMinimum": 0 },
    "note": { "type": ["string","null"] }
  }
}
```
저장: Drive `Workout Data/body-metrics.json` = **`BodyMetricsFile v1`** = `{ "schema_version": "1.0", "entries": BodyMetric v1[] }`, **날짜당 1건(unique date, upsert)** — 앱이 date 유일성 검증. `summary.md`에 체중 추세 반영. 체중은 무게 시딩·유산소 칼로리 추정에도 참고 가능(선택).

### GenerationJob (비동기 생성 잡 — 백엔드 전용, ephemeral, [ADR-0011](../decisions/0011-async-plan-generation.md))
동기가 아닌 **비동기 생성**의 진행/결과를 담는 **일시적** 엔티티(Firestore, **짧은 TTL 자동삭제**, 권장 24h). 앱이 `ok` 플랜을 인출·로컬(Drift) 저장하면 TTL로 소멸 — **영구 사용자 이력 DB 아님**(NFR-PRIV-1 유지). Drive에 저장하지 않는다.
```json
{
  "job_id": "uuid", "user_id": "uuid",
  "status": "queued | running | ok | error",
  "created_at": "date-time", "expires_at": "Timestamp (TTL — 문자열이면 정책이 못 읽는다)",
  "fcm_token": "string (완료 푸시 대상)",
  "plan": { "…": "WeeklyPlan v1 — status=ok 일 때만" },
  "warnings": ["low_risk_flag:…"], "message": "string — error 사유",
  "account_version": "UUID — 토스 세션의 계정 버전(선택, 백엔드 내부)",
  "generation_reserved": "boolean — 무료/보상 예약이 있는 잡(선택, 백엔드 내부)"
}
```
`blocked_red_flag`는 잡을 만들지 않는 **접수 단계 동기 차단**이라 여기에 없다(ADR-0011). 상태 규약·엔드포인트는 생성 API 계약 참조.

### AccountLifecycle (미니앱 연결 확인값 — 백엔드 내부)

`account_lifecycle/{sha256("burnweek-account:v1:" + uid)}`에 `{version: UUID}`을 저장한다. 로그인 때 만들고 같은 연결에서는 유지한다. 원본 식별값·프로필·운동 기록은 담지 않는다. 세션과 생성 잡의 `account_version`이 이 버전과 다르면 저장을 거부한다. **사용자 삭제·토스 연결 해제 시 이 문서도 삭제**하며, 삭제 이력을 영구 보관하지 않는다. 재연결은 새 UUID를 발급한다. 사용자 정보 없는 `auth_control/login_revision`의 난수를 코드 교환 전후로 비교해, 삭제 전에 시작한 로그인 교환이 새 세션을 발급하지 못하게 한다. 로그인 응답의 `local_data_key`로 기기에 남은 이전 연결의 사본을 구분한다(계약 §0·§2.5).

### GenerationAccess (미니앱 무료 생성·광고 보상 — 백엔드 내부)

`generation_access/{uid}`에 `{free_week, credits, active, reward}`를 저장한다. `free_week`는 KST 기준 마지막 무료 사용 주(또는 null), `credits`는 미사용 광고 보상 수다. `active`는 `{job_id, source: free|reward, week, previous_free_week, expires_at: epochMs}` 또는 null이며 실패 시 복구에 쓴다. `reward`는 최근 시청 요청 `{id, expires_at: epochMs, claimed}` 또는 null이다. 광고 보상은 주간 초기화나 TTL로 삭제하지 않으며 계정 삭제(탈퇴·연결 해제) 시 전부 삭제한다. 앱 안 「모든 기록 초기화」(`DELETE /v1/plans`)는 계정 삭제가 아니라 이 문서를 남기고 `active`만 환불 없이 비운다(API §2.5). 클라이언트 직접 접근은 금지하고 검증된 uid의 API만 사용한다([ADR-0013](../decisions/0013-rewarded-plan-generation.md), API §1.1).

### SavedWeeklyPlan (미니앱 플랜 정본 — 백엔드, 영속, [D19](../decisions/mvp-decision-log.md))
**미니앱 전용이다.** 위 GenerationJob 과 달리 **TTL 이 없다** — 미니앱은 로컬 Drift 도 Drive 도 없어 서버가 정본이기 때문이다([D19](../decisions/mvp-decision-log.md): Firestore 정본과 로컬 복원 캐시를 병행). 즉 **미니앱 제품에서는 NFR-PRIV-1 의 "서버에 영구 이력 DB 없음"이 의도적으로 뒤집힌다**(Flutter 제품은 그대로 유지 — [constitution](constitution.md) 이 제품별로 가른다).

경로는 `weekly_plans/{uid}/weeks/{week_start_date}` — **주차별 1건**이라 지난 주가 남는다. 하위 컬렉션이라 소유권이 경로로 갈린다.
```json
{
  "user_id": "uid", "week_start_date": "YYYY-MM-DD (문서 id 와 같다)",
  "plan": { "…": "WeeklyPlan v1" }, "saved_at": "date-time"
}
```
미니앱의 진행 중 입력은 같은 문서의 `progress_drafts.{day_index}` 맵에 `{plan_id, plan_generated_at, revision, updated_at, closed, closed_reason?, progress}`로 저장한다([ADR-0017](../decisions/0017-miniapp-progress-cloud-drafts.md)). `progress`는 종목 ID별 입력 배열이며 완료 전 체크·문자열 무게/횟수·제외·통증·유산소 입력을 보존한다. 이는 실측 완료 기록 `sessions.{day_index}`와 **별개**다. 완료(`closed_reason: session_completed`)/플랜 교체·요일 합치기(`plan_replaced`) 때 `closed: true`와 revision 증가로 닫으며(요일 **교환**(`swap`)은 닫지 않고 `sessions.{day_index}`와 함께 운동을 따라 맞바꾸며 `plan_generated_at`만 새 플랜 시각으로 바꾼다 — [D79](../decisions/mvp-decision-log.md#d79)) 기존 입력은 자동 삭제하지 않는다. 일부 요일만 편집하면 영향받지 않은 열린 초안의 `plan_generated_at`만 새 플랜에 맞춰 갱신하고 revision과 입력은 유지한다. 교체된 플랜에서 새 입력이 시작되면 옛 초안을 `progress_draft_archives.{day_index}_{uuid}`에 옮기고 새 초안을 쓴다(같은 주차 문서·같은 트랜잭션). 공간 부족 등으로 보관할 수 없으면 새 쓰기를 거부한다. 클라이언트는 로컬 원본을 서버 확인 전 지우지 않는다.
워커가 잡을 `ok` 로 마칠 때 같은 트랜잭션에서 쓴다. 저장 실패 시 잡만 `ok`가 되는 부분 성공은 없다. 조회는 `GET /v1/plans/current`(문서 id 역순 1건 = 최신 주차)·`GET /v1/plans/{YYYY-MM-DD}`(그 주) — 계약 §2.1.

---

## B. 계획 스키마 — 2단계 (BLOCKER 수정: LLM draft ≠ 최종 plan)

> **파이프라인(INV-1 강제):** `DraftPlan`(LLM, 수치 없음) → **코드 확장 엔진**(볼륨 랜드마크·1RM·이중진행·유산소 배치·금기 제외·상한 적용으로 수치 계산) → `WeeklyPlan v1`(최종) → **코드 검증**. LLM에는 **DraftPlan 스키마만** 전달한다(무게·세트 수·휴식·증량을 LLM이 생성하지 않음).

### B1. DraftPlan (LLM 출력 — numeric-light)
LLM은 근력 운동 **선택·역할·순서**만 낸다. 수치(무게·세트 수·휴식·%1RM)와 유산소 처방은 코드가 만든다.

아래 JSON은 저장된 예전 드래프트와 골든 픽스처까지 받는 **호환성 검증 스키마**다. 새 LLM 요청에는 [ADR-0016](../decisions/0016-generation-timeout-and-compact-draft.md)의 compact projection을 사용한다: `name`·`coaching_cue`·`substitution_options`·`cardio_kind`는 빼고, `focus`는 빈 문자열로 제한하며, `session_type`은 `lift`, `kind`는 `strength`만 허용한다. 모델은 근력 세션만 내고 휴식일·유산소는 코드가 만든다. 이 값들은 확장 엔진이 쓰지 않거나 코드가 다시 만들기 때문에 최종 WeeklyPlan은 달라지지 않는다. 응답은 여전히 아래 전체 스키마와 최종 값 규칙을 모두 통과해야 저장된다.

**저장된 드래프트는 이 스키마의 상위집합이다**(계약 §2.2 「상위집합」 문단). 편집이 남기는 필드 — 항목의 `user_pick`·`sets_override`·`load_kg_override`, 요일의 `cardio_override`(`{"exercise_id": …, "target"?: {style, duration_min, distance_m?, incline_pct?, level?, segments?}}` 또는 `"none"`, 사용자가 그 날 유산소에 내린 결정 — [D57](../decisions/mvp-decision-log.md#d57). 옛 `{"modality": …}` 는 그 분류의 기본 id 로 읽는다) — 는 **아래 스키마에 일부러 없다**: 이 스키마가 프롬프트에 실리므로 넣으면 LLM 이 채울 통로가 된다(INV-1).
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DraftPlan (LLM output, numeric-light)",
  "type": "object", "additionalProperties": false,
  "required": ["schema_version","split_type","week"],
  "properties": {
    "schema_version": { "const": "1.0" },
    "split_type": { "type": "string", "enum": ["full_body","upper_lower","push_pull_legs","body_part_3","body_part_4","body_part_5"] },
    "week": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["day_index","session_type","focus","items"],
        "properties": {
          "day_index": { "type": "integer", "minimum": 0, "maximum": 6 },
          "session_type": { "type": "string", "enum": ["lift","lift_plus_cardio","cardio_only","rest"] },
          "focus": { "type": "string" },
          "items": {
            "type": "array",
            "items": {
              "type": "object", "additionalProperties": false,
              "required": ["kind"],
              "properties": {
                "kind": { "type": "string", "enum": ["strength","cardio"] },
                "exercise_id": { "type": "string", "description": "kind=strength 필수" },
                "name": { "type": "string" },
                "role": { "type": "string", "enum": ["primary","secondary","accessory"] },
                "order": { "type": "integer" },
                "rep_intent": { "type": "string", "enum": ["strength","hypertrophy","endurance"], "description": "범위 의도만 — 실제 렙/세트/무게는 코드가 결정" },
                "cardio_kind": {
                  "type": ["object","null"], "additionalProperties": false,
                  "description": "kind=cardio일 때. 지속시간/강도존은 코드가 상한 검증 후 확정",
                  "properties": {
                    "modality": { "type": "string", "enum": ["cycling","rowing","elliptical","incline_walk","running","stairs"] },
                    "style": { "type": "string", "enum": ["LISS","HIIT"] }
                  }
                },
                "substitution_options": { "type": "array", "items": { "type": "string" } },
                "coaching_cue": { "type": "string" }
              }
            }
          }
        }
      }
    }
  }
}
```
**코드가 DraftPlan에서도 검증:** 새 생성의 `kind=strength`는 `exercise_id` 존재·후보·금기 규칙을 확인하고, day_index 중복을 거부한다. 호환성 스키마는 과거의 `kind=cardio`도 읽지만 새 compact 요청은 생성하지 않는다.

### B1a. SlotDraft (P1 LLM 출력 — [ADR-0025](../decisions/0025-generation-pipeline-p1.md) · [D104](../decisions/mvp-decision-log.md#d104))
P1 경로(`GENERATION_PIPELINE=p1`)에서는 코드가 요일별 슬롯(움직임 패턴·순서·역할·렙 의도)과 슬롯마다 후보를 정하고(`slots.ts` `buildSkeleton`), LLM 은 슬롯마다 후보 하나와 한 줄 이유만 낸다. 코드가 이것을 위 DraftPlan 으로 바꾼다(`resolveSlotDraft`): 슬롯 후보 밖 id·같은 날 중복은 그 슬롯의 다음 후보로 바꾸고, `reason`·`week_note` 의 숫자는 지운다(INV-1). 변환된 드래프트의 항목에는 `reason`·`alternatives`, 루트에는 `week_note` 가 남는다 — 저장용이고(D103 ④ 「이유는 저장만」) 위 스키마에 일부러 없다(저장 드래프트는 상위집합 — B1 첫 문단).
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SlotDraft (P1 LLM output)",
  "type": "object",
  "additionalProperties": false,
  "required": ["slots"],
  "properties": {
    "slots": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["slot", "exercise_id", "reason"],
        "properties": {
          "slot": { "type": "string", "pattern": "^d[0-9]+s[0-9]+$" },
          "exercise_id": { "type": "string" },
          "reason": { "type": "string", "maxLength": 120, "description": "한 줄 이유. 숫자는 코드가 지운다(INV-1)" },
          "alternatives": { "type": "array", "maxItems": 2, "items": { "type": "string" } }
        }
      }
    },
    "week_note": { "type": "string", "maxLength": 200 }
  }
}
```

### B2. WeeklyPlan v1 (최종 — 코드가 생성·검증, 앱·Drive 저장)
**서킷(2026-10-14 · D102 · N7a — 추가만):** 운동의 선택 필드 `circuit {id, format, rounds, name, source_url}` 이 맨몸 서킷 묶음을 표시하고, **서킷 A 의 세트만** 렙 대신 `target_seconds` 를 가진다(운동 단위 `allOf` 조건 — 그 밖의 세트는 지금처럼 렙 두 칸이 필수이고 `target_seconds` 가 없다).
코드 확장 엔진이 수치를 채운다. **LLM은 이 스키마를 생성하지 않는다.**

2026-10-26 · [ADR-0030](../decisions/0030-four-week-prescription-history.md): 최근 4주 운동별 최근 수행을 참조한다. 지난주 미수행이면 `hold/history_gap`, 기준 날짜는 선택 필드 `source_date`다. 통증·실패 사유가 우선한다. 기존 문서는 필드 없이도 유효하다.
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WeeklyPlan v1 (final, code-produced)",
  "type": "object", "additionalProperties": false,
  "required": ["schema_version","plan_meta","week","progression","safety"],
  "properties": {
    "schema_version": { "const": "1.0" },
    "plan_meta": {
      "type": "object", "additionalProperties": false,
      "required": ["plan_id","user_id","week_start_date","week_number","goal","experience_level","split_type","days_per_week","disclaimer"],
      "properties": {
        "plan_id": { "type": "string" }, "user_id": { "type": "string" },
        "week_start_date": { "type": "string", "format": "date" },
        "week_number": { "type": "integer" },
        "goal": { "type": "string", "enum": ["build_muscle","gain_strength","lose_fat","endurance","mobility","general_fitness"] },
        "goals": { "type": "array", "minItems": 1, "maxItems": 3, "items": { "type": "string", "enum": ["build_muscle","gain_strength","lose_fat","endurance","mobility","general_fitness"] } },
        "experience_level": { "type": "string", "enum": ["beginner","novice_intermediate"] },
        "split_type": { "type": "string", "enum": ["full_body","upper_lower","push_pull_legs","body_part_3","body_part_4","body_part_5"] },
        "days_per_week": { "type": "integer", "minimum": 2, "maximum": 6 },
        "generated_at": { "type": "string", "format": "date-time" },
        "source": { "type": "string", "enum": ["ai","manual"] },
        "preset_summary": { "type": "string", "minLength": 1 },
        "disclaimer": { "type": "string", "minLength": 1 }
      }
    },
    "week": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["day_index","session_type","focus","exercises"],
        "properties": {
          "day_index": { "type": "integer", "minimum": 0, "maximum": 6 },
          "session_type": { "type": "string", "enum": ["lift","lift_plus_cardio","cardio_only","rest"] },
          "focus": { "type": "string" },
          "est_duration_min": { "type": "integer" },
          "warmup_note": { "type": "string" },
          "exercises": {
            "type": "array",
            "items": {
              "type": "object", "additionalProperties": false,
              "required": ["exercise_id","name","modality","order"],
              "allOf": [
                { "if": { "required": ["modality"], "properties": { "modality": { "const": "cardio" } } },
                  "then": { "required": ["cardio_detail"], "not": { "required": ["sets"] } },
                  "else": { "required": ["sets"], "not": { "required": ["cardio_detail"] } } },
                { "if": { "required": ["circuit"], "properties": { "circuit": { "properties": { "format": { "const": "A" } } } } },
                  "then": { "properties": { "sets": { "items": { "required": ["target_seconds"], "not": { "anyOf": [ { "required": ["target_reps_low"] }, { "required": ["target_reps_high"] } ] } } } } },
                  "else": { "properties": { "sets": { "items": { "required": ["target_reps_low","target_reps_high"], "not": { "required": ["target_seconds"] } } } } } }
              ],
              "properties": {
                "exercise_id": { "type": "string" }, "name": { "type": "string" },
                "modality": { "type": "string", "enum": ["strength","cardio","bodyweight"] },
                "primary_muscles": { "type": "array", "items": { "type": "string" } },
                "order": { "type": "integer" },
                "rest_seconds": { "type": "integer" },
                "progression_method": { "type": "string", "enum": ["double_progression","none"] },
                "progression_decision": {
                  "type": ["object","null"], "additionalProperties": false,
                  "description": "2주차+ : 직전 로그 기반 결정 근거 (FR-FB-1/3)",
                  "required": ["decision","reason_code"],
                  "properties": {
                    "decision": { "type": "string", "enum": ["increase","hold","decrease","substitute"] },
                    "reason_code": { "type": "string", "enum": ["hit_top_reps","reps_in_progress","missed_reps","pain_flag","first_week","user_edit","goal_no_overload","history_gap"] },
                    "from_load_kg": { "type": ["number","null"] }, "to_load_kg": { "type": ["number","null"] },
                    "source_date": { "type": "string", "format": "date" }
                  }
                },
                "substitution_options": { "type": "array", "items": { "type": "string" } },
                "coaching_cue": { "type": "string" },
                "circuit": {
                  "type": "object", "additionalProperties": false,
                  "description": "맨몸 서킷 묶음(D102). 같은 id 의 운동이 한 서킷이다. A=시간 연속 · B=횟수 라운드 · C=운동별 세트",
                  "required": ["id","format","rounds","name","source_url"],
                  "properties": {
                    "id": { "type": "string" },
                    "format": { "type": "string", "enum": ["A","B","C"] },
                    "rounds": { "type": "integer", "minimum": 1 },
                    "name": { "type": "string" },
                    "source_url": { "type": "string" }
                  }
                },
                "sets": {
                  "type": "array",
                  "items": {
                    "type": "object", "additionalProperties": false,
                    "required": ["set_number","set_kind"],
                    "properties": {
                      "set_number": { "type": "integer", "minimum": 1 },
                      "set_kind": { "type": "string", "enum": ["warmup","working"] },
                      "target_reps_low": { "type": "integer", "minimum": 1 },
                      "target_reps_high": { "type": "integer", "minimum": 1 },
                      "target_seconds": { "type": "integer", "minimum": 1 },
                      "target_load_kg": { "type": ["number","null"], "minimum": 0 },
                      "target_load_pct_1rm": { "type": ["number","null"] }
                    }
                  }
                },
                "cardio_detail": {
                  "type": "object", "additionalProperties": false,
                  "required": ["modality","style","duration_min","intensity_zone","placement"],
                  "properties": {
                    "modality": { "type": "string", "enum": ["cycling","rowing","elliptical","incline_walk","running","stairs"] },
                    "style": { "type": "string", "enum": ["LISS","HIIT"] },
                    "duration_min": { "type": "integer", "minimum": 1 },
                    "intensity_zone": { "type": "string" },
                    "placement": { "type": "string", "enum": ["after_lifting","separate_session","rest_day"] },
                    "distance_m": { "type": "number" }, "incline_pct": { "type": "number" }, "level": { "type": "integer" },
                    "segments": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["sec"],
                      "properties": { "label": { "type": "string" }, "sec": { "type": "integer" }, "speed_kmh": { "type": "number" }, "incline_pct": { "type": "number" }, "level": { "type": "integer" } } } }
                  }
                }
              }
            }
          }
        }
      }
    },
    "progression": {
      "type": "object", "additionalProperties": false,
      "required": ["method","load_increment_upper_kg","load_increment_lower_kg","advance_rule"],
      "properties": {
        "method": { "const": "double_progression" },
        "load_increment_upper_kg": { "type": "number" },
        "load_increment_lower_kg": { "type": "number" },
        "advance_rule": { "type": "string" }
      }
    },
    "safety": {
      "type": "object", "additionalProperties": false,
      "required": ["disclaimer","excluded_exercise_ids","weekly_volume_caps"],
      "properties": {
        "disclaimer": { "type": "string", "minLength": 1 },
        "excluded_exercise_ids": { "type": "array", "items": { "type": "string" } },
        "weekly_volume_caps": { "type": "object", "additionalProperties": { "type": "integer" } }
      }
    }
  }
}
```
**코드가 소유하는 추가 검증(스키마 밖):** `progression_decision.decision=hold` ⇒ `reason_code∈{reps_in_progress, goal_no_overload, history_gap}`(맨몸 운동은 `hit_top_reps`·`missed_reps` 도 — kg 대신 사다리로 진행하므로 칸을 못 옮기면 그대로 남는다) **및 `from_load_kg=to_load_kg`**, `=increase` ⇒ `hit_top_reps` **및 `to_load_kg>from_load_kg`(둘 다 non-null)**, `=decrease` ⇒ `pain_flag|missed_reps` **및 `to_load_kg<from_load_kg`**; `decision=substitute`면 `to_load_kg=null` **및 해당 운동의 워킹 세트 `target_load_kg=null`**; 부하 값은 음수 불가; **워킹 세트 `target_load_kg`는 결정의 `to_load_kg`와 일치**; **같은 날 `exercises[].order` 중복 없음**; 볼륨 상한 검증은 **플랜이 실은 `safety.weekly_volume_caps` 기준**(모든 상한 그룹이 양의 정수로 존재해야 함); `target_reps_low ≤ target_reps_high`; 세트 수 1–10; 근육군별 주간 세트 ≤ `weekly_volume_caps`; `excluded_exercise_ids ∩ week exercise_id = ∅`; cardio 세션은 무거운 하체일과 미겹침(FR-GEN-5); **`week.length ≤ 7` 및 `day_index` 중복 없음; lift/lift_plus_cardio 세션 수 = `days_per_week`**.

---

## B3. 실측 세션 스키마 (PerformedSession v1 — 정식 JSON Schema)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PerformedSession v1",
  "type": "object", "additionalProperties": false,
  "required": ["schema_version","session_id","plan_id","date","day_index","completion","exercises"],
  "properties": {
    "schema_version": { "const": "1.0" },
    "session_id": { "type": "string" }, "plan_id": { "type": "string" },
    "date": { "type": "string", "format": "date" },
    "day_index": { "type": "integer" },
    "completion": { "type": "string", "enum": ["completed","partial","skipped"] },
    "completion_pct": { "type": "number", "minimum": 0, "maximum": 1 },
    "session_note": { "type": ["string","null"] },
    "exercises": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["exercise_id","modality","sets"],
        "properties": {
          "exercise_id": { "type": "string" },
          "modality": { "type": "string", "enum": ["strength","cardio","bodyweight"] },
          "sets": {
            "type": "array",
            "items": {
              "type": "object", "additionalProperties": false,
              "required": ["set_number","set_kind"],
              "properties": {
                "set_number": {"type":"integer"},
                "set_kind": {"type":"string","enum":["warmup","working"],"default":"working"},
                "actual_reps": {"type":"integer","minimum":0},
                "actual_load_kg": {"type":"number","minimum":0,"maximum":500},
                "failed": {"type":"boolean"},
                "pain_flag": {"type":"boolean"},
                "actual_seconds": {"type":"integer","minimum":0},
                "cardio": { "type":"object", "additionalProperties": false,
                  "required": ["modality","duration_min"],
                  "properties": {
                    "modality": {"type":"string","enum":["cycling","rowing","elliptical","incline_walk","running","stairs"]}, "style": {"type":"string","enum":["LISS","HIIT"]},
                    "duration_min": {"type":"integer","minimum":0}, "duration_sec": {"type":"integer","minimum":0,"maximum":59}, "distance_m": {"type":["number","null"]},
                    "incline_pct": {"type":["number","null"]}, "level": {"type":["integer","null"]},
                    "segments": {"type":"array","items":{"type":"object","additionalProperties":false,"required":["sec"],
                      "properties":{"label":{"type":"string"},"sec":{"type":"integer"},"speed_kmh":{"type":"number"},"incline_pct":{"type":"number"},"level":{"type":"integer"}}}} } }
              },
              "oneOf": [
                { "required": ["actual_reps","actual_load_kg"], "not": { "anyOf": [ { "required": ["cardio"] }, { "required": ["actual_seconds"] } ] } },
                { "required": ["cardio"], "not": { "anyOf": [ { "required": ["actual_reps"] }, { "required": ["actual_load_kg"] }, { "required": ["actual_seconds"] } ] } },
                { "required": ["actual_seconds"], "not": { "anyOf": [ { "required": ["actual_reps"] }, { "required": ["actual_load_kg"] }, { "required": ["cardio"] } ] } }
              ]
            }
          }
        }
      }
    }
  }
}
```
`oneOf`로 근력/유산소 세트가 **상호배타**(강도 필드 혼재 방지).
`set_kind`는 **필수**다: 이중 진행 판정(S-GEN-10 "모든 워킹 세트")이 워밍업 세트를 워킹 세트로 오인하면 증량 결정이 틀린다. WeeklyPlan v1의 `sets[].set_kind`와 같은 enum이다.

---

## C. Drive 저장 포맷 (D6 확정 — MD + 주 단위 JSON)

> **왜 주 단위 JSON(JSONL 아님):** research/02의 JSONL 권고는 '단일 무한 증대 파일'의 append 비효율 때문. 주 단위 파일은 경계가 작아 그 우려가 없다. 외부 AI 가독은 Markdown(최광 커넥터 호환), 앱 재파싱은 JSON.

### 폴더 구조
```
Workout Data/                     ← 사용자 가시 전용 폴더 (drive.file)
├── summary.md                    ← 전체 이력 요약(외부 AI 진입점) — 픽스처: specs/features/003-drive-sync/contracts/
├── body-metrics.json             ← 체중 시계열 (BodyMetric v1[]) — FR-LOG-4
├── 2026-08/
│   ├── week-33.md                ← 주간 플랜+실적 요약(사람·AI용)
│   └── week-33.json              ← 계획+실측+조정 구조화(앱 재파싱용)
└── 2026-09/ …
```

### `week-NN.json` 래퍼 스키마 (버전 관계 명시)
```json
{
  "storage_version": "1.0",              // 래퍼 버전 (= 중첩 계약 1.0과 정렬)
  "week_meta": { "week_number": 33, "week_start_date": "2026-08-17" },
  "planned": { /* WeeklyPlan v1 (schema_version 1.0) */ },
  "performed": [ /* PerformedSession v1 [] */ ],
  "adjustments": [ /* Adjustment[] ↓ */ ]
}
```
`storage_version`과 중첩 `planned.schema_version`/`performed[].schema_version`은 모두 `1.0`로 정렬(상위 스토리지 버전과 내부 계약 버전이 함께 이동).

### Adjustment (FR-ADJ 아키텍처 홈)
사용자 수동 조정(대체·목표 수정)을 원본과 분리해 기록:
```json
{ "at": "2026-08-18T10:00:00Z", "exercise_id": "…",
  "type": "substitute|edit_target",
  "from": { "exercise_id?": "…", "target_load_kg?": 40 },
  "to":   { "exercise_id?": "…", "target_load_kg?": 42.5 },
  "reason": "equipment_busy|discomfort|user_pref" }
```
WeeklyPlan v1의 운동은 조정이 반영된 **현재 목표를 `sets[].target_*`에 in-place 보유**하고, **원본 대비 변경 이력은 `adjustments[]`가 소유**(FR-ADJ-2의 원본/변경 분리). *(별도 `current_target` 필드는 없음 — 현재값=`sets[].target_*`, 변경 전 값=`adjustments[].from`.)*

### `week-NN.md` / `summary.md`
`week-NN.md`: 면책 배너 + 요약(완료율·볼륨·유산소) + 요일별 목표/실측 표(고정 섹션 순서).
`summary.md`: 주별 1행 롤업(주차·기간·완료율·총 볼륨·유산소·주요 리프트 e1RM) + 최근 4주 추세 + **체중 추세**(body-metrics.json 기반). **검증 픽스처·질의셋은 specs/features/003-drive-sync/contracts/에 커밋**(FR-SYNC-4).

---

## 로컬 ↔ Drive
- 로컬=작업 저장소(오프라인·진행 중), 완료 시 Drive 쓰기(FR-LOG-2/FR-SYNC-1).
- 충돌: 쓰기 전 `modifiedTime`/`headRevisionId` 확인, last-write-wins(FR-SYNC-5). 멀티기기 병합 Phase 2.

## 오픈이슈
- 로컬 저장소: **Drift(SQLite)** 결정 ([ADR-0003](../decisions/0003-local-store-drift.md)).
- `sessions.jsonl` 마스터 추가 여부(비차단).
- `name_ko` 한글화 범위 → **[D13](../decisions/mvp-decision-log.md) 결정**(873종 전수). 커스텀 운동 허용 여부는 미결.
