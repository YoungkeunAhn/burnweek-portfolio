# ADR-0026: 운동 미디어는 앱 번들이 아니라 Cloudflare R2 에서 받는다

## Status

Accepted (2026-10-18, [D107](./mvp-decision-log.md#d107)). 사용자가 비용 비교(Firebase Storage·Hosting·R2) 뒤 R2 를 고르고, 도메인 `damkolab.com` 을 직접 등록했다.

## Context

운동 미디어(MP4 435 · WebP 1,305)는 [D83](./mvp-decision-log.md#d83)부터 `public/exercise-media/human-v2/` 로 복사돼 `.ait` 에 실렸다. [D97](./mvp-decision-log.md#d97) 시점 합계 99,045,191 bytes 로 `.ait` 한도 100MB 에 닿았고, 묶음이 늘 때마다 리포와 번들이 함께 커진다.

비용 비교(2026-10 공식 요금표): Firebase Storage 는 서울 리전에 무료분이 없고 전송이 $0.12/GB, Hosting 은 $0.15/GB, R2 는 전송이 무료다. 도메인(연 약 $10.5)을 더해도 월 활성 사용자 약 100명부터 R2 가 싸다.

## Decision

- 앱은 미디어를 `https://burnweek-media.damkolab.com/human-v2/<운동 ID>/<키>-<해시12>.<확장자>` 에서 받는다. R2 버킷은 `burnweek-media`, 공개는 커스텀 도메인으로만 한다(`r2.dev` 끔).
- 모든 객체에 `Cache-Control: public, max-age=31536000, immutable` 을 붙인다. 파일명의 콘텐츠 해시가 바뀌면 주소가 바뀌므로 덮어쓰기로 내용이 달라지지 않는다.
- `gen-exercise-media.mjs` 는 manifest·해시 검사를 그대로 하고 `exercise-media.g.ts` 만 쓴다. `public/exercise-media` 가 다시 생기면 `--check`(build)가 실패한다.
- 원격 동일성은 `--check-remote` 가 본다 — 모든 주소를 HEAD 해 ETag(R2 단일 PUT = MD5)를 manifest 바이트의 MD5 와 맞춘다. `--upload` 는 없거나 다른 객체만 `wrangler r2 object put` 으로 올린다(멱등). 자격증명은 개발자 PC 의 wrangler 로그인이며 리포·`.env` 에 두지 않는다.
- 도메인 `damkolab.com` 은 다른 앱과 공용이다. 앱마다 1단계 서브도메인(`<앱>-media.damkolab.com` 등)을 쓴다 — Cloudflare 무료 인증서가 `*.damkolab.com` 까지만 덮는다.

## Supersedes

- [D83](./mvp-decision-log.md#d83) 「MP4·WebP만 앱 `public/exercise-media/human-v2/`로 복사한다 … 번들에 포함」과 [D97](./mvp-decision-log.md#d97) 의 바이트 합계·`.ait` 한도 문장. 이후 D84~D97 의 「번들」 표현은 원격 제공으로 읽는다.
- 유지: 435종 범위, 재생 규칙(수동 시작·무음·인라인·metadata 반복/fps/길이·숨김 정지·실패 시 시작 자세), manifest·자산 해시 검사, 전문 검수 상태.

## Consequences

- `.ait` 에서 약 99MB 가 빠진다. 새 묶음은 업로드 후 `--check-remote` 를 통과해야 앱에 연결할 수 있다.
- **대가:** 네트워크가 없으면 영상·정지 이미지가 뜨지 않는다. 기존 실패 문구와 근육 도해·운동 설명은 그대로 보인다. 전송 비용과 Cloudflare 계정이 새로 생긴다.
- git 이력에 들어간 미디어(약 1GB 팩)는 이 결정으로 줄지 않는다.

## Validation

`node gen-exercise-media.mjs --check` · `--check-remote` · `pnpm --filter miniapp check` · `pnpm --filter miniapp check:exercise-media`(원격 재생 435종 × 360/390) · aside 로 운동 상세 재생 확인.
