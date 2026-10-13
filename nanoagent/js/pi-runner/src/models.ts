#!/usr/bin/env node

/**
 * The models PI can run, as one JSON document on stdout: every provider (with whether this
 * environment holds its credentials) and every model with its context, output limit, reasoning
 * support and price per million tokens. NanoAgent serves it as GET /v1/models.
 */
import type {Api, Model} from "@earendil-works/pi-ai";
import {builtinModels} from "@earendil-works/pi-ai/providers/all";
import {isMain} from "./index.js";

export async function catalog(): Promise<Record<string, unknown>> {
  const models = builtinModels();
  const available = new Set((await models.getAvailable()).map((model) => model.provider));
  const entry = (model: Model<Api>) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    cost: {input: model.cost.input, output: model.cost.output},
  });
  return {
    providers: models.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      keySet: available.has(provider.id),
    })),
    models: models.getModels().map(entry),
  };
}

if (isMain(import.meta.url)) process.stdout.write(`${JSON.stringify(await catalog())}\n`);
