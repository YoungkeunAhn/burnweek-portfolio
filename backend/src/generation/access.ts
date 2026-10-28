import { randomUUID } from "node:crypto";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { assertAccount, type Account } from "../auth/account";
import type { GenerationJob } from "./types";

export const GENERATION_ACCESS = "generation_access";
const JOBS = "generation_jobs";
export const RESERVATION_MS = 20 * 60_000;
const REWARD_MS = 60 * 60_000;
interface Reservation {
  job_id: string; source: "free" | "reward"; week: string;
  previous_free_week: string | null; expires_at: number;
}
interface Reward { id: string; expires_at: number; claimed: boolean }
interface Access {
  free_week: string | null; credits: number; active: Reservation | null; reward: Reward | null;
}
const empty = (): Access => ({ free_week: null, credits: 0, active: null, reward: null });
export const accessRef = (db: Firestore, uid: string) => db.collection(GENERATION_ACCESS).doc(uid);
/** 구버전에는 광고 화면이 없다. 새 버전 출시 후에만 서버에서 정책을 켠다. */
const rewardsEnabled = () => process.env.TOSS_REWARDED_GENERATION_ENABLED === "true"
  && !!process.env.TOSS_REWARDED_AD_GROUP_ID?.trim();
export class AccessError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

/** 서버 시각만 사용한다. KST는 DST가 없으므로 고정 +09:00이다. */
export function generationWeek(now: number) {
  const d = new Date(now + 9 * 3600_000);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return { week: d.toISOString().slice(0, 10), resets_at: new Date(d.getTime() + 7 * 86400_000 - 9 * 3600_000).toISOString() };
}
function refund(state: Access) {
  const active = state.active;
  if (!active) return;
  if (active.source === "reward") state.credits++;
  else if (state.free_week === active.week) state.free_week = active.previous_free_week;
  state.active = null;
}
function view(state: Access, now: number) {
  const { week, resets_at } = generationWeek(now);
  return {
    free_available: !rewardsEnabled() || state.free_week !== week, reward_credits: state.credits,
    active_job_id: state.active?.job_id ?? null, resets_at,
    ad_group_id: process.env.TOSS_REWARDED_AD_GROUP_ID?.trim() || null,
  };
}

/** All reads, including stale-job reads, precede the returned write closure. */
async function readAccess(db: Firestore, tx: Transaction, uid: string, now: number) {
  const ref = accessRef(db, uid);
  const state = { ...empty(), ...(await tx.get(ref)).data() } as Access;
  let staleJob: string | null = null;
  if (state.active && state.active.expires_at <= now) {
    const job = await tx.get(db.collection(JOBS).doc(state.active.job_id));
    if (job.get("status") === "ok") state.active = null;
    else {
      if (job.exists) staleJob = state.active.job_id;
      refund(state);
    }
  }
  const write = () => {
    if (staleJob) tx.update(db.collection(JOBS).doc(staleJob), {
      status: "error", message: "생성을 완료하지 못했어요. 사용 기회가 복구되어 다시 만들 수 있어요.",
    });
    tx.set(ref, state);
  };
  return { state, write };
}

export function generationAccess(db: Firestore, account: Account, now = Date.now()) {
  return db.runTransaction(async tx => {
    await assertAccount(db, account, tx);
    const { state, write } = await readAccess(db, tx, account.uid, now);
    write();
    return view(state, now);
  });
}

export function startReward(db: Firestore, account: Account, now = Date.now()) {
  return db.runTransaction(async tx => {
    await assertAccount(db, account, tx);
    const { state, write } = await readAccess(db, tx, account.uid, now);
    if (!rewardsEnabled() || state.active || state.credits > 0 || state.free_week !== generationWeek(now).week) {
      write();
      return { ...view(state, now), reward_id: null };
    }
    if (!view(state, now).ad_group_id) throw new AccessError("AD_UNAVAILABLE", "광고를 준비하고 있어요. 잠시 후 다시 시도해 주세요.", 503);
    if (!state.reward || state.reward.claimed || state.reward.expires_at <= now) {
      state.reward = { id: randomUUID(), expires_at: now + REWARD_MS, claimed: false };
    }
    write();
    return { ...view(state, now), reward_id: state.reward.id };
  });
}

/** Authenticated, single-use client callback. This is NOT server-side ad verification (ADR-0013). */
export function claimReward(db: Firestore, account: Account, rewardId: unknown, now = Date.now()) {
  return db.runTransaction(async tx => {
    await assertAccount(db, account, tx);
    const { state, write } = await readAccess(db, tx, account.uid, now);
    if (typeof rewardId !== "string" || state.reward?.id !== rewardId) {
      throw new AccessError("REWARD_INVALID", "광고 시청 정보를 확인할 수 없어요.");
    }
    if (!state.reward.claimed) {
      if (state.reward.expires_at <= now) throw new AccessError("REWARD_EXPIRED", "광고 시청 요청이 만료됐어요. 다시 시도해 주세요.");
      state.credits++;
      state.reward = { ...state.reward, claimed: true };
    }
    write();
    return view(state, now);
  });
}

export function reserveGeneration(db: Firestore, account: Account, job: GenerationJob, now = Date.now()) {
  return db.runTransaction(async tx => {
    await assertAccount(db, account, tx);
    const { state, write } = await readAccess(db, tx, account.uid, now);
    if (state.active) return { jobId: state.active.job_id, created: false };
    const { week } = generationWeek(now);
    const free = !rewardsEnabled() || state.free_week !== week;
    if (!free && state.credits < 1) throw new AccessError("AD_REQUIRED", "이번 주 무료 생성을 사용했어요. 광고를 보면 플랜을 1회 더 만들 수 있어요.");
    state.active = {
      job_id: job.job_id, source: free ? "free" : "reward", week,
      previous_free_week: state.free_week, expires_at: now + RESERVATION_MS,
    };
    if (free) state.free_week = week;
    else state.credits--;
    write();
    tx.set(db.collection(JOBS).doc(job.job_id), { ...job, account_version: account.version, generation_reserved: true });
    return { jobId: job.job_id, created: true };
  });
}

/** Call after account/job reads, before any writes; false means a stale worker must not save. */
export async function settleGeneration(db: Firestore, tx: Transaction, uid: string, jobId: string, success: boolean) {
  const ref = accessRef(db, uid);
  const state = (await tx.get(ref)).data() as Access | undefined;
  if (state?.active?.job_id !== jobId) return false;
  if (success) state.active = null;
  else refund(state);
  tx.set(ref, state);
  return true;
}
