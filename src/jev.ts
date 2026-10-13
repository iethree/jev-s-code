// Minimal client for the TypeSafe System One HTTP API (https://docs.typesafe.ai/api).

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RETRYABLE = new Set([429, 529]);
const MAX_RETRIES = 3;

export class JevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface LineState {
  language: string;
  line: { number: number; text: string };
  context_before: string[];
  context_after: string[];
}

/** Asks Jev a yes/no question about one line and returns the probability of "yes". */
export async function askAboutLine(
  apiKey: string,
  model: string,
  prompt: string,
  state: LineState,
): Promise<number> {
  const body = JSON.stringify({
    model,
    state,
    questions: {
      verdict: {
        type: "noul",
        instructions: {
          scope:
            "Judge only `line.text`, the line of code that was just written. " +
            "`context_before` and `context_after` are nearby lines, for reference only.",
          question: prompt,
        },
      },
    },
  });

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      const json = (await res.json()) as { answers?: { verdict?: { noul?: number } } };
      const noul = json.answers?.verdict?.noul;
      if (typeof noul !== "number") {
        throw new JevError("Unexpected response from TypeSafe");
      }
      return noul;
    }

    if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
      continue;
    }

    const detail = await res.text().catch(() => "");
    throw new JevError(`TypeSafe returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }
}
