export const MODEL_ROUTES = {
  askAll: "gpt-5.5",
  single: "gpt-5.4",
  singleEscalated: "gpt-5.5",
  summary: "gpt-5-mini",
  router: "gpt-5-mini",
  memory: "gpt-5-mini",
  voiceTranscription: "gpt-4o-mini-transcribe",
  imageRecognition: "gpt-4o-mini"
} as const;

export type TextGenerationModel =
  | typeof MODEL_ROUTES.askAll
  | typeof MODEL_ROUTES.single
  | typeof MODEL_ROUTES.singleEscalated
  | typeof MODEL_ROUTES.summary;

export type RoutedModel = (typeof MODEL_ROUTES)[keyof typeof MODEL_ROUTES];

export function resolveModelOverride(value: string | undefined, fallback: RoutedModel): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}
