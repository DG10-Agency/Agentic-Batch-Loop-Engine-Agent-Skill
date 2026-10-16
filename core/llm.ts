import * as https from 'https';
import * as http from 'http';

export interface LLMConfig {
    /** Override the API Key. Defaults to process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY, etc. */
    apiKey?: string;
    /** Override the Base URL. Defaults to https://api.openai.com/v1 or process.env.LLM_BASE_URL */
    baseURL?: string;
    /** Override the Model. Defaults to 'gpt-4o' or process.env.LLM_MODEL */
    model?: string;
}

export class AgentBridgeError extends Error {
    constructor(public messages: any[]) {
        super('AGENT_BRIDGE_REQUIRED');
        this.name = 'AgentBridgeError';
    }
}

export class LLMClient {
    private apiKey: string;
    private baseURL: string;
    private model: string;

    constructor(config: LLMConfig = {}) {
        // stdlib only: read credentials straight from the environment.
        // No dotenv — zero-dependency claim stays true; callers load .env themselves if needed.

        // Automatically detect environment credentials
        this.apiKey = config.apiKey ||
            process.env.OPENAI_API_KEY ||
            process.env.ANTHROPIC_API_KEY ||
            process.env.GEMINI_API_KEY || '';

        // Default to OpenAI-compatible endpoint (which most integrated environments proxy)
        this.baseURL = config.baseURL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
        this.model = config.model || process.env.LLM_MODEL || 'gpt-4o';
    }

    async generate(prompt: string, systemPrompt?: string): Promise<string> {
        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });

        return this.chat(messages);
    }

    async chat(messages: { role: string; content: string }[], retries = 3): Promise<string> {
        // --- NATIVE AGENT BRIDGE ---
        // If no API key is found, and we are running inside an AI Agent environment,
        // we throw a special error that the LoopEngine catches to mark the item as 'awaiting_agent'.
        if (!this.apiKey) {
            throw new AgentBridgeError(messages);
        }

        const url = new URL(`${this.baseURL}/chat/completions`);

        const body = JSON.stringify({
            model: this.model,
            messages: messages,
            temperature: 0.7
        });

        const options = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiKey}`
            }
        };

        const executeRequest = () => new Promise<string>((resolve, reject) => {
            const req = https.request(url, options, (res: http.IncomingMessage) => {
                let data = '';
                res.on('data', (chunk: Buffer | string) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 429 || (res.statusCode && res.statusCode >= 500)) {
                        reject(new Error(`RATE_LIMIT_OR_SERVER_ERROR:${res.statusCode}`));
                        return;
                    }
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`LLM Error (${res.statusCode}): ${data}`));
                        return;
                    }
                    try {
                        const response = JSON.parse(data);
                        const content = response.choices?.[0]?.message?.content || '';
                        resolve(content);
                    } catch (e) {
                        reject(new Error(`Failed to parse LLM response: ${e}`));
                    }
                });
            });

            req.on('error', (e: Error) => reject(e));
            req.write(body);
            req.end();
        });

        for (let i = 0; i <= retries; i++) {
            try {
                return await executeRequest();
            } catch (err: any) {
                const isRetryable = err.message.includes('RATE_LIMIT_OR_SERVER_ERROR') || err.code === 'ECONNRESET';
                if (isRetryable && i < retries) {
                    const delay = Math.pow(2, i) * 1000; // Exponential backoff: 1s, 2s, 4s
                    console.log(`⚠️ LLM Rate Limit/Error (Attempt ${i + 1}/${retries + 1}). Retrying in ${delay}ms...`);
                    await new Promise(res => setTimeout(res, delay));
                    continue;
                }
                throw err;
            }
        }
        throw new Error('LLM Max Retries Exceeded');
    }
}
