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

export const routes = {
  createLabels: {
    method: "POST",
    path: "/internal/create-labels",
    input: createLabelsInput,
    output: createLabelsOutput,
  },
  queryLabels: {
    method: "POST",
    path: "/internal/query-labels",
    input: queryLabelsInput,
    output: queryLabelsOutput,
  },
  upsertLabel: {
    method: "POST",
    path: "/internal/upsert-label",
    input: upsertLabelInput,
    output: upsertLabelOutput,
  },
} as const;

export type RouteName = keyof typeof routes;
export type RouteInput<K extends RouteName> = z.infer<(typeof routes)[K]["input"]>;
export type RouteOutput<K extends RouteName> = z.infer<(typeof routes)[K]["output"]>;
export type SavedLabel = z.infer<typeof savedLabelSchema>;
export type Subject = z.infer<typeof subjectSchema>;
