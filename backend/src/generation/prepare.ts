import { pipelineFor, type AppConfig } from "../config";
import { weekProfile } from "./expand";
import { allowedGeneratedExerciseIds } from "./exercise-policy";
import { buildSkeleton, skeletonIds } from "./slots";
import type { GenerateRequest } from "./types";

/**
 * 생성과 저장 검사가 공유하는 후보 정책. 접수 시각으로 남은 요일을 계산하고,
 * P1은 해당 골격의 후보만, P0는 기존 후보 목록만 허용한다.
 * 원본 요청을 바꾸지 않으므로 저장 직전에도 같은 입력으로 재구성할 수 있다.
 */
export function prepareGeneration(asked: GenerateRequest, pipeline: AppConfig["pipeline"], acceptedAt: number) {
  const request: GenerateRequest = {
    ...asked,
    profile: weekProfile(asked.profile, asked.week_start_date, acceptedAt),
  };
  const skeleton = pipelineFor(pipeline, request.profile.environment) === "p1"
    ? buildSkeleton(request.profile, {
        recent: request.recent_exercise_ids ?? [],
        completed: request.completed_this_week ?? [],
      })
    : undefined;
  const allowedExerciseIds = skeleton
    ? skeletonIds(skeleton)
    : allowedGeneratedExerciseIds(request.profile, request.recent_exercise_ids ?? []);
  return { request, skeleton, allowedExerciseIds };
}
