export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type CallParams = {
  endpoint: string;
  model: string;
  apiKey: string;
  messages: LlmMessage[];
  temperature?: number;
};

export async function callLLM({ endpoint, model, apiKey, messages, temperature = 0.2 }: CallParams): Promise<string> {
  if (!endpoint) throw new Error("Online compile: endpoint is not configured.");
  if (!model) throw new Error("Online compile: model is not configured.");
  if (!apiKey) throw new Error("Online compile: API key is missing.");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
    }),
  });

  if (!res.ok) {
    const body = await safeReadText(res);
    throw new Error(`Online compile failed (${res.status} ${res.statusText}). ${body}`.trim());
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Online compile failed: empty response content.");
  }

  return content;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? text.slice(0, 400) : "";
  } catch {
    return "";
  }
}
