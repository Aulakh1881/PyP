// Gate 2 (design §0.10, §7.1 step 5): re-parse the model's answer with Zod,
// then run each command's own check() against fresh PayPal data.

import type { ResponseSchema } from "./schema-builder";
import type { AnyCommand, CheckContext, CheckResult, ModelResponse, ProposedAction } from "./types";

export type ParseResult =
  | { ok: true; response: ModelResponse }
  | { ok: false; reason: string };

/** Parse raw model text into a response that matches this run's schema exactly. */
export function parseResponse(text: string, schema: ResponseSchema): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The answer wasn't valid JSON" };
  }
  const parsed = schema.zod.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `The answer didn't match the schema at ${issue.path.join(".") || "(root)"}: ${issue.message}` };
  }
  return { ok: true, response: parsed.data };
}

export interface CheckedAction<F = unknown> {
  action: ProposedAction;
  cmd: AnyCommand<F>;
  check: CheckResult;
}

/** Run every action's check(). A check that throws counts as a failed check, never a pass. */
export async function checkActions<F>(
  actions: ProposedAction[],
  menu: AnyCommand<F>[],
  ctx: CheckContext<F>,
): Promise<CheckedAction<F>[]> {
  return Promise.all(
    actions.map(async (action) => {
      const cmd = menu.find((c) => c.id === action.command);
      if (!cmd) return { action, cmd: menu[0], check: { ok: false, reason: `${action.command} isn't on the menu` } };
      try {
        return { action, cmd, check: await cmd.check(action.params, ctx) };
      } catch (err) {
        return { action, cmd, check: { ok: false, reason: `Check failed: ${(err as Error).message}` } };
      }
    }),
  );
}

export const ok = (): CheckResult => ({ ok: true });
export const fail = (reason: string): CheckResult => ({ ok: false, reason });
