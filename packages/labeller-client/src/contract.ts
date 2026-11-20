import { z } from "zod";

export const subjectSchema = z.object({
  uri: z.string(),
  cid: z.string().optional(),
});

export const savedLabelSchema = z.object({
  id: z.number(),
  src: z.string(),
  uri: z.string(),
  cid: z.string().optional(),
  val: z.string(),
  neg: z.boolean().optional(),
  cts: z.string(),
  exp: z.string().optional(),
});

export const createLabelsInput = z.object({
  subject: subjectSchema,
  create: z.array(z.string()).optional(),
  negate: z.array(z.string()).optional(),
});
export const createLabelsOutput = z.object({
  labels: z.array(savedLabelSchema),
});

export const queryLabelsInput = z.object({
  uriPatterns: z.array(z.string()),
  sources: z.array(z.string()).optional(),
});
export const queryLabelsOutput = z.object({
  labels: z.array(savedLabelSchema),
});

export const upsertLabelInput = z.object({
  subject: subjectSchema,
  val: z.string(),
  expiresInMs: z.number().int().positive(),
});
export const upsertLabelOutput = z.object({
  labels: z.array(savedLabelSchema),
});

/**
 * Keep at most one label from `group` active on the subject: `val` is applied
 * (as an expiring label, refreshed like upsertLabel) and every other member of
 * the group is negated. `val: null` negates the whole group.
 */
export const setLabelGroupInput = z
  .object({
    subject: subjectSchema,
    group: z.array(z.string()).min(1),
    val: z.string().nullable(),
    expiresInMs: z.number().int().positive(),
  })
  .refine((input) => input.val === null || input.group.includes(input.val), {
    message: "val must be a member of group",
  });
export const setLabelGroupOutput = z.object({
  labels: z.array(savedLabelSchema),
});

export const routes = {
  createLabels: {
    method: "POST",
    path: "/create-labels",
    input: createLabelsInput,
    output: createLabelsOutput,
  },
  queryLabels: {
    method: "POST",
    path: "/query-labels",
    input: queryLabelsInput,
    output: queryLabelsOutput,
  },
  upsertLabel: {
    method: "POST",
    path: "/upsert-label",
    input: upsertLabelInput,
    output: upsertLabelOutput,
  },
  setLabelGroup: {
    method: "POST",
    path: "/set-label-group",
    input: setLabelGroupInput,
    output: setLabelGroupOutput,
  },
} as const;

export type RouteName = keyof typeof routes;
export type RouteInput<K extends RouteName> = z.infer<(typeof routes)[K]["input"]>;
export type RouteOutput<K extends RouteName> = z.infer<(typeof routes)[K]["output"]>;
export type SavedLabel = z.infer<typeof savedLabelSchema>;
export type Subject = z.infer<typeof subjectSchema>;
