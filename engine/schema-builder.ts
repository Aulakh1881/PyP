// Turns the filtered menu into the response schema for one run (design §7.4,
// Appendix E.3). One Zod definition does three jobs: the JSON Schema the API
// enforces, the validator's re-parse, and TypeScript types.

import { z, type ZodType } from "zod";
import type { AnyCommand, CaseFile, JSONSchema, ModelResponse } from "./types";

export const MAX_ACTIONS = 3;

export interface ResponseSchema {
  zod: ZodType<ModelResponse>;
  /** The subset the Claude API accepts (limits stripped; Zod checks them). */
  json: JSONSchema;
  /** Everything, limits included, for providers that can enforce them (Ollama). */
  fullJson: JSONSchema;
}

export function buildResponseSchema<F>(menu: AnyCommand<F>[], cf: CaseFile<F>): ResponseSchema {
  const branches = menu.map((cmd) =>
    z.object({
      command: z.literal(cmd.id),
      params: cmd.params(cf),
      why: z.string().max(200).describe("One short sentence, under 200 characters, citing the case-file ids you relied on."),
    }),
  );

  // An empty menu still allows the "nothing to do" answer.
  const action =
    branches.length === 0
      ? z.never()
      : branches.length === 1
        ? branches[0]
        : z.union(branches as unknown as [ZodType, ZodType, ...ZodType[]]);

  const zod = z.object({
    title: z.string().max(80).describe("Card headline for the merchant, under 80 characters."),
    summary: z.string().max(400).describe("What you propose and why, in plain English, under 400 characters."),
    actions: z.array(action).max(MAX_ACTIONS).describe(`At most ${MAX_ACTIONS}. Empty if nothing should happen.`),
    confidence: z.enum(["low", "medium", "high"]),
    questionForMerchant: z.string().max(300).nullable().describe("Usually null. Use merchant.ask for questions with buttons."),
  }) as unknown as ZodType<ModelResponse>;

  return { zod, json: toApiSchema(zod), fullJson: z.toJSONSchema(zod, { io: "output" }) as JSONSchema };
}

// Keywords the Claude API's structured outputs don't accept. Zod still checks
// them in the validator, so dropping them from the wire schema loses nothing.
const UNSUPPORTED = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

/** Zod -> JSON Schema in the subset the Claude API accepts. */
export function toApiSchema(schema: ZodType): JSONSchema {
  return strip(z.toJSONSchema(schema, { io: "output" })) as JSONSchema;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED.has(key)) continue;
    // oneOf isn't supported; anyOf means the same thing for our disjoint branches.
    out[key === "oneOf" ? "anyOf" : key] = strip(value);
  }
  return out;
}
