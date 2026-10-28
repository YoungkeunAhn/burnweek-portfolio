# ADR-0014: 프로젝트별 하네스 + pnpm 워크스페이스

> **상태:** Accepted (사용자 지시, 2026-09-10)
> **대체 범위:** [ADR-0001](./0001-docs-scaffolding-and-repo-structure.md) §5 "모노레포 툴은 도입하지 않는다"를 대체한다. §1–4(문서 규약)는 그대로다.

## Context — 기존 구조의 단점

- **컨텍스트 오염.** 루트 `AGENTS.md` 하나가 backend·app·miniapp을 다 설명했다. 미니앱 작업에도 동결된 Flutter·Drive·Riverpod 전제가 매 세션 절반 분량으로 들어갔다. 지시가 많을수록 준수율이 떨어지고 다른 프로젝트 관례를 섞어 쓰는 실수가 생긴다.
- **활성 라인에 하네스가 없었다.** `miniapp/`에는 에이전트용 규칙 파일이 없고 README가 대신했다. README는 사람용이라 "알아둘 것"과 "돌려보기"가 섞여 있고, 에이전트가 항상 읽는다는 보장도 없다.
- **도구별로 읽는 파일이 달랐다.** Claude Code는 `CLAUDE.md`만, Codex·Cursor는 `AGENTS.md`만 읽는다. `backend/AGENTS.md`는 Claude Code에서 한 번도 로드되지 않았고, 그래서 낡아도(expand.ts 스텁 표기) 드러나지 않았다.
- **규칙이 산문이었다.** "문서 편집했으면 `links.py`를 돌려라"는 에이전트가 잊으면 끝이다. 강제는 git pre-commit뿐이라 커밋 시점에야 잡혔다.
- **패키지 경계가 없었다.** backend와 miniapp이 각자 lockfile을 가진 별개 npm 프로젝트인데 미니앱이 `../backend/src`를 상대경로로 import한다. 의존 관계가 어디에도 선언돼 있지 않아 "backend를 고치면 miniapp 검증도 돌려야 한다"를 사람이 기억해야 했다. 루트에서 한 번에 검사할 방법도 없었다.
- **루트가 어수선했다.** 인증서 키, 벤더 문서 스크랩, 잘못된 HOME 캐시, 정체 불명 폴더가 최상단에 있었다. gitignore로 가려졌을 뿐 `ls` 하면 다 보인다.

## Decision

1. **프로젝트별 `AGENTS.md`가 정본, `CLAUDE.md`는 `@AGENTS.md` 한 줄.** `backend/`·`miniapp/`·`app/`(동결 표시 3줄)에 둔다. Claude Code는 하위 폴더 `CLAUDE.md`를 그 폴더 파일을 읽을 때 지연 로드하고, Codex·Cursor는 중첩 `AGENTS.md`를 네이티브로 읽어 가까운 파일이 우선한다. Windows라 심링크 대신 `@` import를 쓴다.
2. **루트 `AGENTS.md`는 50줄 이하 포인터.** 제품 한 줄, 불변식 링크, 워크스페이스 지도, 게이트 명령만. 프로젝트 상세는 각 폴더로 내린다.
3. **규칙을 메커니즘으로.** `.claude/settings.json`에 훅: `.md` 편집 직후 `links.py`·`trace.py --orphans`·`backlog.py` 자동 실행(PostToolUse), `.env`·`*.key`·`*.pem` 편집 차단(PreToolUse). git pre-commit/pre-push는 안전망으로 유지. 경로 조건부 규칙은 `.claude/rules/*.md`의 `paths:`로 그 파일을 만질 때만 로드.
4. **pnpm 워크스페이스.** `pnpm-workspace.yaml`에 `backend`·`miniapp`. `app/`(Flutter)·`tools/`(Python)는 제외. 루트 `package.json`에서 `pnpm -r run typecheck|test|check`. **backend에 `workspace:` 의존을 두지 않는다** — Firebase 배포는 `backend/` 폴더만 올리므로 그 제약 아래서 배포가 그대로 유지된다. 공유 코드를 별도 패키지로 뺄지는 필요가 생길 때 결정한다.
5. **루트 정리.** 비자산(벤더 스크랩·오작동 캐시)은 삭제, 인증서는 `backend/secrets/`(gitignore)로 이동.

## Consequences — 제안 구조의 장점

- **프로젝트별 격리.** 각 폴더의 규칙은 그 폴더 파일을 만질 때만 로드된다. 미니앱 세션은 미니앱 규칙만 본다.
- **한 파일로 세 도구 공유.** 갱신할 파일이 하나라 낡을 확률이 줄고, 낡으면 세 도구가 같이 틀려 빨리 드러난다.
- **규칙이 메커니즘이 된다.** 에이전트가 기억하든 말든 결과가 같다. 피드백이 커밋 시점에서 편집 직후로 앞당겨진다.
- **필요할 때만 로드.** 런북·경로 조건부 규칙은 평소 컨텍스트를 차지하지 않는다.
- **의존 관계가 선언된다.** lockfile 하나, 루트에서 한 번에 검사. 나중에 공유 패키지를 뺄 때도 `workspace:` 한 줄.
- **동결이 명시된다.** `app/AGENTS.md` 세 줄이 폴더 진입 시점에 "손대지 말 것"을 말한다.

**비용:**
- npm 참조 교체(훅·문서 약 22곳)와 lockfile 재생성.
- backend `workspace:` 금지 제약을 `backend/AGENTS.md`에 적어 유지해야 한다. 재현 가능한 배포 잠금이 필요해지면 `pnpm deploy --filter backend` 또는 isolate 도구를 그때 붙인다.
- 훅 실행 시간(문서 게이트 실측 ≤20s). 느리면 pre-commit으로 되돌린다.

## 근거

- [Claude Code — memory / CLAUDE.md](https://code.claude.com/docs/en/memory.md) · [large codebases](https://code.claude.com/docs/en/large-codebases.md) · [hooks](https://code.claude.com/docs/en/hooks.md) · [skills](https://code.claude.com/docs/en/skills.md)
- [AGENTS.md spec](https://agents.md/) · [Codex AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) · [Cursor rules & nested AGENTS.md](https://cursor.com/docs/context/rules)
- [Harness engineering best practices 2026](https://nyosegawa.com/en/posts/harness-engineering-best-practices-2026/)
- [Firebase Functions + pnpm workspaces](https://github.com/firebase/firebase-tools/issues/5911)
