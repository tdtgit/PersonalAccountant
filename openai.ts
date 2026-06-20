import OpenAI from 'openai';
import type { Environment } from './types';

export const createOpenAIClient = (env: Environment) => new OpenAI({
    project: env.OPENAI_PROJECT_ID,
    apiKey: env.OPENAI_API_KEY,

    // Your AI gateway, example:
    // https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
    baseURL: env.AI_API_GATEWAY || "https://api.openai.com/v1",
});
