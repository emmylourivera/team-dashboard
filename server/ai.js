// AI features: carton panel detection and the print proof check.
// The page sends a prompt plus images and expects a JSON answer back.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

export const MAX_IMAGES = 4;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function aiLimits() {
  return client ? { images: { maxCount: MAX_IMAGES } } : null;
}

class AiError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// images: [{ buffer, mimetype }]
// tier: "default" (panel detection) or "complex" (proof check)
export async function sampleJson({ prompt, images, tier, signal }) {
  if (!client) throw new AiError("sampling_disabled", 503);
  const content = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    if (!IMAGE_TYPES.has(img.mimetype)) throw new AiError("image_rejected", 400);
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mimetype, data: img.buffer.toString("base64") },
    });
  }
  content.push({ type: "text", text: prompt });

  let response;
  try {
    const stream = client.beta.messages.stream(
      {
        model: config.aiModel,
        max_tokens: 32000,
        output_config: { effort: tier === "complex" ? "high" : "medium" },
        // If the model declines, the API retries on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system:
          "You answer with a single JSON value and nothing else: no prose, no code fences.",
        messages: [{ role: "user", content }],
      },
      { signal }
    );
    response = await stream.finalMessage();
  } catch (e) {
    if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) throw new AiError("cancelled", 499);
    if (e instanceof Anthropic.RateLimitError) throw new AiError("rate_limited", 429);
    if (e instanceof Anthropic.BadRequestError) throw new AiError("image_rejected", 400);
    if (e instanceof Anthropic.APIError) throw new AiError("capability_disabled", 502);
    throw e;
  }

  if (response.stop_reason === "refusal") throw new AiError("refused", 422);
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return parseJson(text);
}

function parseJson(text) {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.search(/[[{]/);
    const end = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {}
    }
    throw new AiError("invalid_json", 502);
  }
}
