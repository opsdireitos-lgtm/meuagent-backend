const { supabase, getSetting } = require("../config/supabase");

function extractMessageData(message) {
  const msg = message.message || {};
  const text = msg.conversation || msg.extendedTextMessage?.text || "";
  const imageMsg = msg.imageMessage;
  const imageCaption = imageMsg?.caption || "";
  const imageBase64 = imageMsg?.base64 || message.base64 || null;
  const imageMimetype = imageMsg?.mimetype || "image/jpeg";
  const audioMsg = msg.audioMessage;
  const audioBase64 = audioMsg?.base64 || message.base64 || null;
  const audioMimetype = audioMsg?.mimetype || "audio/ogg";

  let type = "text";
  if (audioMsg) type = "audio";
  else if (imageMsg) type = "image";

  return { type, text, imageCaption, imageBase64, imageMimetype, audioBase64, audioMimetype };
}

async function transcribeAudio(audioBase64, mimetype, apiKey) {
  const ext = mimetype.includes("ogg") ? "ogg" : mimetype.includes("mp4") ? "m4a" : "webm";
  const binaryStr = Buffer.from(audioBase64, "base64");

  const formData = new FormData();
  formData.append("file", new Blob([binaryStr], { type: mimetype }), `audio.${ext}`);
  formData.append("model", "whisper-1");
  formData.append("language", "pt");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    console.error("[AI] Whisper error:", await res.text());
    return "[áudio não reconhecido]";
  }
  const data = await res.json();
  return data.text || "[áudio vazio]";
}

function buildAIMessages(systemPrompt, chatHistory, currentContent, aiModel) {
  const messages = [];

  for (const m of chatHistory.slice(0, -1)) {
    messages.push({ role: m.role, content: m.content });
  }

  if (currentContent.type === "image" && currentContent.imageBase64) {
    const userText = currentContent.imageCaption || currentContent.text || "O que você vê nesta imagem?";

    if (aiModel === "openai-gpt4o") {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:${currentContent.imageMimetype};base64,${currentContent.imageBase64}` } },
        ],
      });
    } else if (aiModel === "anthropic-claude" || aiModel === "anthropic-sonnet") {
      const cleanBase64 = (currentContent.imageBase64 || "").replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
      messages.push({
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: currentContent.imageMimetype || "image/jpeg", data: cleanBase64 } },
          { type: "text", text: userText },
        ],
      });
    } else if (aiModel === "google-gemini") {
      messages.push({
        role: "user",
        content: userText,
        _imageBase64: currentContent.imageBase64,
        _imageMimetype: currentContent.imageMimetype,
      });
    }
  } else if (currentContent.type === "audio" && currentContent.transcribedAudio) {
    messages.push({ role: "user", content: `[Mensagem de áudio transcrita]: "${currentContent.transcribedAudio}"` });
  } else {
    messages.push({ role: "user", content: currentContent.text });
  }

  return messages;
}

async function callAI(key, aiModel, systemPrompt, userMessages, currentContent) {
  if (aiModel === "openai-gpt4o") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }, ...userMessages],
        max_tokens: 500,
        temperature: 0.9,
      }),
    });
    if (res.status === 429) return { response: "", isRateLimited: true, inputTokens: 0, outputTokens: 0 };
    const data = await res.json();
    return {
      response: data.choices?.[0]?.message?.content || "",
      isRateLimited: false,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    };
  } else if (aiModel === "anthropic-claude" || aiModel === "anthropic-sonnet") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: systemPrompt,
        messages: userMessages,
      }),
    });
    if (res.status === 429) return { response: "", isRateLimited: true, inputTokens: 0, outputTokens: 0 };
    const data = await res.json();
    return {
      response: data.content?.[0]?.text || "",
      isRateLimited: false,
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
    };
  } else if (aiModel === "google-gemini") {
    const contents = userMessages.map((m) => {
      const parts = [{ text: m.content || m.text || "" }];
      if (m._imageBase64) {
        parts.unshift({ inline_data: { mime_type: m._imageMimetype, data: m._imageBase64 } });
      }
      return { role: m.role === "assistant" ? "model" : "user", parts };
    });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { maxOutputTokens: 500, temperature: 0.9 },
        }),
      }
    );
    if (res.status === 429) return { response: "", isRateLimited: true, inputTokens: 0, outputTokens: 0 };
    const data = await res.json();
    return {
      response: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
      isRateLimited: false,
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
    };
  }
  return { response: "", isRateLimited: false, inputTokens: 0, outputTokens: 0 };
}

async function getApiKeyForModel(aiModel, agentUserId, agent) {
  let apiKey = "";
  let apiKeyId = null;
  let availableKeys = [];

  if (agent.use_own_api_key && agent.custom_anthropic_key) {
    return { apiKey: agent.custom_anthropic_key, apiKeyId: null, availableKeys: [] };
  }

  const providerMap = {
    "openai-gpt4o": "openai",
    "anthropic-claude": "anthropic",
    "google-gemini": "google-gemini",
    "anthropic-sonnet": "anthropic-sonnet",
  };
  const provider = providerMap[aiModel];
  const nowIso = new Date().toISOString();

  const { data: userSub } = await supabase
    .from("user_subscriptions")
    .select("platform_ai_enabled, ai_monthly_limit_usd")
    .eq("user_id", agentUserId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const platformAiEnabled = userSub?.platform_ai_enabled === true;

  const { data: keys } = await supabase
    .from("api_keys")
    .select("id, api_key, request_count, cooldown_until")
    .eq("provider", provider)
    .eq("is_active", true)
    .or(`cooldown_until.is.null,cooldown_until.lt.${nowIso}`)
    .order("request_count", { ascending: true });

  availableKeys = keys || [];

  if (platformAiEnabled && availableKeys.length > 0) {
    apiKey = availableKeys[0].api_key;
    apiKeyId = availableKeys[0].id;
  } else {
    const legacyKeyMap = {
      "openai-gpt4o": "OPENAI_API_KEY",
      "anthropic-claude": "ANTHROPIC_API_KEY",
      "google-gemini": "GOOGLE_GEMINI_API_KEY",
      "anthropic-sonnet": "ANTHROPIC_SONNET_API_KEY",
    };
    apiKey = await getSetting(legacyKeyMap[aiModel]) || "";
  }

  return { apiKey, apiKeyId, availableKeys, userSub };
}

module.exports = { extractMessageData, transcribeAudio, buildAIMessages, callAI, getApiKeyForModel };
