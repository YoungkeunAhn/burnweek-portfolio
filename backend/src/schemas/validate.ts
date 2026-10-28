/**
 * JSON Schema (2020-12) validators for the plan contracts.
 * Schemas are the committed source of truth extracted from
 * docs/architecture/02-data-model.md (§B1 DraftPlan, §B2 WeeklyPlan v1,
 * §B3 PerformedSession v1). Re-extract with
 * `python tools/schemas.py docs/architecture/02-data-model.md --dump "<title>"`.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import draftPlanSchema from "./draft-plan.schema.json";
import weeklyPlanSchema from "./weekly-plan.schema.json";
import performedSessionSchema from "./performed-session.schema.json";
import slotDraftSchema from "./slot-draft.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

export const validateDraftPlan: ValidateFunction = ajv.compile(draftPlanSchema);
export const validateWeeklyPlan: ValidateFunction = ajv.compile(weeklyPlanSchema);
export const validatePerformedSession: ValidateFunction = ajv.compile(performedSessionSchema);
export const validateSlotDraft: ValidateFunction = ajv.compile(slotDraftSchema);

export interface SchemaResult {
  ok: boolean;
  /** Human-readable ajv errors, one per line — fed back into the ≤2 repair retries. */
  errors: string[];
}

function runValidator(validate: ValidateFunction, data: unknown): SchemaResult {
  const ok = validate(data) as boolean;
  const errors = ok
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  return { ok, errors };
}

export function checkDraftPlan(data: unknown): SchemaResult {
  return runValidator(validateDraftPlan, data);
}

export function checkWeeklyPlan(data: unknown): SchemaResult {
  return runValidator(validateWeeklyPlan, data);
}

/** P1 슬롯 드래프트(02-data-model §B1a). */
export function checkSlotDraft(data: unknown): SchemaResult {
  return runValidator(validateSlotDraft, data);
}

export function checkPerformedSession(data: unknown): SchemaResult {
  return runValidator(validatePerformedSession, data);
}
