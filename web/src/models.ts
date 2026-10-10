import { useEffect, useState } from 'react';
import { api } from './api';
import type { ConfigResponse } from './types';
import { MODELS, PERPLEXITY_MODELS } from '../../src/models';

/** The models the server runs a task with, as the administration and the LiteLLM proxy have them. */
export interface TaskModels {
  /** Through the LiteLLM proxy, which chooses the models: its host. Null when the administration does. */
  gateway: string | null;
  analysis: string;
  chartRead: string;
}

let memo: Promise<TaskModels | null> | null = null;

/** Asked once a page load: the models are set in the administration or the proxy, not while reading a stock. */
export function taskModels(): Promise<TaskModels | null> {
  return memo ??= api.getConfig()
    .then(({ config, gateway }: ConfigResponse): TaskModels => ({
      gateway: gateway?.host ?? null,
      analysis: gateway?.tasks.analysis ?? config.steps.analysis.model,
      chartRead: gateway?.tasks['chart-read'] ?? config.chartRead.model ?? config.steps.analysis.model,
    }))
    .catch(() => { memo = null; return null; });
}

export function useTaskModels(): TaskModels | null {
  const [m, setM] = useState<TaskModels | null>(null);
  useEffect(() => { void taskModels().then(setM); }, []);
  return m;
}

/** A model's name in the registry, else its id as the proxy or the administration writes it. */
export const modelName = (id: string | null | undefined): string =>
  (id ? MODELS.find((m) => m.id === id)?.label ?? PERPLEXITY_MODELS.find((m) => m.id === id)?.label ?? id : '—');
