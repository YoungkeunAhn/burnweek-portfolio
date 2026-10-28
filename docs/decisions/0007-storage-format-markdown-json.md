# ADR-0007: Drive 저장 포맷 = Markdown + 주 단위 JSON

- **Status:** Accepted
- **Date:** 2026-08-16
- **근거:** [D6](./mvp-decision-log.md), research/02 §3·§5, [02-data-model §C](../architecture/02-data-model.md). 관련 FR-SYNC-1·4.

## Context
저장 데이터를 **외부 AI가 잘 읽으면서** 앱도 정확히 재파싱해야 한다. 커넥터 실측: Markdown이 가장 넓게 안정적으로 읽히고(Claude/GPT/Gemini/MCP), JSON은 ChatGPT 커넥터의 문서화된 인덱싱 타입이 아님. JSONL은 '단일 무한 파일' append 효율용.

## Decision
운동 완료 시 **사람·외부 AI용 Markdown 요약**(week-NN.md, summary.md) + **앱 재파싱용 JSON**(week-NN.json 래퍼)을 함께 쓴다. 로그 원본은 **주(week) 단위 파일**(경계가 작아 append 비효율 없음)로 둔다. 전체 이력용 단일 `sessions.jsonl` 마스터는 선택적(비차단).

## Consequences
- **긍정:** 외부 AI 범용 가독(MD) + 앱 정확 재파싱(JSON) 동시 확보. 주 단위 파일로 JSONL의 append 우려 회피.
- **부정:** 이중 렌더(MD+JSON) 유지. 대용량 시 summary 재생성 비용(증분 전략은 오픈이슈).
- **배제:** JSON 단독(ChatGPT 커넥터 비호환), 단일 JSON 배열(append마다 전체 재작성), CSV/Sheets 단독(LLM 정확도·쓰기 쿼터).
