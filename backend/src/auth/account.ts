import { createHash, randomUUID } from "node:crypto";
import type { Firestore, Transaction } from "firebase-admin/firestore";

export interface Account { uid: string; version: string | null }
export class AccountReset extends Error {
  constructor() { super("ACCOUNT_RESET"); }
}

// 연결 중인 계정의 세대만 보관한다. 연결 해제 시 이 문서도 삭제한다.
// 재연결은 새 무작위 버전을 발급하므로 영구적인 삭제 이력이 필요 없다.
export const accountKey = (uid: string) => createHash("sha256").update(`burnweek-account:v1:${uid}`).digest("hex");
export const accountRef = (db: Firestore, uid: string) => db.collection("account_lifecycle").doc(accountKey(uid));

export async function assertAccount(db: Firestore, account: Account, tx?: Transaction): Promise<void> {
  if (account.version === null) return; // 동결된 Flutter의 Firebase 인증 경로
  const ref = accountRef(db, account.uid);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (snap.data()?.version !== account.version) throw new AccountReset();
}

// 사용자와 무관한 전역 난수. 삭제 중이던 로그인 교환의 완료만 무효화한다.
// 식별자·삭제 시각·이력을 담지 않는다. 다른 사용자의 동시 로그인도 재시도가 필요할 수 있다.
export const loginRevisionRef = (db: Firestore) => db.collection("auth_control").doc("login_revision");
export const readLoginRevision = async (db: Firestore): Promise<string> => (await loginRevisionRef(db).get()).data()?.version ?? "0";
export class LoginInterrupted extends Error {
  constructor() { super("SESSION_REFRESH"); }
}
export function invalidatePendingLogins(db: Firestore, tx: Transaction) {
  tx.set(loginRevisionRef(db), { version: randomUUID() });
}

export async function loginAccount(db: Firestore, uid: string, loginRevision: string) {
  const ref = accountRef(db, uid);
  return db.runTransaction(async (tx) => {
    if (((await tx.get(loginRevisionRef(db))).data()?.version ?? "0") !== loginRevision) throw new LoginInterrupted();
    const snap = await tx.get(ref);
    const version: string = snap.data()?.version ?? randomUUID();
    if (!snap.exists) tx.set(ref, { version });
    return { version, localDataKey: `${accountKey(uid)}:${version}` };
  });
}
