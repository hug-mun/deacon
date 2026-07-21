type ProcessingProgressInput = {
  status: string;
  actualProgress: number | null | undefined;
  startedAt: number;
  now?: number;
};

export function getProcessingProgress({
  status,
  actualProgress,
  startedAt,
  now = Date.now(),
}: ProcessingProgressInput) {
  const actual = Math.max(0, Math.min(100, actualProgress ?? 0));
  if (status !== "processing") return { progress: actual, estimated: false };

  // Keep the card visibly active while the queue/worker has not reported its
  // first real checkpoint. Never let the estimate reach 100%.
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const estimate = Math.min(90, 8 + elapsedSeconds);
  return {
    progress: Math.max(actual, estimate),
    estimated: estimate > actual,
  };
}
