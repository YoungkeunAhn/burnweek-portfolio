/**
 * 토스 로그인 서버측 흐름. 실제 토스 API 대신 **자체 CA 로 세운 mTLS 서버**에
 * 붙여 왕복을 태운다 — 클라이언트 인증서가 실제로 나가는지까지 확인한다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  exchangeCode,
  fetchUserKey,
  basicAuthOk,
  withdrawUid,
  loginWithToss,
  mintSession,
  sendTossPush,
  verifySession,
  SESSION_TTL_SEC,
  type TossConfig,
} from "../src/auth/toss";

const SECRET = "test-session-secret";
const NOW = 1_760_000_000_000;

describe("세션 토큰", () => {
  it("발급한 토큰은 같은 uid 로 되돌아온다", () => {
    const t = mintSession("toss:12345", SECRET, NOW);
    expect(verifySession(t, SECRET, NOW)).toBe("toss:12345");
  });

  it("변조하면 거부한다", () => {
    const t = mintSession("toss:12345", SECRET, NOW);
    const [payload, sig] = t.split(".");
    // 페이로드를 다른 uid 로 바꿔치기 — 서명이 안 맞아야 한다.
    const forged = `${Buffer.from("toss:99999." + (NOW / 1000 + 3600)).toString("base64url")}.${sig}`;
    expect(verifySession(forged, SECRET, NOW)).toBeNull();
    expect(verifySession(`${payload}.${"A".repeat(43)}`, SECRET, NOW)).toBeNull();
  });

  it("다른 키로 서명된 토큰은 거부한다", () => {
    const t = mintSession("toss:12345", "other-secret", NOW);
    expect(verifySession(t, SECRET, NOW)).toBeNull();
  });

  it("만료되면 거부한다", () => {
    const t = mintSession("toss:12345", SECRET, NOW);
    expect(verifySession(t, SECRET, NOW + SESSION_TTL_SEC * 1000 - 1000)).toBe("toss:12345");
    expect(verifySession(t, SECRET, NOW + SESSION_TTL_SEC * 1000 + 1000)).toBeNull();
  });

  it("형식이 깨진 값은 던지지 않고 null 을 준다", () => {
    for (const bad of ["", ".", "abc", "a.b.c.d", "토큰"]) {
      expect(verifySession(bad, SECRET, NOW)).toBeNull();
    }
  });
});

describe("mTLS 코드 교환 (자체 CA)", () => {
  let server: Server;
  let cfg: TossConfig;
  let seenClientCN: string | undefined;
  let lastBody = "";

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "toss-mtls-"));
    const f = (n: string) => path.join(dir, n);
    const ssl = (args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });

    ssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f("ca.key"), "-out", f("ca.crt"), "-days", "1", "-subj", "/CN=test-ca"]);
    ssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", f("s.key"), "-out", f("s.csr"), "-subj", "/CN=localhost"]);
    writeFileSync(f("san.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    ssl(["x509", "-req", "-in", f("s.csr"), "-CA", f("ca.crt"), "-CAkey", f("ca.key"), "-CAcreateserial", "-out", f("s.crt"), "-days", "1", "-extfile", f("san.cnf")]);
    ssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", f("c.key"), "-out", f("c.csr"), "-subj", "/CN=burnweek-partner"]);
    ssl(["x509", "-req", "-in", f("c.csr"), "-CA", f("ca.crt"), "-CAkey", f("ca.key"), "-CAcreateserial", "-out", f("c.crt"), "-days", "1"]);

    const ca = readFileSync(f("ca.crt"), "utf8");
    server = createServer(
      { key: readFileSync(f("s.key")), cert: readFileSync(f("s.crt")), ca, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        seenClientCN = req.socket.getPeerCertificate()?.subject?.CN;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          lastBody = body;
          res.writeHead(200, { "content-type": "application/json" });
          if (body.includes("hang-template")) return; // 응답하지 않는다 — 무응답 상한(사용률 N4)
          if (req.url?.endsWith("/send-message")) {
            res.end(JSON.stringify({ resultType: "SUCCESS", success: { sentPushCount: 1 } }));
            return;
          }
          if (req.url?.endsWith("/generate-token")) {
            if (JSON.parse(body || "{}").authorizationCode === "expired") {
              // 서버 API 공통 규격의 실패 형태.
              res.end(JSON.stringify({ resultType: "FAIL", error: { errorCode: "INVALID_PARAMETER", reason: "요청에 실패했습니다." } }));
              return;
            }
            res.end(JSON.stringify({ resultType: "SUCCESS", success: { tokenType: "Bearer", accessToken: "at-1", expiresIn: "3599" } }));
          } else if (req.url?.endsWith("/login-me")) {
            expect(req.headers.authorization).toBe("Bearer at-1");
            res.end(JSON.stringify({ resultType: "SUCCESS", success: { userKey: 987654, scope: "s" } }));
          } else {
            res.end(JSON.stringify({ resultType: "FAIL", error: { code: "NOT_FOUND" } }));
          }
        });
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    cfg = {
      clientCert: readFileSync(f("c.crt"), "utf8"),
      clientKey: readFileSync(f("c.key"), "utf8"),
      sessionSecret: SECRET,
      apiOrigin: { host: "127.0.0.1", port, ca },
    };
  });

  afterAll(() => server?.close());

  it("클라이언트 인증서를 제시하고 accessToken 을 받는다", async () => {
    const token = await exchangeCode(cfg, "code-abc", "DEFAULT");
    expect(token).toBe("at-1");
    expect(seenClientCN).toBe("burnweek-partner"); // 인증서가 실제로 나갔다
    expect(JSON.parse(lastBody)).toEqual({ authorizationCode: "code-abc", referrer: "DEFAULT" });
  });

  it("sendTossPush 는 템플릿 코드와 변수를 그대로 싣는다 (D90 · 계약 §2.8)", async () => {
    expect(await sendTossPush(cfg, "k1", "burnweek-workout-day", { focus: "하체" })).toEqual({ sentPushCount: 1 });
    expect(JSON.parse(lastBody)).toEqual({ templateSetCode: "burnweek-workout-day", context: { focus: "하체" } });
  });

  it("토스가 응답하지 않으면 상한 뒤 연결을 끊고 던진다 (사용률 N4 · codex)", async () => {
    await expect(sendTossPush({ ...cfg, timeoutMs: 200 }, "k1", "hang-template", {})).rejects.toThrow(/TIMEOUT/);
  });

  it("userKey 를 문자열로 돌려준다", async () => {
    expect(await fetchUserKey(cfg, "at-1")).toBe("987654");
  });

  it("전체 흐름이 검증 가능한 세션을 만든다", async () => {
    const { sessionToken, expiresInSec } = await loginWithToss(cfg, "code-abc", "DEFAULT", NOW);
    expect(expiresInSec).toBe(SESSION_TTL_SEC);
    expect(verifySession(sessionToken, SECRET, NOW)).toBe("toss:987654");
  });

  it("인증서 없이 부르면 실패한다 — 성공이 인증서 덕분임을 고정한다", async () => {
    const noCert = { ...cfg, clientCert: undefined, clientKey: undefined };
    await expect(exchangeCode(noCert, "code-abc", "DEFAULT")).rejects.toThrow();
  });

  it("FAIL 응답의 errorCode·reason 을 그대로 올린다 — 디버깅 표면이다", async () => {
    await expect(exchangeCode(cfg, "expired", "DEFAULT")).rejects.toThrow(
      /generate-token: INVALID_PARAMETER — 요청에 실패했습니다\./,
    );
  });

  it("SESSION_SECRET 이 없으면 토스 로그인을 시도조차 하지 않는다", async () => {
    await expect(loginWithToss({ ...cfg, sessionSecret: undefined }, "c", "DEFAULT", NOW)).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe("탈퇴 콜백 Basic 인증", () => {
  const EXPECTED = "burnweek:s3cret";
  const header = (v: string) => `Basic ${Buffer.from(v).toString("base64")}`;

  it("같은 자격증명이면 통과한다", () => {
    expect(basicAuthOk(header(EXPECTED), EXPECTED)).toBe(true);
  });

  it("비밀번호가 다르면 거절한다", () => {
    expect(basicAuthOk(header("burnweek:wrong"), EXPECTED)).toBe(false);
  });

  it("헤더가 없거나 Bearer 면 거절한다 — 길이가 달라도 던지지 않는다", () => {
    expect(basicAuthOk("", EXPECTED)).toBe(false);
    expect(basicAuthOk("Bearer xyz", EXPECTED)).toBe(false);
    expect(basicAuthOk(header(EXPECTED).slice(0, -2), EXPECTED)).toBe(false);
  });

  it("콘솔이 어떤 형태로 보내든 받는다 — 접두사·base64 네 조합", () => {
    const b64 = Buffer.from(EXPECTED).toString("base64");
    expect(basicAuthOk(`Basic ${b64}`, EXPECTED)).toBe(true);
    expect(basicAuthOk(b64, EXPECTED)).toBe(true);
    expect(basicAuthOk(`Basic ${EXPECTED}`, EXPECTED)).toBe(true);
    expect(basicAuthOk(EXPECTED, EXPECTED)).toBe(true);
    // 콘솔이 붙여넣은 base64 를 한 번 더 감싸는 경우(실측).
    const twice = Buffer.from(b64).toString("base64");
    expect(basicAuthOk(twice, EXPECTED)).toBe(true);
    expect(basicAuthOk(`Basic ${twice}`, EXPECTED)).toBe(true);
  });

  it("원문을 모르면 어떤 형태로도 통과하지 못한다", () => {
    expect(basicAuthOk(Buffer.from("burnweek:wrong").toString("base64"), EXPECTED)).toBe(false);
    expect(basicAuthOk("burnweek:wrong", EXPECTED)).toBe(false);
  });
});

describe("탈퇴 콜백 본문 → uid (계약 §2.5.1)", () => {
  it("캡처된 규격을 로그인이 만드는 uid 로 바꾼다", () => {
    // 콘솔 `테스트하기` 가 실제로 보낸 본문(2026-08-24). 숫자 0 도 유효한 타입이다.
    expect(withdrawUid({ userKey: 0, referrer: "UNLINK" })).toBe("toss:0");
    expect(withdrawUid({ userKey: 12345, referrer: "UNLINK" })).toBe("toss:12345");
    expect(withdrawUid({ userKey: "12345", referrer: "UNLINK" })).toBe("toss:12345");
  });

  it("로그인이 발급한 세션의 uid 와 같은 값이다 — 이게 어긋나면 남의 것을 지우거나 아무것도 못 지운다", () => {
    const uid = verifySession(mintSession("toss:12345", SECRET, NOW), SECRET, NOW);
    expect(withdrawUid({ userKey: 12345, referrer: "UNLINK" })).toBe(uid);
  });

  it("모르는 모양이면 null 이다 — 지우지 않는 쪽이 기본값이다", () => {
    expect(withdrawUid({ userKey: 1, referrer: "LOGIN" })).toBeNull();
    expect(withdrawUid({ userKey: 1 })).toBeNull();
    expect(withdrawUid({ referrer: "UNLINK" })).toBeNull();
    expect(withdrawUid({ userKey: "", referrer: "UNLINK" })).toBeNull();
    expect(withdrawUid({ userKey: { id: 1 }, referrer: "UNLINK" })).toBeNull();
    expect(withdrawUid(null)).toBeNull();
    expect(withdrawUid("userKey=1&referrer=UNLINK")).toBeNull();
  });
});
